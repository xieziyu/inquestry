/**
 * 从库里投影出 renderer 要的全量快照。
 *
 * v0.1 每次变更推**全量**而不是增量 diff：数据量小，而 diff 的错法（漏推一类节点）
 * 正是 duetlens 上「Discussion 栏静默为空」那种最难发现的 bug。等量级上来再换增量。
 */

import type {
  AgentChoice,
  CaseMeta,
  IncidentEntry,
  ReportStepRef,
  Snapshot,
  StepNode,
} from '../../shared/ipc.js';
import { readBlobHead } from './blobs.js';
import type { Db } from './database.js';
import { reportSections } from './queries.js';
import {
  missingClosingSteps,
  readCaseStatus,
  readIntake,
  readVerdictShape,
  suggestVerdictShape,
} from '../store/sqlite-store.js';

const PREVIEW_LINES = 6;

export function buildSnapshot(
  db: Db,
  ctx: { caseId: string; blobDir: string; agent: AgentChoice },
  extra: Pick<
    Snapshot,
    | 'busy'
    | 'backgroundLanes'
    | 'liveLanes'
    | 'chat'
    | 'pending'
    | 'gates'
    | 'sessionStatus'
    | 'cases'
    | 'lastError'
  >,
): Snapshot {
  const meta = caseMeta(db, ctx.caseId, ctx.agent);

  /**
   * **两条时间线都按 case 取，不按 session 取。**
   * 一个案子跨多会话（overview §4.1），按 session 取的话重开旧案主区就是空的——
   * 排查了三轮的东西看不见，只有事故时间线还在，读起来像是数据丢了。
   */
  const sessionIndex = new Map(
    (
      db
        .prepare(`SELECT id FROM sessions WHERE case_id=? ORDER BY started_at, rowid`)
        .all(ctx.caseId) as { id: string }[]
    ).map((s, i) => [s.id, i + 1]),
  );

  const steps = db
    .prepare(
      `SELECT s.id, s.session_id, s.parent_step_id, s.lane, s.ordinal, s.kind, s.status, s.direction,
              s.verdict_text, s.verdict_confidence, s.superseded_by
       FROM steps s JOIN sessions se ON se.id = s.session_id
       WHERE se.case_id=? ORDER BY se.started_at, se.rowid, s.ordinal`,
    )
    .all(ctx.caseId) as {
    id: string;
    session_id: string;
    parent_step_id: string | null;
    lane: string | null;
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
      `SELECT tc.id, tc.step_id, tc.tool_name, tc.origin, tc.status, tc.input_json, tc.gate_decision,
              tc.output_sha256, b.line_count
       FROM tool_calls tc
       JOIN sessions se ON se.id = tc.session_id
       LEFT JOIN blobs b ON b.sha256 = tc.output_sha256
       WHERE se.case_id=? ORDER BY tc.started_at, tc.rowid`,
    )
    .all(ctx.caseId) as {
    id: string;
    step_id: string;
    tool_name: string;
    origin: 'agent' | 'operator';
    status: string;
    input_json: string;
    gate_decision: string | null;
    output_sha256: string | null;
    line_count: number | null;
  }[];

  const evidence = db
    .prepare(
      `SELECT e.id, e.step_id, e.tool_call_id, e.claim, e.anchor_resolved, e.anchor,
              e.occurred_at_raw, e.actor
       FROM evidence_refs e
       JOIN steps s ON s.id = e.step_id
       JOIN sessions se ON se.id = s.session_id
       WHERE se.case_id=? ORDER BY e.rowid`,
    )
    .all(ctx.caseId) as {
    id: string;
    step_id: string;
    tool_call_id: string;
    claim: string;
    anchor_resolved: string | null;
    anchor: string | null;
    occurred_at_raw: string | null;
    actor: string | null;
  }[];

  // 按 step 先分好组再映射。按 case 取之后这两份是整个案子的历史，
  // 每一步再各扫一遍就是 O(steps × (calls + evidence))——而快照每 60ms 就重建一次，
  // 跨多轮会话的长案子会把 main 卡住。分组保持原查询的顺序，`callNumber` 因此不变
  const callsByStep = groupBy(calls, (c) => c.step_id);
  const evidenceByStep = groupBy(evidence, (e) => e.step_id);

  const stepNodes: StepNode[] = steps.map((s) => ({
    id: s.id,
    ordinal: s.ordinal,
    sessionId: s.session_id,
    sessionIndex: sessionIndex.get(s.session_id) ?? 1,
    parentStepId: s.parent_step_id,
    lane: s.lane,
    kind: s.kind,
    status: s.status,
    direction: s.direction,
    verdict: s.verdict_text,
    confidence: s.verdict_confidence,
    supersededBy: s.superseded_by,
    calls: (callsByStep.get(s.id) ?? []).map((c, i) => ({
      id: c.id,
      callNumber: i + 1,
      toolName: c.tool_name,
      origin: c.origin,
      status: c.status,
      input: c.input_json,
      gate: c.gate_decision,
      outputPreview: preview(ctx.blobDir, c.output_sha256),
      outputLines: c.line_count ?? 0,
    })),
    evidence: (evidenceByStep.get(s.id) ?? []).map((e) => ({
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
      `SELECT e.id, e.occurred_at_ms, e.occurred_at_raw, e.actor, e.claim, e.step_id,
              st.status AS step_status, e.tool_call_id, COALESCE(e.anchor_resolved, e.anchor) AS anchor
       FROM evidence_refs e
       JOIN steps st ON st.id = e.step_id
       JOIN sessions se ON se.id = st.session_id
       WHERE se.case_id=? AND e.occurred_at_ms IS NOT NULL
       ORDER BY e.occurred_at_ms`,
    )
    .all(ctx.caseId) as {
    id: string;
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
    closingGaps: missingClosingSteps(db, ctx.caseId),
    shapeSuggestion: suggestVerdictShape(db, ctx.caseId),
    incident: incident.map(
      (r): IncidentEntry => ({
        evidenceId: r.id,
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
      // 根因**连它的 id 一起带**：报告屏按形态组装章节时要认出"链条末端是哪一环"，
      // 而挑根因的选择器只此一条（queries.reportSections）——renderer 再挑一次的话，
      // 报告的结构与内容会指着两条不同的根因，且毫无报错
      rootCause: rep.rootCause
        ? {
            stepId: rep.rootCause.step_id,
            text: rep.rootCause.verdict_text,
            confidence: rep.rootCause.confidence,
          }
        : null,
      impact: rep.impact?.verdict_text ?? null,
      // 应然实然跟着根因那一步走：根因换人了，这对也跟着换，不会留下一段没有出处的对照
      // 纯空白按没有算，否则报告里那一栏是视觉上的空白，而不是"没有这一栏"
      expected: rep.rootCause?.expected?.trim() || null,
      actual: rep.rootCause?.actual?.trim() || null,
      leftovers: rep.leftovers.map(stepRef),
      refuted: rep.refuted.map(stepRef),
    },
  };
}

/**
 * agent 三项由 runner 给，不从 sessions 表读：会话要到真的开跑时才建，
 * 而立完案还没开跑时顶栏也得显示"待会儿用哪个模型"。
 */
function caseMeta(db: Db, caseId: string, agent: AgentChoice): CaseMeta | null {
  const intake = readIntake(db, caseId);
  return (
    intake && {
      id: caseId,
      ...intake,
      agent,
      status: readCaseStatus(db, caseId) ?? 'open',
      verdictShape: readVerdictShape(db, caseId),
    }
  );
}

/** 报告的遗留疑点与排除矩阵只用到这几项；`superseded_by` 只有排除矩阵那份有。 */
function stepRef(r: {
  step_id: string;
  direction: string | null;
  verdict_text: string;
  superseded_by?: string | null;
}): ReportStepRef {
  return {
    stepId: r.step_id,
    direction: r.direction,
    text: r.verdict_text,
    supersededBy: r.superseded_by ?? null,
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * preview 缓存。**blob 是内容寻址的，同一个 sha256 的内容永不改变**，所以缓存不会过期。
 *
 * 没有它的话，按 case 取历史之后每次快照都要把整个案子每一次调用的原始输出重读一遍，
 * 而快照最快 60ms 一轮——长案子会把 main 线程钉在同步 I/O 上。
 */
const previewCache = new Map<string, string>();
const PREVIEW_CACHE_MAX = 2000;
/** 6 行 preview 够用了；留足余量，超长单行由下面再截。 */
const PREVIEW_HEAD_BYTES = 64 * 1024;

/** 原始输出不进 IPC（architecture.md）：只给前几行，展开时再按需拉。 */
function preview(dir: string, sha256: string | null): string {
  if (!sha256) return '';
  const cached = previewCache.get(sha256);
  if (cached !== undefined) return cached;

  // 整份读进来再切掉 99% 是这条路上最贵的一步：只读开头够凑出前几行的那点
  const text = readBlobHead(dir, sha256, PREVIEW_HEAD_BYTES);
  const out =
    text === null
      ? ''
      : text
          .split('\n')
          .slice(0, PREVIEW_LINES)
          .map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l))
          .join('\n');

  // 读不到就不缓存：blob 可能只是还没落盘，下一轮快照该再试一次
  if (text !== null) {
    if (previewCache.size >= PREVIEW_CACHE_MAX) {
      previewCache.delete(previewCache.keys().next().value!);
    }
    previewCache.set(sha256, out);
  }
  return out;
}
