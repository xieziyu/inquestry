/**
 * 报告那一带的公共夹具：一个"什么都有"的案子。
 *
 * **`spike:report` 与 `spike:markdown` 共用这一份**：章节的取舍与它的渲染是同一条链路上
 * 前后两段，两份夹具会慢慢长歪——一边补了字段另一边没补，那边的检查就变成空的，
 * 而"夹具里没有能触发 bug 的数据"正是这一带最难发现的失效方式。
 *
 * 每一项都是为了让某个错法算错：
 * - 投影认定的根因 `st4` **置信度不是最高的**（自己再挑一次会挑到 st1）
 * - 应然/实然**填着**、事故时间线**有两条**（每种形态的「不投影」都因此有东西可以误装）
 * - `e3` 没有时间戳（不进事故时间线：拿时间线当证据总数就会报少）
 * - `e2` 没有锚点、`e3` 的调用**在本案里找不到**（导出的索引要出声，不是留空）
 */

import type { CallNode, IncidentEntry, Snapshot, StepNode } from '../../src/shared/ipc.js';
import type { ReportInput } from '../../src/shared/report.js';

let seq = 0;
export function step(p: Partial<StepNode> & { id: string }): StepNode {
  return {
    ordinal: ++seq,
    sessionId: 'se1',
    sessionIndex: 1,
    parentStepId: null,
    lane: null,
    kind: 'normal',
    status: 'open',
    direction: p.id,
    verdict: `${p.id} 的判定`,
    confidence: null,
    supersededBy: null,
    calls: [],
    evidence: [],
    ...p,
  };
}

export const ev = (
  id: string,
  actor: string | null,
  raw: string | null,
  anchor: string | null = null,
  callId = 'tc1',
) => ({ id, claim: `${id} 说的事`, anchor, occurredAtRaw: raw, actor, callId });

const call = (id: string, toolName: string): CallNode => ({
  id,
  callNumber: 1,
  toolName,
  origin: 'agent',
  status: 'ok',
  input: '{}',
  gate: null,
  outputPreview: '',
  outputLines: 12,
});

export const steps: StepNode[] = [
  step({
    id: 'st1',
    status: 'confirmed',
    confidence: 0.9,
    calls: [call('tc1', 'demo_query')],
    evidence: [ev('e1', 'svc-a', '10:02:11', 'line 42')],
  }),
  step({ id: 'st2', status: 'superseded', supersededBy: 'st4' }),
  step({ id: 'st3', kind: 'impact', status: 'confirmed', confidence: 0.8 }),
  // 投影认定的根因。**置信度不是最高的**——报告若自己再挑一次，挑中的会是 st1
  step({ id: 'st4', status: 'confirmed', confidence: 0.4, evidence: [ev('e2', 'svc-a', '10:04:00')] }),
  // 没标置信度的一环，不该参与"最弱一环"的比较；它的调用故意不在本案里
  step({ id: 'st5', status: 'confirmed', evidence: [ev('e3', 'svc-b', null, null, 'tc9')] }),
  step({ id: 'st6', kind: 'leftover', status: 'inconclusive' }),
];

/** 只有带时间戳的两条。svc-b 那条**不在这里**——归因切分若按它算就会凭空少一组。 */
export const incident: IncidentEntry[] = [
  { evidenceId: 'e1', occurredAtMs: 1, occurredAtRaw: '10:02:11', actor: 'svc-a', claim: 'e1 说的事', stepId: 'st1', stepStatus: 'confirmed', callId: 'tc1', anchor: 'line 42' },
  { evidenceId: 'e2', occurredAtMs: 2, occurredAtRaw: '10:04:00', actor: 'svc-a', claim: 'e2 说的事', stepId: 'st4', stepStatus: 'confirmed', callId: 'tc1', anchor: null },
];

export const ROOT_TEXT = '连接池在扩容时被复用了旧配置';

export const report: Snapshot['report'] = {
  rootCause: { stepId: 'st4', text: ROOT_TEXT, confidence: 0.4 },
  impact: '受影响的是 37 个租户',
  expected: '扩容后每个实例各自建池',
  actual: '扩容后仍共用扩容前那一个',
  leftovers: [{ stepId: 'st6', direction: '重试为什么没兜住', text: '没查清', supersededBy: null }],
  refuted: [{ stepId: 'st2', direction: '是不是上游超时', text: '上游全程正常', supersededBy: 'st4' }],
};

export const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  case: {
    id: 'case_1',
    title: '订单查不到',
    question: '为什么部分租户查不到订单',
    projectRoot: null,
    incidentDate: '2026-08-01',
    tzOffset: '+08:00',
    clues: null,
    agent: { backend: 'claude', model: null, effort: null },
    status: 'closed',
    verdictShape: null,
  },
  shape: 'sequence',
  frozen: true,
  steps,
  incident,
  report,
  ...over,
});
