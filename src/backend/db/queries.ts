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

export type ReportSections = {
  rootCause: { step_id: string; verdict_text: string; confidence: number } | undefined;
  impact: { verdict_text: string } | undefined;
  leftovers: { step_id: string; direction: string | null; verdict_text: string }[];
  refuted: { step_id: string; direction: string | null; verdict_text: string; superseded_by: string | null }[];
};

export function reportSections(db: Db, caseId: string): ReportSections {
  const q = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
  const base = `FROM steps s JOIN sessions se ON se.id = s.session_id WHERE se.case_id = ?`;
  return {
    rootCause: q<{ step_id: string; verdict_text: string; confidence: number }>(
      `SELECT s.id AS step_id, s.verdict_text, s.verdict_confidence AS confidence ${base}
         AND s.status='confirmed' AND s.kind='normal' ORDER BY s.verdict_confidence DESC, s.ordinal DESC LIMIT 1`,
      caseId,
    )[0],
    impact: q<{ verdict_text: string }>(
      `SELECT s.verdict_text ${base} AND s.kind='impact' ORDER BY s.ordinal DESC LIMIT 1`,
      caseId,
    )[0],
    leftovers: q(
      `SELECT s.id AS step_id, s.direction, s.verdict_text ${base} AND s.status='inconclusive' ORDER BY s.ordinal`,
      caseId,
    ),
    refuted: q(
      `SELECT s.id AS step_id, s.direction, s.verdict_text, s.superseded_by ${base}
         AND s.status IN ('refuted','superseded') ORDER BY s.ordinal`,
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
