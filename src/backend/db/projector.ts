/**
 * 投影器：events → 物化表。
 *
 * **写路径与重放路径共用这一个函数**——分成两份的那一刻，「可重放」就只是句口号。
 * 因此这里只能读事件载荷和已有投影，不能读时钟、不能生成 id。
 */

import type { Db } from './database.js';
import type { DomainEvent, DomainEvents, EventName } from './events.js';
import { readBlobText } from './blobs.js';
import { parseOccurredAt, type TimeBase } from './timebase.js';

export type ProjectorDeps = {
  /** FTS 需要 blob 正文，而正文不在库里（只存 sha256）——从 blob 目录读回来。 */
  blobDir: string;
  caseId: string;
  /**
   * 这条事件在 `events` 里的 `seq`。**它是唯一一个逐条变的 dep**，摆在这儿是因为
   * 两条路径必须从同一个入口拿到它：写入侧取 `INSERT` 的 `lastInsertRowid`，
   * 重放侧从 `SELECT seq` 读回——两边给出的是同一个数，投影因此重放得出来。
   *
   * 有了它，"这条证据属于哪一批"就不必再问时钟（见 `replaceEvidenceBatch`）。
   */
  seq: number;
};

export function applyEvent(db: Db, ev: DomainEvent, deps: ProjectorDeps): void {
  project(db, ev, deps);
  touchCase(db, deps.caseId, (ev.payload as { at?: number }).at);
}

/**
 * 调查列表靠 `updated_at` 把「进行中的」排在前面（ui.md §8.3），
 * 而新建调查那一刻之后没有别的地方会动它——不在这里前移，排序就永远是新建调查先后。
 *
 * 时间取事件自己的 `at` 而不是时钟：投影器读时钟的那一刻，重放就不再一致。
 * 只前移不后退，重放次序万一有出入也不会把它拽回去。
 */
function touchCase(db: Db, caseId: string, at?: number) {
  if (!at) return;
  db.prepare(`UPDATE cases SET updated_at=? WHERE id=? AND updated_at<?`).run(at, caseId, at);
}

