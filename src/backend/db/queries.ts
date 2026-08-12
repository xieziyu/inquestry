/**
 * 两条时间线与报告章节的投影查询。
 * 报告的每一栏都对应下面某一条 SQL——agent 只写「修复建议」，其余是投影（D17）。
 */

import type { Db } from './database.js';

export type InvestigationRow = {
  ordinal: number;
  step_id: string;
  kind: string;
  status: string;
  direction: string | null;
  verdict_text: string | null;
  superseded_by: string | null;
  calls: number;
  evidence: number;
};

export type IncidentRow = {
  occurred_at_ms: number;
  occurred_at_raw: string | null;
  actor: string | null;
  claim: string;
  step_id: string;
  step_status: string;
  tool_call_id: string;
  anchor: string | null;
  anchor_resolved: string | null;
  output_sha256: string | null;
};

/** 排查时间线：我按什么顺序做了什么。 */
export function investigationTimeline(db: Db, sessionId: string): InvestigationRow[] {
  return db
    .prepare(
      `SELECT s.ordinal, s.id AS step_id, s.kind, s.status, s.direction, s.verdict_text, s.superseded_by,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.step_id=s.id) AS calls,
              (SELECT COUNT(*) FROM evidence_refs e WHERE e.step_id=s.id) AS evidence
       FROM steps s WHERE s.session_id=? ORDER BY s.ordinal`,
    )
    .all(sessionId) as InvestigationRow[];
}

/**
 * 事故时间线：系统当时到底发生了什么。
 *
 * **不按 step.status 过滤。** 结论可以被推翻，事实不会——被 superseded 的 step
 * 查到的证据照样是真实发生过的事件（data-model.md §3）。step_status 只带出来供 UI 标注。
 */
export function incidentTimeline(db: Db, caseId: string): IncidentRow[] {
  return db
    .prepare(
      `SELECT e.occurred_at_ms, e.occurred_at_raw, e.actor, e.claim, e.step_id,
              st.status AS step_status, e.tool_call_id, e.anchor, e.anchor_resolved, tc.output_sha256
       FROM evidence_refs e
       JOIN steps st ON st.id = e.step_id
       JOIN sessions se ON se.id = st.session_id
       JOIN tool_calls tc ON tc.id = e.tool_call_id
       WHERE se.case_id = ? AND e.occurred_at_ms IS NOT NULL
       ORDER BY e.occurred_at_ms`,
    )
    .all(caseId) as IncidentRow[];
}

export type CaseRow = {
  id: string;
  title: string;
  status: 'open' | 'closed' | 'aborted';
  updated_at: number;
};

const CASE_ORDER = `ORDER BY (status='open') DESC, updated_at DESC`;
const byCaseOrder = (a: CaseRow, b: CaseRow) =>
  Number(b.status === 'open') - Number(a.status === 'open') || b.updated_at - a.updated_at;

/**
 * 案件切换栏的库侧一半（D28）：进行中的排在前面，同档按最近活动倒序。
 * 「跑动中 / 等你 N」是运行时状态，库里没有，由 main 合上去。
 *
 * `pinned` 里的案子**一定在结果里**，哪怕排在 limit 之外。它装的是 main 还持有运行时的那些，
 * 而待办只存在于运行时里：被 limit 截掉的话，那个案子会连同它「等你 N」一起从切换栏
 * 和全局汇总里消失——人看不见，也切不回去处理，正好废掉 D28 要保的东西。
 */
export function caseList(db: Db, opts: { limit?: number; pinned?: string[] } = {}): CaseRow[] {
  const rows = db
    .prepare(`SELECT id, title, status, updated_at FROM cases ${CASE_ORDER} LIMIT ?`)
    .all(opts.limit ?? 20) as CaseRow[];

  const have = new Set(rows.map((r) => r.id));
  const missing = (opts.pinned ?? []).filter((id) => !have.has(id));
  if (!missing.length) return rows;

  const extra = db
    .prepare(
      `SELECT id, title, status, updated_at FROM cases
       WHERE id IN (${missing.map(() => '?').join(',')})`,
    )
    .all(...missing) as CaseRow[];
  return [...rows, ...extra].sort(byCaseOrder);
}

export type ReportSections = {
  /**
   * 根因那一步。**形态声明也从这里取**（`shape`）：形态说的是"这个案子的根因属于哪一类故障"，
   * 它只能由**报告认定的那条根因**说出来。另起一条选择器（比如"全案最新那条带声明的"）的后果是
   * 一条误填了 shape 的 impact step 就能决定报告装哪几块，而根因与应然实然仍来自另一步——
   * 报告的结构与内容自相矛盾，且毫无报错。这与影响面共用 `effectiveStep` 是同一条纪律。
   */
  rootCause:
    | {
        step_id: string;
        verdict_text: string;
        confidence: number;
        expected: string | null;
        actual: string | null;
        shape: string | null;
      }
    | undefined;
  impact: { verdict_text: string } | undefined;
  leftovers: { step_id: string; direction: string | null; verdict_text: string }[];
  refuted: { step_id: string; direction: string | null; verdict_text: string; superseded_by: string | null }[];
};

