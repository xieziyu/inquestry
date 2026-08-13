/**
 * Inquestry schema。
 *
 * 以 TS 常量而非 .sql 文件承载：打包后 readFileSync 的相对路径必然失效，
 * 而 schema 是启动必需品，这类失败只会在装机后才暴露。
 */

/**
 * 两条连接级设置，**与建表分开**：`journal_mode` 改不进事务里，而迁移那条路要把
 * 建表与 DDL 一起包进一个事务（`database.ts`）。合在一起的话，整条迁移都进不了事务。
 */
export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`;

export const SCHEMA_SQL = `
-- Inquestry schema v1
-- 设计依据见 docs/design/data-model.md；决策来源见 docs/design/overview.md §4。
--
-- 两条铁律：
--   1. \`events\` 是唯一真相，其余表都是它的物化投影，可 truncate 后重放重建
--   2. 大 payload 不进库，只存 sha256 引用；库里存的是可检索文本

-- ─────────────────────────────── 真相层 ───────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     TEXT    NOT NULL,
  session_id  TEXT,
  type        TEXT    NOT NULL,
  payload     TEXT    NOT NULL,          -- JSON
  created_at  INTEGER NOT NULL           -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_events_case ON events(case_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

-- 内容寻址：同一份日志被多个 EvidenceRef 引用时不重复存
CREATE TABLE IF NOT EXISTS blobs (
  sha256      TEXT    PRIMARY KEY,
  size        INTEGER NOT NULL,
  mime        TEXT,
  line_count  INTEGER,                   -- lineRange 锚点需要它做边界校验
  created_at  INTEGER NOT NULL
);

-- ─────────────────────────────── 投影层 ───────────────────────────────

-- 收尾三档（D29）：停止仍是 open，结案 closed，归档 aborted 仍可导出残报告
CREATE TABLE IF NOT EXISTS cases (
  id            TEXT    PRIMARY KEY,
  title         TEXT    NOT NULL,        -- 案件切换栏上的短标签，由问题首行截出
  question      TEXT,                    -- 立案时写的完整问题，新开 session 时用它起头
  status        TEXT    NOT NULL CHECK (status IN ('open','closed','aborted')),
  -- agent 的 cwd。它决定继承哪个项目的 skill / MCP，也决定会话记录落在哪个 ~/.claude/projects 目录
  project_root  TEXT,
  -- 基准日与时区不是"可选线索"：日志时间串多半既无日期也无时区，
  -- 没有它们 occurred_at_ms 落不成绝对时刻，事故时间线就是空的（D11 / D27）。
  -- NOT NULL 是有意的：没有基准的案子不该存在，缺了就该在写入时炸，
  -- 而不是留个空值让下游各自现算一个"今天"
  incident_date TEXT    NOT NULL,
  tz_offset     TEXT    NOT NULL,   -- 立案机器的本机偏移，不由用户填
  clues         TEXT,                  -- 立案时已知的服务 / traceId / 用户 ID，拼进首轮提问
  -- 决定报告装哪几块（D25）。**收尾那一下才写**，在那之前是 NULL：
  -- 排查中途的形态是会变的，定死一个只会让报告按一个过期的判断装。取值见 overview §6.1.1
  verdict_shape TEXT CHECK (verdict_shape IN ('sequence','state','chain','distribution','open')),
  report_md     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- backend / native_session_ref 是 D20 纪律 1：接第二个 backend 时不必迁移历史数据
-- model / effort 落这里而不是 cases（D27）：一个案子跨多会话，中途换模型是常态，
-- 报告里要能标出"这一步是哪个模型跑的"
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT    PRIMARY KEY,
  case_id            TEXT    NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  backend            TEXT    NOT NULL CHECK (backend IN ('claude','codex')),
  native_session_ref TEXT,               -- Claude 的 sessionId / codex 的 threadId
  forked_from        TEXT REFERENCES sessions(id),
  model              TEXT,
  effort             TEXT,               -- backend 不支持时为 NULL，不是给个假值
  status             TEXT    NOT NULL CHECK (status IN ('live','idle','ended','crashed')),
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_case ON sessions(case_id, started_at);

CREATE TABLE IF NOT EXISTS steps (
  id                 TEXT    PRIMARY KEY,
  session_id         TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_step_id     TEXT REFERENCES steps(id),
  lane               TEXT,               -- 子 agent 泳道 key = 起它那次调用的 tool_use_id，主线为 NULL
  ordinal            INTEGER NOT NULL,   -- 会话内序号，排查时间线的稳定排序键
  kind               TEXT    NOT NULL CHECK (kind IN ('normal','unclassified','impact','leftover')),
  direction          TEXT,               -- 可证伪的命题；unclassified 兜底节点为 NULL
  -- 状态型故障（verdict_shape='state'）的报告主体是这一对，不是时间线（D25）
  expected           TEXT,
  actual             TEXT,
  -- agent 在这一步的 close_step 里声明的报告形态。**挂在 step 上而不是直接落 cases**：
  -- 它是某一步的判定内容，这一步被推翻时声明要跟着失效，否则报告会按一份作废的判断装块
  shape              TEXT CHECK (shape IN ('sequence','state','chain','distribution','open')),
  verdict_text       TEXT,
  verdict_confidence REAL CHECK (verdict_confidence BETWEEN 0 AND 1),
  -- \`converged\` 只给子 agent 泳道的兜底步：它没有命题，所以不可能有判定，
  -- 而报告那几栏（根因 / 遗留疑点 / 被推翻）都按具体 status 取，它因此哪一栏都不进。
  -- 借用 \`inconclusive\` 会让每条跑完的支线变成一条「遗留疑点」（queries.ts 只看 status 不看 kind）
  status             TEXT    NOT NULL CHECK (status IN ('open','confirmed','refuted','inconclusive','superseded','converged')),
  superseded_by      TEXT REFERENCES steps(id),
  t_start            INTEGER NOT NULL,
  t_end              INTEGER,
  tokens             INTEGER,
  cost_usd           REAL
);
CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_steps_lane ON steps(session_id, lane, ordinal);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT    PRIMARY KEY,   -- SDK 的 toolUseID，跨事件关联全靠它
  session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_id         TEXT    NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  agent_id        TEXT,                  -- 子 agent 内触发时才有值
  tool_name       TEXT    NOT NULL,
  origin          TEXT    NOT NULL CHECK (origin IN ('agent','operator')),
  input_json      TEXT    NOT NULL,
  input_rewritten INTEGER NOT NULL DEFAULT 0,  -- canUseTool 改过参数；语句要回传给 agent（§5.1①）
  -- 判决 + 谁判的：\`auto\`/\`auto_deny\` 是 backend 那侧（分类器或项目自己的规则）自己定的，
  -- 其余四种都是人在闸门上按的。**分不开的话，读轨道的人会把分类器拒的当成自己拒过**
  -- ——而人现在压根不参与判定（overview §3.5）。细到"是分类器还是规则"看留话
  gate_decision   TEXT CHECK (gate_decision IN ('auto','auto_deny','allow','rewrite','deny','timeout')),
  output_sha256   TEXT REFERENCES blobs(sha256),
  status          TEXT    NOT NULL CHECK (status IN ('pending','done','failed','denied','abandoned')),
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_step ON tool_calls(step_id, started_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_pending ON tool_calls(status) WHERE status = 'pending';

-- occurred_at_ms 是全设计最不能省的字段（D11）：事故时间线 = 对它的一次 ORDER BY
-- occurred_at_raw 必须同存 —— 时区/精度解析出错时，没有原始串就无法回溯纠正
CREATE TABLE IF NOT EXISTS evidence_refs (
  id              TEXT    PRIMARY KEY,
  step_id         TEXT    NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  tool_call_id    TEXT    NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  anchor_kind     TEXT    NOT NULL CHECK (anchor_kind IN ('lines','jsonpath','whole')),
  anchor          TEXT,                  -- agent 给的原始锚点，仅作提示
  anchor_resolved TEXT,                  -- 按内容校正后的锚点；UI 高亮一律用它（blobs.ts locateEvidence）
  claim           TEXT    NOT NULL,
  observed_at     INTEGER NOT NULL,
  occurred_at_ms  INTEGER,
  occurred_at_raw TEXT,
  occurred_source TEXT CHECK (occurred_source IN ('auto','operator','agent')),
  actor           TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_step ON evidence_refs(step_id);
CREATE INDEX IF NOT EXISTS idx_evidence_occurred ON evidence_refs(occurred_at_ms) WHERE occurred_at_ms IS NOT NULL;

-- ─────────────────────────────── 检索层 ───────────────────────────────

-- 两张 FTS 表用不同 tokenizer，因为两类文本的语言分布不同（实测见 data-model.md §5）：
--   unicode61 对中文完全不分词；trigram 可检索中文但查询串须 ≥3 字符，且索引显著更大
CREATE VIRTUAL TABLE IF NOT EXISTS narrative_fts USING fts5(
  ref_id UNINDEXED, ref_kind UNINDEXED, case_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS payload_fts USING fts5(
  sha256 UNINDEXED, case_id UNINDEXED,
  text,
  tokenize = 'unicode61'
);

-- 对话带。**它是投影，不是聊天记录的原始存储**——真相同样在 \`events\` 里（\`chat.appended\`）。
--
-- 落库的理由与别处不同：证据、步骤、判定都重建得出来，而**"人当时怎么纠偏的"重建不出来**。
-- 只存内存的话，关掉 app 就只剩 agent 的结论，看不到那句"别查网关了，先看从库"。
-- 报告不印它（正文只认 step 与证据），但排查过程的完整性靠它。
CREATE TABLE IF NOT EXISTS chat_lines (
  id         TEXT    PRIMARY KEY,
  case_id    TEXT    NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  -- 立完案还没开会话时也会有系统提示，所以可空——不是每一句都属于某一轮会话
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK (role IN ('user','assistant','system')),
  text       TEXT    NOT NULL,
  at         INTEGER NOT NULL
);
-- 不能把 rowid 写进索引定义（SQLite 直接报 no such column），查询里按它兜底排序照旧
CREATE INDEX IF NOT EXISTS idx_chat_case ON chat_lines(case_id, at);

-- ─────────────────────────────── UI 状态 ───────────────────────────────
-- 一律进后端库，不用 renderer localStorage（architecture.md）

CREATE TABLE IF NOT EXISTS ui_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_ui_state (
  case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  value   TEXT NOT NULL     -- JSON：当前视图、展开的 step、泳道折叠
);
`;