function project(db: Db, ev: DomainEvent, deps: ProjectorDeps): void {
  switch (ev.type) {
    case 'case.opened': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO cases (id,title,question,status,project_root,incident_date,incident_date_source,
                            tz_offset,clues,created_at,updated_at)
         VALUES (?,?,?,'open',?,?,'intake',?,?,?,?)`,
      ).run(
        p.caseId,
        p.title,
        p.question,
        p.projectRoot,
        p.incidentDate,
        p.tzOffset,
        p.clues,
        p.at,
        p.at,
      );
      // 建单信息进检索：找旧调查的心智是"上次那个从库延迟的"，而人记得的多半是自己写的问题，
      // 不是 agent 后来下的结论。**只在这里进一次**——标题就是问题的前 40 字，
      // 两条都索引等于同一段文字在 trigram 表里躺两份，命中一次翻出两条
      insertNarrative(db, deps.caseId, p.caseId, 'case', p.question || p.title);
      return;
    }
    case 'case.status_changed': {
      const p = ev.payload;
      db.prepare(`UPDATE cases SET status=? WHERE id=?`).run(p.status, p.caseId);
      return;
    }
    case 'case.renamed': {
      const p = ev.payload;
      db.prepare(`UPDATE cases SET title=? WHERE id=?`).run(p.title, p.caseId);
      // 检索索引不跟着改：`case.opened` 那一条进的是 question，标题本来就没单独进过表
      return;
    }
    case 'case.timebase_set': {
      const p = ev.payload;
      db.prepare(`UPDATE cases SET incident_date=?, incident_date_source=? WHERE id=?`).run(
        p.incidentDate,
        p.source,
        p.caseId,
      );
      recomputeOccurredAt(db, p.caseId);
      return;
    }
    case 'case.verdict_decided': {
      const p = ev.payload;
      db.prepare(`UPDATE cases SET verdict_shape=? WHERE id=?`).run(p.shape, p.caseId);
      return;
    }
    case 'session.started': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO sessions (id,case_id,backend,native_session_ref,model,effort,status,started_at)
         VALUES (?,?,?,?,?,?,'live',?)`,
      ).run(
        p.sessionId,
        p.caseId,
        p.backend,
        p.nativeSessionRef ?? null,
        p.model ?? null,
        p.effort ?? null,
        p.at,
      );
      return;
    }
    case 'session.ended': {
      const p = ev.payload;
      db.prepare(`UPDATE sessions SET status=?, ended_at=? WHERE id=?`).run(p.status, p.at, p.sessionId);
      return;
    }
    case 'step.opened': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO steps (id,session_id,parent_step_id,lane,ordinal,kind,direction,status,t_start)
         VALUES (?,?,?,?,?,?,?,'open',?)`,
      ).run(p.stepId, p.sessionId, p.parentStepId ?? null, p.lane ?? null, p.ordinal, p.kind, p.direction, p.at);
      if (p.direction) insertNarrative(db, deps.caseId, p.stepId, 'direction', p.direction);
      return;
    }
    case 'step.closed': {
      const p = ev.payload;
      // **同一步会被 close 第二次**——我们自己的 warning 就写着"请补 evidence 后重新 close"。
      // 两类字段在这一下的语义正好相反：
      //
      // - 六个可选字段走 COALESCE（缺省=不动）：那一次多半只补证据，把"没再填"解释成"清空"的话，
      //   第一次填好的形态、应然实然与 remediation 会被静默抹掉，报告主体随之空掉，重放还会一模一样地
      //   复现。要改就再填一次（填了照旧覆盖）。与 `toolcall.gated` 的 `input_json` 同一个语义
      // - `evidence` 是**全量**：带了证据就整份替换上一批（`replaceEvidenceBatch`，边界是
      //   下面落的 `closed_seq`）。当成追加的话，一次重发就在库里躺出两份，
      //   系统时间线把它们并排印出来
      //
      // 绑值仍一律 `?? null`：better-sqlite3 对 undefined 的处理不能指望，而 COALESCE
      // 认的是 NULL——漏了这一手，缺字段的老事件会在重放时报错而不是走保留分支
      replaceEvidenceBatch(db, p.stepId);
      db.prepare(
        `UPDATE steps SET status=?, verdict_text=?, verdict_confidence=?,
                expected=COALESCE(?,expected), actual=COALESCE(?,actual), shape=COALESCE(?,shape),
                remediation=COALESCE(?,remediation),
                roster=COALESCE(?,roster), metrics=COALESCE(?,metrics), t_end=?, closed_seq=?
         WHERE id=?`,
      ).run(
        p.status,
        p.verdict,
        p.confidence,
        p.expected ?? null,
        p.actual ?? null,
        p.shape ?? null,
        p.remediation ?? null,
        // 载荷里已经是归一好的 JSON 串（见 events.ts）：这儿原样落，不解析也不重排
        p.roster ?? null,
        p.metrics ?? null,
        p.at,
        deps.seq,
        p.stepId,
      );
      insertNarrative(db, deps.caseId, p.stepId, 'verdict', p.verdict);
      return;
    }
    case 'lane.converged': {
      const p = ev.payload;
      // **只收还开着的那一步**，这条事件因此是幂等的：同一条应用两次不改口。
      // 照写的话，收口时刻会被后一次往后挪，轨道上一条早就结束的支线显示成刚刚才停。
      // 发事件那侧也各自挡了一道（桥只收一次尾、三个发送口都只挑开着的步），
      // **两道闸各管一段**：那一侧管"别发第二条"，这一侧管"发了也不听"（ui.md §3.2）
      const converged = db
        .prepare(`UPDATE steps SET status='converged', verdict_text=?, t_end=? WHERE id=? AND status='open'`)
        .run(p.summary, p.at, p.stepId);
      // **幂等要连检索索引一起算。** 上面那句可能命中 0 行，而这句照写的话，
      // 同一条事件应用两次就在 `narrative_fts` 里留下两条一模一样（或互相矛盾）的摘要，
      // 跨案检索会把它们都翻出来——步的状态看着没变，索引却已经脏了
      if (converged.changes === 1) {
        // 进检索，但**不是 verdict**：它是支线自己的话，不是对某个命题的结论
        insertNarrative(db, deps.caseId, p.stepId, 'lane', p.summary);
      }
      return;
    }
    case 'step.superseded': {
      const p = ev.payload;
      db.prepare(`UPDATE steps SET status='superseded', superseded_by=? WHERE id=?`).run(p.by, p.stepId);
      return;
    }
    case 'chat.appended': {
      const p = ev.payload;
      db.prepare(
        `INSERT OR IGNORE INTO chat_lines (id,case_id,session_id,role,text,at) VALUES (?,?,?,?,?,?)`,
      ).run(p.lineId, deps.caseId, p.sessionId, p.role, p.text, p.at);
      // 进检索：跨案找"上次那个从库延迟的"时，人自己说过的话往往比结论更好记
      insertNarrative(db, deps.caseId, p.lineId, `chat:${p.role}`, p.text);
      return;
    }
    case 'blob.stored': {
      const p = ev.payload;
      db.prepare(
        `INSERT OR IGNORE INTO blobs (sha256,size,mime,line_count,created_at) VALUES (?,?,?,?,?)`,
      ).run(p.sha256, p.size, p.mime, p.lineCount, p.at);
      const text = readBlobText(deps.blobDir, p.sha256);
      if (text !== null) {
        db.prepare(`INSERT INTO payload_fts (sha256,case_id,text) VALUES (?,?,?)`).run(
          p.sha256,
          deps.caseId,
          text,
        );
      }
      return;
    }
    case 'toolcall.started': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO tool_calls (id,session_id,step_id,agent_id,tool_name,origin,input_json,
                                 input_rewritten,gate_decision,status,started_at)
         VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`,
      ).run(
        p.callId,
        p.sessionId,
        p.stepId,
        p.agentId ?? null,
        p.toolName,
        p.origin,
        p.input,
        p.inputRewritten ? 1 : 0,
        p.gateDecision,
        p.at,
      );
      return;
    }
    case 'toolcall.gated': {
      const p = ev.payload;
      // 只落判决与改写后的参数：被拒的 status 由随后那条 completed 写，
      // 因为留话本身就是 agent 收到的工具结果，两处各写一半会对不上
      db.prepare(
        `UPDATE tool_calls SET gate_decision=?, input_rewritten=?, input_json=COALESCE(?,input_json)
         WHERE id=?`,
      ).run(p.decision, p.decision === 'rewrite' ? 1 : 0, p.input ?? null, p.callId);
      return;
    }
    case 'toolcall.completed': {
      const p = ev.payload;
      db.prepare(`UPDATE tool_calls SET output_sha256=?, status=?, ended_at=? WHERE id=?`).run(
        p.outputSha256,
        p.status,
        p.at,
        p.callId,
      );
      return;
    }
    case 'evidence.attached': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO evidence_refs (id,step_id,tool_call_id,anchor_kind,anchor,anchor_resolved,claim,
                                    observed_at,seq,occurred_at_ms,occurred_at_raw,occurred_source,actor)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        p.evidenceId,
        p.stepId,
        p.callId,
        p.anchorKind,
        p.anchor,
        p.anchorResolved,
        p.claim,
        p.observedAt,
        deps.seq,
        p.occurredAtMs,
        p.occurredAtRaw,
        p.occurredSource,
        p.actor,
      );
      insertNarrative(db, deps.caseId, p.evidenceId, 'evidence', p.claim);
      return;
    }
    default: {
      // 漏接新事件时这里编译期就报，不会等到 UI 上某类节点静默消失
      const never: never = ev;
      throw new Error(`未处理的事件: ${(never as { type: EventName }).type}`);
    }
  }
}