const STEP_BASE = `FROM steps s JOIN sessions se ON se.id = s.session_id WHERE se.case_id = ?`;
/**
 * **跨会话的顺序不能只看 `ordinal`**：它是会话内序号，一个案子重开一次就从 1 重来。
 * 只按它排的话，旧会话 ordinal=10 的影响面会压过新会话 ordinal=3 的更新结论，
 * 报告静静地展示过期信息。凡是要「最新那条」的章节都得先按会话先后排。
 */
const CHRONO = `se.started_at, se.rowid, s.ordinal`;
const CHRONO_DESC = `se.started_at DESC, se.rowid DESC, s.ordinal DESC`;

export type EffectiveStep = { step_id: string; status: string; verdict_text: string | null };

/**
 * 某一 kind **当前生效**的那一步：排除已被推翻的，取时间上最新的一条。
 *
 * 结案校验与报告章节必须共用这一条规则，否则两边各算各的：
 * 「历史上出现过一个收好的影响面」会放行结案，而报告取的是最新那条——
 * 那可能是 agent 正在重做、还没 close 的空壳，于是影响面栏是空的。
 * 同一族的错还有一种：最新那条已被推翻，报告照样把它印出来。
 */
export function effectiveStep(db: Db, caseId: string, kind: string): EffectiveStep | undefined {
  return db
    .prepare(
      `SELECT s.id AS step_id, s.status, s.verdict_text ${STEP_BASE}
         AND s.kind=? AND s.status<>'superseded'
       ORDER BY ${CHRONO_DESC} LIMIT 1`,
    )
    .get(caseId, kind) as EffectiveStep | undefined;
}

/** 有几条证据落到了事故时间线上 —— 没人声明形态时，它决定时序型装不装得出来。 */
export function timestampedEvidenceCount(db: Db, caseId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) c FROM evidence_refs e
         JOIN steps s ON s.id = e.step_id
         JOIN sessions se ON se.id = s.session_id
         WHERE se.case_id=? AND e.occurred_at_ms IS NOT NULL`,
      )
      .get(caseId) as { c: number }
  ).c;
}

export function reportSections(db: Db, caseId: string): ReportSections {
  const q = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
  const base = STEP_BASE;
  const chrono = CHRONO;
  const chronoDesc = CHRONO_DESC;
  // 影响面取当前生效的那一步，且**必须已经收尾**——还开着的那条 verdict 是空的，
  // 印出来就是一栏空白；而结案校验用的是同一个函数，两边不会各说各话
  const impact = effectiveStep(db, caseId, 'impact');
  return {
    rootCause: q<ReportSections['rootCause'] & object>(
      `SELECT s.id AS step_id, s.verdict_text, s.verdict_confidence AS confidence,
              s.expected, s.actual, s.shape ${base}
         AND s.status='confirmed' AND s.kind='normal'
       ORDER BY s.verdict_confidence DESC, ${chronoDesc} LIMIT 1`,
      caseId,
    )[0],
    impact: impact && impact.status !== 'open' ? { verdict_text: impact.verdict_text ?? '' } : undefined,
    leftovers: q(
      `SELECT s.id AS step_id, s.direction, s.verdict_text ${base}
         AND s.status='inconclusive' ORDER BY ${chrono}`,
      caseId,
    ),
    refuted: q(
      `SELECT s.id AS step_id, s.direction, s.verdict_text, s.superseded_by ${base}
         AND s.status IN ('refuted','superseded') ORDER BY ${chrono}`,
      caseId,
    ),
  };
}

/**
 * 跨 case 检索。中文查询串 <3 字时 trigram 的 MATCH 不成立，回退 LIKE
 * ——trigram 索引本身支持 LIKE，不是全表扫（data-model.md §5）。
 */
export function searchNarrative(db: Db, term: string) {
  const t = term.trim();
  if (t.length >= 3) {
    return db
      .prepare(`SELECT ref_id, ref_kind, case_id, text FROM narrative_fts WHERE narrative_fts MATCH ?`)
      .all(`"${t.replace(/"/g, '')}"`) as { ref_id: string; ref_kind: string; text: string }[];
  }
  return db
    .prepare(`SELECT ref_id, ref_kind, case_id, text FROM narrative_fts WHERE text LIKE ?`)
    .all(`%${t}%`) as { ref_id: string; ref_kind: string; text: string }[];
}
