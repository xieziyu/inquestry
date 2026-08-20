/**
 * 报告那一带的公共夹具：一个"什么都有"的调查。
 *
 * **`spike:report` 与 `spike:markdown` 共用这一份**：章节的取舍与它的渲染是同一条链路上
 * 前后两段，两份夹具会慢慢长歪——一边补了字段另一边没补，那边的检查就变成空的，
 * 而"夹具里没有能触发 bug 的数据"正是这一带最难发现的失效方式。
 *
 * 每一项都是为了让某个错法算错：
 * - 投影认定的根因 `st4` **置信度不是最高的**（自己再挑一次会挑到 st1）
 * - 应然/实然**填着**、系统时间线**刚好两条**、证据分得出两个 actor、已证实的环刚好两条 ——
 *   每一块的门槛都**踩在线上**（overview.md §6.1.1），于是"该装的漏了"与"门槛没过还硬装"
 *   两种错法都算得错，而拿掉任一条就能验到隐藏那一支
 * - `e3` 没有时间戳（不进系统时间线：拿时间线当证据总数就会报少）
 * - `e2` 没有锚点、`e3` 的调用**在本次调查里找不到**（导出的索引要出声，不是留空）
 * - 「下一步怎么查」**非空且带 markdown 元字符**（它恒为「无」时，那一节的检查全是空的）
 */

import type { CallNode, IncidentEntry, Snapshot, StepNode } from '../../src/shared/ipc.js';
import type { ReportInput } from '../../src/shared/report.js';

let seq = 0;
export function step(p: Partial<StepNode> & { id: string }): StepNode {
  return {
    ordinal: ++seq,
    // 轨道织对话用它排位置；夹具里按到达顺序给一串递增值就够
    startedAt: seq * 1000,
    endedAt: null,
    sessionId: 'se1',
    sessionIndex: 1,
    parentStepId: null,
    lane: null,
    kind: 'normal',
    status: 'open',
    direction: p.id,
    verdict: `${p.id} 的结论`,
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

/**
 * 一次已经收回来的调用。**`status` 只能取库里 CHECK 允许的那五个之一**
 * （`pending`/`done`/`failed`/`denied`/`abandoned`）——这儿一度写着 `'ok'`，
 * 它在库里根本落不进去，而按它写的判断在真数据上一条都不成立。
 *
 * 舞台心跳层要的 `pending` 那一档不在这份夹具里：这里装的是一个**已经查完的**调查，
 * 报告投影读的也只是证据。在跑的那几种形态由 `spike:live` 自己造。
 */
const call = (id: string, toolName: string): CallNode => ({
  id,
  callNumber: 1,
  toolName,
  origin: 'agent',
  status: 'done',
  input: '{}',
  gate: null,
  outputPreview: '',
  outputLines: 12,
  startedAt: 1000,
  endedAt: 3000,
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
  // 没标置信度的一环，不该参与"最弱一环"的比较；它的调用故意不在本次调查里
  step({ id: 'st5', status: 'confirmed', evidence: [ev('e3', 'svc-b', null, null, 'tc9')] }),
  step({ id: 'st6', kind: 'leftover', status: 'inconclusive' }),
];

/** 只有带时间戳的两条。svc-b 那条**不在这里**——归因切分若按它算就会凭空少一组。 */
export const incident: IncidentEntry[] = [
  { evidenceId: 'e1', occurredAtMs: 1, occurredAtRaw: '10:02:11', actor: 'svc-a', claim: 'e1 说的事', stepId: 'st1', stepStatus: 'confirmed', callId: 'tc1', anchor: 'line 42' },
  { evidenceId: 'e2', occurredAtMs: 2, occurredAtRaw: '10:04:00', actor: 'svc-a', claim: 'e2 说的事', stepId: 'st4', stepStatus: 'confirmed', callId: 'tc1', anchor: null },
];

export const ROOT_TEXT = '连接池在扩容时被复用了旧配置';
/**
 * 「下一步怎么查」**必须非空**：它是报告里唯一由 agent 生成的一块（只进未决型），
 * 一度恒为「无」，于是"整节留白"这个错法在所有检查下都照旧通过。
 * 带上 markdown 元字符：这一栏与别处一样要过转义那道门。
 */
export const FIX_TEXT = '把 pool_size 从 *继承* 改成按实例算，并给 [扩容流程] 补一条校验';

export const report: Snapshot['report'] = {
  rootCause: { stepId: 'st4', text: ROOT_TEXT, confidence: 0.4 },
  impact: '受影响的是 37 个租户',
  remediation: FIX_TEXT,
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
    incidentDateSource: 'agent',
    tzOffset: '+08:00',
    clues: null,
    agent: { backend: 'claude', model: null, effort: null },
    status: 'closed',
    verdictShape: null,
  },
  shape: 'sequence',
  shapeSource: 'frozen',
  frozen: true,
  steps,
  incident,
  report,
  ...over,
});