/**
 * 再 close 一次时，把上一批证据整份换掉——`evidence` 是全量，不是增量（契约写在 `tools/schemas.ts`
 * 的 evidence 描述里，写入侧还会当场报「这次替换掉了几条」）。
 *
 * 批次边界是**上一次那条 `step.closed` 的 `events.seq`**（落在 `steps.closed_seq`）：本批的
 * `evidence.attached` 全排在它后面，上一批全排在它前面。`seq` 是事件天生就有的，老事件也不例外，
 * 所以存量重投与新写入认的是同一条规则。
 *
 * 🔴 **不拿时间戳当边界。** 投影器读不得时钟，而 `observed_at` / `t_end` 都是写入那一刻的毫秒数：
 * 两次 close 落进同一毫秒（自动跑批、或重放得快）时两批就分不开了，而那时它不报错，只是安静地
 * 少删或多删一批。
 *
 * 🔴 **「本批到底带没带证据」这个存在性判断不能省。** `evidence` 是必填字段，只补 remediation 的
 * 那次传的是 `[]`（prompt/investigation.md 里明写着这条路），漏了这一手会把那一步的证据整批抹掉。
 */
function replaceEvidenceBatch(db: Db, stepId: string): void {
  const prev =
    (db.prepare(`SELECT closed_seq FROM steps WHERE id=?`).get(stepId) as
      | { closed_seq: number | null }
      | undefined)?.closed_seq ?? null;
  // NULL = 这是第一次 close，没有上一批
  if (prev === null) return;
  const stale = db
    .prepare(`SELECT id FROM evidence_refs WHERE step_id=? AND seq<?`)
    .all(stepId, prev) as { id: string }[];
  if (!stale.length) return;
  if (!db.prepare(`SELECT 1 FROM evidence_refs WHERE step_id=? AND seq>? LIMIT 1`).get(stepId, prev))
    return;
  // 检索索引跟着一起删。漏删是静默的：时间线看着干净了，跨案检索照旧翻得出已被改写掉的旧说法
  const dropNarrative = db.prepare(`DELETE FROM narrative_fts WHERE ref_kind='evidence' AND ref_id=?`);
  for (const s of stale) dropNarrative.run(s.id);
  db.prepare(`DELETE FROM evidence_refs WHERE step_id=? AND seq<?`).run(stepId, prev);
}

