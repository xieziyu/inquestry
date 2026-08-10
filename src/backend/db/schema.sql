-- Inquestry schema v1
-- 设计依据见 docs/design/data-model.md；决策来源见 docs/design/overview.md §4。
--
-- 两条铁律：
--   1. `events` 是唯一真相，其余表都是它的物化投影，可 truncate 后重放重建
--   2. 大 payload 不进库，只存 sha256 引用；库里存的是可检索文本

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────── 真相层 ───────────────────────────────

CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     TEXT    NOT NULL,
  session_id  TEXT,
  type        TEXT    NOT NULL,
  payload     TEXT    NOT NULL,          -- JSON
  created_at  INTEGER NOT NULL           -- epoch ms
);
CREATE INDEX idx_events_case ON events(case_id, seq);
CREATE INDEX idx_events_session ON events(session_id, seq);

-- 内容寻址：同一份日志被多个 EvidenceRef 引用时不重复存
CREATE TABLE blobs (
  sha256      TEXT    PRIMARY KEY,
  size        INTEGER NOT NULL,
  mime        TEXT,
  line_count  INTEGER,                   -- lineRange 锚点需要它做边界校验
  created_at  INTEGER NOT NULL
);

-- ─────────────────────────────── 投影层 ───────────────────────────────

CREATE TABLE cases (
  id          TEXT    PRIMARY KEY,
  title       TEXT    NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('open','resolved','abandoned')),
  report_md   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- backend / native_session_ref 是 D20 纪律 1：接第二个 backend 时不必迁移历史数据
CREATE TABLE sessions (
  id                 TEXT    PRIMARY KEY,
  case_id            TEXT    NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  backend            TEXT    NOT NULL CHECK (backend IN ('claude','codex')),
  native_session_ref TEXT,               -- Claude 的 sessionId / codex 的 threadId
  forked_from        TEXT REFERENCES sessions(id),
  model              TEXT,
  status             TEXT    NOT NULL CHECK (status IN ('live','idle','ended','crashed')),
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER
);
CREATE INDEX idx_sessions_case ON sessions(case_id, started_at);

CREATE TABLE steps (
  id                 TEXT    PRIMARY KEY,
  session_id         TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_step_id     TEXT REFERENCES steps(id),
  lane               TEXT,               -- 子 agent 泳道 key = Task 的 tool_use_id，主线为 NULL
  ordinal            INTEGER NOT NULL,   -- 会话内序号，排查时间线的稳定排序键
  kind               TEXT    NOT NULL CHECK (kind IN ('normal','unclassified','impact','leftover')),
  direction          TEXT,               -- 可证伪的命题；unclassified 兜底节点为 NULL
  verdict_text       TEXT,
  verdict_confidence REAL CHECK (verdict_confidence BETWEEN 0 AND 1),
  status             TEXT    NOT NULL CHECK (status IN ('open','confirmed','refuted','inconclusive','superseded')),
  superseded_by      TEXT REFERENCES steps(id),
  t_start            INTEGER NOT NULL,
  t_end              INTEGER,
  tokens             INTEGER,
  cost_usd           REAL
);
CREATE INDEX idx_steps_session ON steps(session_id, ordinal);
CREATE INDEX idx_steps_lane ON steps(session_id, lane, ordinal);

CREATE TABLE tool_calls (
  id              TEXT    PRIMARY KEY,   -- SDK 的 toolUseID，跨事件关联全靠它
  session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_id         TEXT    NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  agent_id        TEXT,                  -- 子 agent 内触发时才有值
  tool_name       TEXT    NOT NULL,
  origin          TEXT    NOT NULL CHECK (origin IN ('agent','operator')),
  input_json      TEXT    NOT NULL,
  input_rewritten INTEGER NOT NULL DEFAULT 0,  -- canUseTool 改过参数；语句要回传给 agent（§5.1①）
  gate_decision   TEXT CHECK (gate_decision IN ('auto','allow','rewrite','deny','timeout')),
  output_sha256   TEXT REFERENCES blobs(sha256),
  status          TEXT    NOT NULL CHECK (status IN ('pending','done','failed','denied','abandoned')),
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);
CREATE INDEX idx_tool_calls_step ON tool_calls(step_id, started_at);
CREATE INDEX idx_tool_calls_pending ON tool_calls(status) WHERE status = 'pending';

-- occurred_at_ms 是全设计最不能省的字段（D11）：事故时间线 = 对它的一次 ORDER BY
-- occurred_at_raw 必须同存 —— 时区/精度解析出错时，没有原始串就无法回溯纠正
CREATE TABLE evidence_refs (
  id              TEXT    PRIMARY KEY,
  step_id         TEXT    NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  tool_call_id    TEXT    NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  anchor_kind     TEXT    NOT NULL CHECK (anchor_kind IN ('lines','jsonpath','whole')),
  anchor          TEXT,                  -- "120-138" 或 "$.hits[3].message"
  claim           TEXT    NOT NULL,
  observed_at     INTEGER NOT NULL,
  occurred_at_ms  INTEGER,
  occurred_at_raw TEXT,
  occurred_source TEXT CHECK (occurred_source IN ('auto','operator','agent')),
  actor           TEXT
);
CREATE INDEX idx_evidence_step ON evidence_refs(step_id);
CREATE INDEX idx_evidence_occurred ON evidence_refs(occurred_at_ms) WHERE occurred_at_ms IS NOT NULL;

-- ─────────────────────────────── 检索层 ───────────────────────────────

-- 两张 FTS 表用不同 tokenizer，因为两类文本的语言分布不同（实测见 data-model.md §5）：
--   unicode61 对中文完全不分词；trigram 可检索中文但查询串须 ≥3 字符，且索引显著更大
CREATE VIRTUAL TABLE narrative_fts USING fts5(
  ref_id UNINDEXED, ref_kind UNINDEXED, case_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

CREATE VIRTUAL TABLE payload_fts USING fts5(
  sha256 UNINDEXED, case_id UNINDEXED,
  text,
  tokenize = 'unicode61'
);

-- ─────────────────────────────── UI 状态 ───────────────────────────────
-- 一律进后端库，不用 renderer localStorage（architecture.md）

CREATE TABLE ui_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE case_ui_state (
  case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  value   TEXT NOT NULL     -- JSON：当前视图、展开的 step、泳道折叠
);
