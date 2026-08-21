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
 * - **兜底步三种形态各来一个**（`st_stray` 主干真实形态 / `st_closed` 老写法造的已关那种 /
 *   `st_lane` 支线）：只有第一个该被折掉。少放一个，"按 kind 一刀切"或"只看 kind + 证据数"
 *   这两种错法就各有一种在所有检查下照样通过
 */

import type { CallNode, IncidentEntry, Metric, Roster, Snapshot, StepNode } from '../../src/shared/ipc.js';
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
const call = (id: string, toolName: string, outputPreview = ''): CallNode => ({
  id,
  callNumber: 1,
  toolName,
  origin: 'agent',
  status: 'done',
  input: '{}',
  gate: null,
  outputPreview,
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
  /**
   * 主干兜底步：真实形态是**永远 open、0 条证据、没有命题也没有结论**——agent 拿不到
   * 它的 stepId，`close_step` 无从调用。报告不列它，工作区把它的调用并进信息卡。
   * 带上调用：滤错的表现之一正是这几次调用连同它一起从两个屏上消失。
   */
  step({
    id: 'st_stray',
    kind: 'unclassified',
    direction: null,
    verdict: null,
    status: 'open',
    calls: [
      // 开场必有的那一发：CLI 延迟加载 MCP 工具，agent 想调 open_step 得先把 schema 取回来，
      // 而 ToolSearch 本身就是一次要记账的调用——物理上不可能先 open_step 再做第一次调用
      call('tc_stray1', 'ToolSearch', 'select:mcp__inquestry__open_step,mcp__inquestry__close_step'),
      call('tc_stray2', 'Read', '~/.claude/projects/.../memory/MEMORY.md（读了一遍上次的排查笔记）'),
    ],
  }),
  /**
   * 老写法造出来的主干兜底步：**已关、带着一句结论、0 条证据**。真实链路上做不到
   * （agent 拿不到它的 stepId），但 `seed-cases` 与任何直接发 `step.closed` 的路径
   * 都不经过那条约束，开发库里这种数据可达。判据只写"主干兜底 + 0 条证据"的话，
   * 它会连同那句结论一起被折掉——而它的结论在两个屏上都再没有出口。
   */
  step({
    id: 'st_closed',
    kind: 'unclassified',
    direction: null,
    status: 'confirmed',
    verdict: '先扫了一遍回调代码，那把幂等锁只留了一条 TODO。',
    calls: [call('tc_closed1', 'Read')],
  }),
  /**
   * 支线兜底步：**同一个 kind，却是另一件东西**——它有证据、在排查路径里挂着脚注。
   * 只按 kind 筛的话它会跟着主干那个一起被筛掉，而页脚水印仍旧写着总条数。
   */
  step({
    id: 'st_lane',
    kind: 'unclassified',
    lane: 'toolu_lane',
    parentStepId: 'st4',
    direction: null,
    status: 'converged',
    verdict: '这条支线到此为止',
    evidence: [ev('e4', 'svc-b', null, null, 'tc1')],
  }),
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

/**
 * 名单（overview.md 的「产出物」）。每一项都是为了让某个错法算错：
 *
 * - **挂在 `st1` 上，而根因是 `st4`**：报告若把名单当成"根因那一步的附属"去取，
 *   出处那一格会印成 `#4`，而正确答案是 `#1`（选择器是 `effectiveRoster`，与根因无关）
 * - `complete: false`：全集那一档的文案在别处单独覆盖。**默认取"下界"这一档**，
 *   因为漏掉这句限定才是有代价的那个方向
 * - 只有第二条带 `note`：备注那一列是"有才开"的，两条都带或都不带都验不到这个分支
 * - id 里带**连续空白与竖线**：它们走的是 `valueCell`（值）而不是 `cell`（散文）。
 *   两者都转义 markdown 元字符，真正的差别是**折不折空白、加不加行首记号**——
 *   用错的表现是导出的名单里 id 被悄悄改了字符，拿去查库查不到，而报告本身看着一切正常
 */
export const ROSTER: Roster = {
  label: '关联账号',
  idKind: 'userId',
  complete: false,
  basis: '按设备指纹做两跳聚合，换过手机的抓不到',
  items: [
    { id: 'u_a  1|x' },
    { id: 'u_b2', note: '被举报本号' },
  ],
};

/**
 * 影响面里的指标。三条各盯一处：
 *
 * - `lower` 那条验界的记号真的印出来了（漏掉它，一个下界会被当成准数拿去汇报）
 * - `exact` 那条验准数**不加**记号（一律加的话记号就不再有区分度）
 * - 口径为空那条验空口径退回破折号，而不是留一格白
 */
export const METRICS: Metric[] = [
  { label: '受影响租户', value: '37', bound: 'lower', basis: '近 30 天，更早的日志已过期' },
  { label: '持续时间', value: '4 小时', bound: 'exact', basis: '从扩容到回滚' },
  { label: '重试放大倍数', value: '3 / 1', bound: 'upper', basis: '' },
];

export const report: Snapshot['report'] = {
  rootCause: { stepId: 'st4', text: ROOT_TEXT, confidence: 0.4 },
  impact: '受影响的是 37 个租户',
  remediation: FIX_TEXT,
  expected: '扩容后每个实例各自建池',
  actual: '扩容后仍共用扩容前那一个',
  leftovers: [{ stepId: 'st6', direction: '重试为什么没兜住', text: '没查清', supersededBy: null }],
  refuted: [{ stepId: 'st2', direction: '是不是上游超时', text: '上游全程正常', supersededBy: 'st4' }],
  roster: { stepId: 'st1', roster: ROSTER },
  metrics: METRICS,
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