/**
 * 换基准之后，把这次调查已落库的 `occurred_at_ms` 由 `occurred_at_raw` 重算一遍。
 * `occurred_at_raw` 一直原样存着就是为了这一下（schema 里存它的理由）。
 *
 * **全表重跑而不是挑行**：带日期的串走的是「只补时区」那一档，新旧基准算出来是同一个 ms，
 * 所以重跑对它们是空操作。挑行反而要在这儿再写一份「哪些算纯时分秒」的判断，
 * 与 `timebase.ts` 里那份分头维护。
 *
 * 落库时用的是当时的基准，这里用的是新基准——两条路都只由 `cases` 上那两列决定，
 * 因此重放到同一个事件位置时结果一致。
 */
function recomputeOccurredAt(db: Db, caseId: string): void {
  const base = db
    .prepare(`SELECT incident_date AS incidentDate, tz_offset AS tzOffset FROM cases WHERE id=?`)
    .get(caseId) as TimeBase | undefined;
  if (!base) return;
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.occurred_at_raw AS raw FROM evidence_refs e
         JOIN steps s ON s.id = e.step_id
         JOIN sessions se ON se.id = s.session_id
        WHERE se.case_id = ? AND e.occurred_at_raw IS NOT NULL`,
    )
    .all(caseId) as { id: string; raw: string }[];
  const put = db.prepare(`UPDATE evidence_refs SET occurred_at_ms=? WHERE id=?`);
  for (const r of rows) put.run(parseOccurredAt(r.raw, base).ms, r.id);
}

function insertNarrative(db: Db, caseId: string, refId: string, kind: string, text: string) {
  db.prepare(`INSERT INTO narrative_fts (ref_id,ref_kind,case_id,text) VALUES (?,?,?,?)`).run(
    refId,
    kind,
    caseId,
    text,
  );
}

/** 子表在前：外键开着时也能按这个顺序删干净。 */
export const PROJECTION_TABLES = [
  'evidence_refs',
  'tool_calls',
  'chat_lines',
  'steps',
  'sessions',
  'cases',
  'blobs',
  'narrative_fts',
  'payload_fts',
];

/**
 * 每种事件"缺了就不能重放"的那几个键。
 *
 * **这张表是迁移的地基**（data-model.md §2）：`better-sqlite3` 把 `undefined` 绑成 NULL，
 * 所以一条形状变过的老事件重放时**不会报错，只会静静落一批 NULL**——看起来像迁移成功，
 * 实际是一批半残的调查。曾经就是这么"跑通"过一次的。
 *
 * 只列必填的：可选字段（`expected` / `shape` / `lane` 这些）缺省本来就有意义，
 * 投影侧走 COALESCE 或显式默认。**加新事件类型时要在这里补一行**，漏了会在重放时报"没见过的事件"。
 */
/** 载荷里**没带 `?` 的那些键**。可以是 null（`direction` 本来就允许），但不能缺。 */
type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];

/**
 * **写成映射类型而不是手写数组**：漏一个键、多一个键、漏一整种事件，都是编译期错误。
 *
 * 手写子集出过一次事：`evidence.attached` 漏了 `anchorKind`，而它落进一个 NOT NULL 列——
 * 体检判它健康，重放才因约束失败抛出来，**正好绕过了"退回挪库"那条兜底**，app 直接起不来。
 * 补全一次不算解决，得让类型系统盯着，否则下一次加字段照样漏。
 */
const REQUIRED_KEYS: { [N in EventName]: { [K in RequiredKeys<DomainEvents[N]>]: true } } = {
  'case.opened': {
    caseId: true,
    title: true,
    question: true,
    projectRoot: true,
    incidentDate: true,
    tzOffset: true,
    clues: true,
    at: true,
  },
  'case.status_changed': { caseId: true, status: true, at: true },
  'case.renamed': { caseId: true, title: true, source: true, at: true },
  'case.timebase_set': { caseId: true, incidentDate: true, source: true, at: true },
  'case.verdict_decided': { caseId: true, shape: true, at: true },
  'session.started': { sessionId: true, caseId: true, backend: true, at: true },
  'session.ended': { sessionId: true, status: true, at: true },
  'step.opened': { stepId: true, sessionId: true, ordinal: true, kind: true, direction: true, at: true },
  'step.closed': { stepId: true, status: true, verdict: true, confidence: true, at: true },
  'step.superseded': { stepId: true, by: true },
  'lane.converged': { stepId: true, lane: true, outcome: true, summary: true, at: true },
  'chat.appended': { lineId: true, sessionId: true, role: true, text: true, at: true },
  'blob.stored': { sha256: true, size: true, mime: true, lineCount: true, at: true },
  'toolcall.started': {
    callId: true,
    sessionId: true,
    stepId: true,
    toolName: true,
    origin: true,
    input: true,
    inputRewritten: true,
    gateDecision: true,
    at: true,
  },
  'toolcall.gated': { callId: true, decision: true, at: true },
  'toolcall.completed': { callId: true, outputSha256: true, status: true, at: true },
  'evidence.attached': {
    evidenceId: true,
    stepId: true,
    callId: true,
    anchorKind: true,
    anchor: true,
    anchorResolved: true,
    claim: true,
    observedAt: true,
    occurredAtMs: true,
    occurredAtRaw: true,
    occurredSource: true,
    actor: true,
  },
};

/** 重放前的体检。**报错停下，好过静默落一批 NULL**——后者与一次成功的迁移长得一模一样。 */
export function checkEventShapes(db: Db): { checked: number } {
  const rows = db.prepare(`SELECT seq,type,payload FROM events ORDER BY seq`).all() as {
    seq: number;
    type: string;
    payload: string;
  }[];
  for (const r of rows) {
    const spec = REQUIRED_KEYS[r.type as EventName] as Record<string, true> | undefined;
    if (!spec) throw new Error(`事件 #${r.seq} 是没见过的类型 ${r.type}：REQUIRED_KEYS 里补一行再重放`);
    const required = Object.keys(spec);
    const payload = JSON.parse(r.payload) as Record<string, unknown>;
    // `null` 算填了（`direction` / `sessionId` 本来就可以是 null），`undefined` 与缺键才是没填
    const missing = required.filter((k) => payload[k] === undefined);
    if (missing.length) {
      throw new Error(
        `事件 #${r.seq}（${r.type}）缺 ${missing.join(' / ')}——载荷形状变过了。` +
          `重放只在形状没变时成立，要跨形状升级得先写 upcaster（data-model.md §2）`,
      );
    }
  }
  return { checked: rows.length };
}

