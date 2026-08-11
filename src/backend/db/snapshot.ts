/**
 * 从库里投影出 renderer 要的全量快照。
 *
 * v0.1 每次变更推**全量**而不是增量 diff：数据量小，而 diff 的错法（漏推一类节点）
 * 正是 duetlens 上「Discussion 栏静默为空」那种最难发现的 bug。等量级上来再换增量。
 */

import type { AgentChoice, CaseMeta, IncidentEntry, Snapshot, StepNode } from '../../shared/ipc.js';
import { readBlobText } from './blobs.js';
import type { Db } from './database.js';
import { reportSections } from './queries.js';
import { readIntake } from '../store/sqlite-store.js';

const PREVIEW_LINES = 6;

export function buildSnapshot(
  db: Db,
  ctx: { caseId: string; sessionId: string; blobDir: string; agent: AgentChoice },
  extra: Pick<Snapshot, 'busy' | 'chat' | 'pending' | 'sessionStatus'>,
): Snapshot {
  const meta = caseMeta(db, ctx.caseId, ctx.agent);

  const steps = db
    .prepare(
      `SELECT id, ordinal, kind, status, direction, verdict_text, verdict_confidence, superseded_by
       FROM steps WHERE session_id=? ORDER BY ordinal`,
    )
    .all(ctx.sessionId) as {
    id: string;
    ordinal: number;
    kind: StepNode['kind'];
    status: StepNode['status'];
    direction: string | null;
    verdict_text: string | null;
    verdict_confidence: number | null;
    superseded_by: string | null;
  }[];

  const calls = db
    .prepare(
      `SELECT tc.id, tc.step_id, tc.tool_name, tc.origin, tc.status, tc.input_json,
              tc.output_sha256, b.line_count
       FROM tool_calls tc LEFT JOIN blobs b ON b.sha256 = tc.output_sha256
       WHERE tc.session_id=? ORDER BY tc.started_at, tc.rowid`,
    )
    .all(ctx.sessionId) as {
    id: string;
    step_id: string;
    tool_name: string;
    origin: 'agent' | 'operator';
    status: string;
    input_json: string;
    output_sha256: string | null;
    line_count: number | null;
  }[];

  const evidence = db
    .prepare(
      `SELECT e.id, e.step_id, e.tool_call_id, e.claim, e.anchor_resolved, e.anchor,
              e.occurred_at_raw, e.actor
       FROM evidence_refs e JOIN steps s ON s.id = e.step_id
       WHERE s.session_id=? ORDER BY e.rowid`,
    )
    .all(ctx.sessionId) as {
    id: string;
    step_id: string;
    tool_call_id: string;
    claim: string;
    anchor_resolved: string | null;
    anchor: string | null;
    occurred_at_raw: string | null;
    actor: string | null;
  }[];

  const perStepCount = new Map<string, number>();
  const stepNodes: StepNode[] = steps.map((s) => ({
    id: s.id,
    ordinal: s.ordinal,
    kind: s.kind,
    status: s.status,
    direction: s.direction,
    verdict: s.verdict_text,
    confidence: s.verdict_confidence,
    supersededBy: s.superseded_by,
    calls: calls
      .filter((c) => c.step_id === s.id)
      .map((c) => {
        const n = (perStepCount.get(s.id) ?? 0) + 1;
        perStepCount.set(s.id, n);
        return {
          id: c.id,
          callNumber: n,
          toolName: c.tool_name,
          origin: c.origin,
          status: c.status,
          input: c.input_json,
          outputPreview: preview(ctx.blobDir, c.output_sha256),
          outputLines: c.line_count ?? 0,
        };
      }),
    evidence: evidence
      .filter((e) => e.step_id === s.id)
      .map((e) => ({
        id: e.id,
        claim: e.claim,
        anchor: e.anchor_resolved ?? e.anchor,
        occurredAtRaw: e.occurred_at_raw,
        actor: e.actor,
        callId: e.tool_call_id,
      })),
  }));

  const incident = db
    .prepare(
      `SELECT e.occurred_at_ms, e.occurred_at_raw, e.actor, e.claim, e.step_id,
              st.status AS step_status, e.tool_call_id, COALESCE(e.anchor_resolved, e.anchor) AS anchor
       FROM evidence_refs e
       JOIN steps st ON st.id = e.step_id
       JOIN sessions se ON se.id = st.session_id
       WHERE se.case_id=? AND e.occurred_at_ms IS NOT NULL
       ORDER BY e.occurred_at_ms`,
    )
    .all(ctx.caseId) as {
    occurred_at_ms: number;
    occurred_at_raw: string | null;
    actor: string | null;
    claim: string;
    step_id: string;
    step_status: string;
    tool_call_id: string;
    anchor: string | null;
  }[];

  const rep = reportSections(db, ctx.caseId);

  return {
    case: meta,
    ...extra,
    steps: stepNodes,
    incident: incident.map(
      (r): IncidentEntry => ({
        occurredAtMs: r.occurred_at_ms,
        occurredAtRaw: r.occurred_at_raw,
        actor: r.actor,
        claim: r.claim,
        stepId: r.step_id,
        stepStatus: r.step_status,
        callId: r.tool_call_id,
        anchor: r.anchor,
      }),
    ),
    report: {
      rootCause: rep.rootCause?.verdict_text ?? null,
      impact: rep.impact?.verdict_text ?? null,
      leftovers: rep.leftovers.length,
      refuted: rep.refuted.length,
    },
  };
}

/**
 * agent 三项由 runner 给，不从 sessions 表读：会话要到真的开跑时才建，
 * 而立完案还没开跑时顶栏也得显示"待会儿用哪个模型"。
 */
function caseMeta(db: Db, caseId: string, agent: AgentChoice): CaseMeta | null {
  const intake = readIntake(db, caseId);
  return intake && { id: caseId, ...intake, agent };
}

/** 原始输出不进 IPC（architecture.md）：只给前几行，展开时再按需拉。 */
function preview(dir: string, sha256: string | null): string {
  if (!sha256) return '';
  const text = readBlobText(dir, sha256);
  if (text === null) return '';
  return text
    .split('\n')
    .slice(0, PREVIEW_LINES)
    .map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l))
    .join('\n');
}