/**
 * 清空投影后按 seq 重放。blob 目录不动，它是真相的另一半。
 *
 * **同一个 schema 版本内**这是正式的迁移手段（改列、改索引、加投影表都靠它）；
 * 跨事件载荷形状的升级不算，那要 upcaster。所以第一件事是体检，不是重放。
 *
 * caseId 取每条事件自己的，不由调用方给——重放是全库的事，用单个 caseId 会把
 * 别的调查的 FTS 行全标成同一个 case，检索时静默串台。
 */
export function rebuildProjections(db: Db, deps: Omit<ProjectorDeps, 'caseId' | 'seq'>): number {
  checkEventShapes(db);
  const rows = db.prepare(`SELECT seq,case_id,type,payload FROM events ORDER BY seq`).all() as {
    seq: number;
    case_id: string;
    type: string;
    payload: string;
  }[];
  /**
   * 🔴 **`case_ui_state` 不是投影，但会被投影的清空**：它对 `cases(id)` 带
   * `ON DELETE CASCADE`，而 `DELETE FROM cases` 一跑就把它整表带走了。
   *
   * 里面装的是**重建不出来的东西**——新建调查时选的 agent（会话还没开，别处没有第二份）、
   * 以及接管模式那个开关。丢了不报错、调查还在，表现是"升级完模型悄悄换回默认、
   * 接管自己关掉了"，与迁移失败长得完全不一样。
   *
   * 先存后放，都在同一个事务里；只放回**重建之后还存在**的那些调查（重放本就该把它们
   * 全部建回来，这一手是防重放漏了某个调查时外键当场炸掉整条迁移）。
   */
  const uiState = db.prepare(`SELECT case_id, value FROM case_ui_state`).all() as {
    case_id: string;
    value: string;
  }[];
  db.transaction(() => {
    for (const t of PROJECTION_TABLES) db.prepare(`DELETE FROM ${t}`).run();
    for (const r of rows) {
      applyEvent(db, { type: r.type, payload: JSON.parse(r.payload) } as DomainEvent, {
        ...deps,
        caseId: r.case_id,
        seq: r.seq,
      });
    }
    const put = db.prepare(
      `INSERT INTO case_ui_state (case_id,value) SELECT ?,? WHERE EXISTS (SELECT 1 FROM cases WHERE id=?)
       ON CONFLICT(case_id) DO UPDATE SET value=excluded.value`,
    );
    for (const u of uiState) put.run(u.case_id, u.value, u.case_id);
  })();
  return rows.length;
}
