/**
 * 浏览器预览用的假 `window.inquestry`（ui.md §11）。
 *
 * **只服务视觉自查，不进 Electron 的打包路径**：`electron.vite.config.ts` 的 renderer 入口是
 * `src/renderer/index.html`，那条链路一个字都碰不到这个目录。
 *
 * 报告那几屏的数据直接借 `scripts/fixtures/report-case.ts`——**不另抄一份**：
 * 那份夹具是按"每一项都能让某种错法算错"造的，spike 也验的是它。
 * 预览里另造一份的话，屏幕上看着好好的那一版与检查覆盖的那一版会慢慢变成两个案子。
 */

import type {
  AppInfo,
  CaseBrief,
  CaseListPage,
  CaseListQuery,
  ChatLine,
  InquestryApi,
  IntakeOptions,
  PendingAsk,
  PendingGate,
  Snapshot,
} from '../../shared/ipc.js';
import { EMPTY_SNAPSHOT } from '../../shared/ipc.js';
import type { UpdateStatus } from '../../shared/update.js';
import { DEFAULT_UI_SETTINGS } from '../../shared/settings.js';
import { focusOrAppend, type CaseTabs } from '../../shared/tabs.js';
import { incident, report, steps as rawSteps } from '../../../scripts/fixtures/report-case.js';

const now = Date.now();
const min = 60_000;

/**
 * 那份夹具里的 `startedAt` 是一串固定的小整数（它要给 spike 用，不能读时钟）。
 * 预览这一侧要看的恰恰是**对话织进轨道之后长什么样**，所以在这儿把它挪到最近十几分钟内，
 * 与下面那份 CHAT 咬得上——不挪的话每一句话都会堆在轨道末尾，那一版看不出织没织对。
 */
/**
 * 借来的 spike 夹具满屏是「st1 的结论」这类占位文案——它只为让检查算错，不为给人看。
 * 预览（以及 README 截图）看的是版面与文案本身，所以在预览这一侧把每一步换成与下面
 * CHAT / 支线同一个故事的说法。**只换文案字段**：状态、置信度、证据结构原样保留，
 * 那些才是版面差异的来源，动了它们预览就不再覆盖那些形态。
 */
// 兜底步只换 verdict：`direction` 必须留 null，否则预览上看不到那两句兜底文案
const STORY: Record<string, { direction?: string; verdict: string }> = {
  st1: {
    direction: '先证实两条记录是不是同一个请求写进去的',
    verdict: '两条 order 来自两个 req_id，第一条超时 2140ms——第二条是网关重试写出来的。',
  },
  st2: {
    direction: '是不是重试风暴本身造成的重复',
    verdict: '重试解释了第二个请求的存在，解释不了它为什么能落库。',
  },
  st3: {
    direction: '圈出受影响范围',
    verdict: '12:00–12:10 间同型重复订单共 37 笔，全部伴随网关重试。',
  },
  st4: {
    direction: '幂等键为什么没拦住第二次写入',
    verdict: 'cart_key 上只有普通索引——第二次写入不会被数据库挡住，幂等只剩应用层那一道。',
  },
  st5: {
    direction: '应用层的幂等检查当时为什么也没兜住',
    verdict: '写后读打在从库上，复制延迟 0.34s，幂等检查因此 MISS。',
  },
  st6: {
    direction: '重试为什么没按幂等约定退避',
    verdict: '还没查清。',
  },
  // 支线兜底步：没有命题，方向由主线收敛回来时给
  st_lane: { verdict: '翻了近三个月的同类工单，四张里有三张的根因写的就是「重试 + 无幂等」。' },
};
/** `occurredAtRaw` 是 agent 原样写下的串。**第一条故意是带时区的完整 ISO**：
 *  版面按短时刻排的话，长的那种会从时间列里溢出去压在证据正文上，而夹具里全是短的就看不见。 */
const EV_STORY: Record<string, { claim: string; occurredAtRaw: string | null }> = {
  e1: { claim: 't_order 落下第一条 u1001:cart7 订单', occurredAtRaw: '2026-03-11T12:03:02+08:00' },
  e2: { claim: '同一 cart_key 的第二条写入落库，没有被索引拦下', occurredAtRaw: '12:04:51' },
  e3: { claim: '从库 seconds_behind_master=0.34，幂等检查读到的是旧数据', occurredAtRaw: null },
  e4: { claim: 'TK-20250311 / TK-20250702 / TK-20260204 三张工单的结论都是「网关重试 + 服务端无幂等」', occurredAtRaw: null },
};
const steps = rawSteps.map((s, i) => ({
  ...s,
  startedAt: now - (13 - i) * min,
  ...(STORY[s.id] ?? {}),
  evidence: s.evidence.map((e) => ({ ...e, ...(EV_STORY[e.id] ?? {}) })),
}));

/** 报告与系统时间线两份投影的预览版：同一个故事，来源字段（stepId / 置信度）原样保留。 */
const INCIDENT = incident.map((r) => ({
  ...r,
  claim: EV_STORY[r.evidenceId]?.claim ?? r.claim,
  occurredAtRaw: EV_STORY[r.evidenceId]?.occurredAtRaw ?? r.occurredAtRaw,
}));
const REPORT: Snapshot['report'] = {
  ...report,
  rootCause: report.rootCause && {
    ...report.rootCause,
    text: 'cart_key 缺唯一约束：2026-03 迁移漏建，重试写入不再被数据库挡住',
  },
  impact: '12:00–12:10 间重复订单 37 笔，涉及 29 个用户',
  // 已决型不装「下一步怎么查」（report.ts 按形态砍节），这份夹具的报告是有根因的那种
  remediation: null,
  expected: '唯一索引挡住同 cart_key 的第二次写入',
  actual: '普通索引放行，重试写入直接落库',
  leftovers: [{ stepId: 'st6', direction: '重试为什么没按幂等约定退避', text: '还没查清', supersededBy: null }],
  refuted: [
    {
      stepId: 'st2',
      direction: '是不是重试风暴本身造成的重复',
      text: '重试解释了第二个请求的存在，解释不了它为什么能落库',
      supersededBy: 'st4',
    },
  ],
  // 名单与指标换成与这份夹具同一个故事的真值：这一屏是拿来看版面的，
  // 抽象夹具那两条（带元字符的 id、`3 / 1` 这种值）验的是转义，摆在这儿只会看着像坏数据。
  // 条数给足，好看出一列 id 长起来之后这一节的密度对不对
  roster: {
    stepId: 'st4',
    roster: {
      label: '重复落库的订单',
      idKind: 'orderId',
      complete: false,
      basis: '按 cart_key 在 12:00–12:10 窗口内聚合；窗口外的重复不在此列',
      items: [
        { id: 'ord_8f21c04a', note: '首单' },
        { id: 'ord_8f21c04b', note: '重试写入' },
        { id: 'ord_9012ab77' },
        { id: 'ord_9012ab78' },
        { id: 'ord_a4d3e109' },
        { id: 'ord_a4d3e10a' },
      ],
    },
  },
  metrics: [
    { label: '重复订单', value: '37 笔', bound: 'lower', basis: '仅 12:00–12:10，窗口外未核' },
    { label: '涉及用户', value: '29', bound: 'lower', basis: '同上' },
    { label: '影响时长', value: '10 分钟', bound: 'exact', basis: '从首笔重复到限流生效' },
  ],
};

/**
 * 舞台是画布之后，**列**成了语义轴（主干 / 子 agent 支线 / agent 声明的分叉，见 `track.ts`）。
 * 借来的那份报告夹具全是主干，一列都看不见——所以这儿另接三步，专门把三种列各摆一条出来。
 *
 * **只加在预览这一侧**：报告那几屏读的是 `report` / `incident` 两份投影，与这三步无关；
 * 往共用夹具里加的话，`spike:report` 覆盖的那个案子就和屏幕上这个慢慢变成两回事。
 */
const LANE = 'toolu_01ab9f';
/**
 * 预览这一侧另接的那几步的序号：**从共用夹具的最大 `ordinal` 接着数，不许写死**。
 * 那份夹具随时会加步（它按"每一项都让某种错法算错"长），写死的数会与它撞号——
 * 而同一会话里两个 `#9` 是真数据不可能有的形态：卡上、报告里、"被 #9 推翻"那类引用
 * 会各指一张卡，且哪儿都不报错。`spike:stage` 有一条兜着这个。
 */
let ordSeq = Math.max(...rawSteps.map((s) => s.ordinal));
const nextOrd = () => ++ordSeq;
/** 底带上那个「N 证据」不是 0 才看得出版面；内容在这一层用不到。 */
const ev0 = (id: string) => ({ id, claim: id, anchor: null, occurredAtRaw: null, actor: null, callId: 'lc1' });
steps.push(
  {
    ...rawSteps[0]!,
    id: 'lane1',
    ordinal: nextOrd(),
    startedAt: now - 5 * min,
    // 支线兜底步的真实 kind。写成 `normal` 的话，预览上看不到"徽标按 lane 分派"那一档
    kind: 'unclassified',
    lane: LANE,
    parentStepId: steps[1]!.id,
    direction: null,
    status: 'converged',
    verdict: '近 30 分钟 order-api 共 41 次上游超时，其中 12 次触发了网关重试，全部落在 12:00–12:10。',
    evidence: [],
    calls: [],
  },
  {
    ...rawSteps[0]!,
    id: 'lane2',
    ordinal: nextOrd(),
    startedAt: now - 4 * min,
    kind: 'unclassified',
    lane: LANE,
    parentStepId: steps[1]!.id,
    direction: null,
    status: 'converged',
    verdict: 'wait_count 在 12:04 冲到 233，池子确实被打满过——但它解释的是超时，不是重复写入。',
    evidence: [],
    calls: [],
  },
  {
    ...rawSteps[0]!,
    id: 'fork1',
    ordinal: nextOrd(),
    startedAt: now - 3 * min,
    parentStepId: steps[3]!.id,
    direction: '换个角度：先看这张表的唯一约束是不是从来就没建上过',
    status: 'confirmed',
    verdict: '建表语句里是 KEY `idx_cart_key`，不是 UNIQUE KEY——2026-03 那次迁移漏了这一行。',
    evidence: [],
    // 一条人在回填卡上拒掉的查询。🔴 `gate` 写 `auto` 而不是 `null`：**每次调用都带着判决进库**
    // （没人问到的就是 `auto`），编个 null 的话详情页那一格在预览里显示得出来、真数据上却永远没有
    calls: [
      {
        id: 'tc-declined',
        callNumber: 1,
        toolName: 'mcp__inquestry__ask_operator',
        origin: 'operator' as const,
        status: 'denied',
        gate: 'auto',
        input: JSON.stringify({ engine: 'mysql', statement: 'SELECT * FROM t_order WHERE cart_key=?' }),
        outputPreview: '(人工拒绝) 生产库我也没权限，得找 DBA 开工单',
        outputLines: 1,
        startedAt: now - 2 * min,
        endedAt: now - 2 * min + 9_000,
      },
    ],
  },
);

/**
 * 心跳层的三档各摆一份（卡面底带的「在跑一次调用」与「agent 在想」、支线列头那枚芯片）。
 *
 * 🔴 **`startedAt` 一律从真实时钟起算**，不用夹具里那串固定小整数：这一层给的是
 * `Date.now() - startedAt`，写死的话预览里看到的秒数是个荒唐的大数。
 * ⚠️ 但预览里**只看得到版面**——秒数会走（`clock.ts` 的秒钟在浏览器里照常跑），
 * 而"快照不推它也照走"那件事得在真 app 里验，这儿没有 main 进程。
 */
const liveCall = (id: string, toolName: string, agoMs: number) => ({
  id,
  callNumber: 1,
  toolName,
  origin: 'agent' as const,
  status: 'pending',
  input: '{}',
  gate: null,
  outputPreview: '',
  outputLines: 0,
  startedAt: now - agoMs,
  endedAt: null,
});
const doneCall = (id: string, toolName: string, agoMs: number) => ({
  ...liveCall(id, toolName, agoMs),
  status: 'done',
  endedAt: now - agoMs + 4_000,
});

steps.push(
  // 一次已经跑过 60s 还没回来的调用：秒数后面该缀「未回」，而颜色照旧是灰
  {
    ...rawSteps[0]!,
    id: 'live1',
    ordinal: nextOrd(),
    startedAt: now - 3 * min,
    parentStepId: null,
    direction: '把 12:00–12:10 那一段的重试全量捞出来，看还有没有别的表被写重',
    status: 'open',
    verdict: null,
    evidence: [ev0('le1'), ev0('le2'), ev0('le3')],
    calls: [doneCall('lc1', 'Grep', 4 * min), doneCall('lc2', 'Read', 3 * min), liveCall('lc3', 'Bash', 75_000)],
  },
  // 没有调用在跑、这一轮也没交回来：**主干最后那一步**才有的「agent 在想」
  {
    ...rawSteps[0]!,
    id: 'live2',
    ordinal: nextOrd(),
    startedAt: now - 40_000,
    parentStepId: null,
    direction: '这一轮还在想下一步查什么',
    status: 'open',
    verdict: null,
    evidence: [],
    calls: [doneCall('lc4', 'Grep', 38_000)],
  },
  // 支线上在跑的一步：列头那枚芯片报的是这一条自己的工具名
  {
    ...rawSteps[0]!,
    id: 'lane3',
    ordinal: nextOrd(),
    startedAt: now - 2 * min,
    lane: LANE,
    parentStepId: steps[1]!.id,
    direction: null,
    status: 'open',
    verdict: null,
    evidence: [],
    calls: [liveCall('lc5', 'WebFetch', 22_000)],
  },
);

/**
 * 这份夹具的步骤表。**导出只为让 `spike:stage` 验得到序号**——浏览器这一侧照旧只用
 * `installPreviewApi()`，这个目录本来也不进 Electron 的打包路径。
 */
export const PREVIEW_STEPS = steps;

/**
 * 五行**各占一档节点**（等你 / 运行中 / 待开始 / 已定稿 / 已归档）：少一档就等于那一档的配色没人看过。
 *
 * `current` 一律给 false，由 `view()` 按这会儿切到哪个调查现算——预览里的 `switchCase`
 * 是真会切的（tab 条要在这儿调），写死一个的话切过去之后两处会各说各的。
 *
 * 当前调查**故意不是最近那条**：轨道按时间排，当前是哪一条只由 `.cur` 说。
 * 把它放在第一行的话，"当前被提到最前"与"它本来就在最前"长得一模一样——
 * 所以默认切在 c1 上，而排在它前面的是 c2。
 */
const CASES: CaseBrief[] = [
  { id: 'c2', title: '推送在 12:40 之后整体延迟', status: 'open', updatedAt: now - 2 * min, current: false, todos: 1, running: false, started: true, loaded: true },
  // 这一条要的是「运行中」那颗，所以待办给 0——挂着待办的话它显示的是「等你」那颗
  { id: 'c1', title: '订单提交产生了两条重复记录', status: 'open', updatedAt: now - 8 * min, current: false, todos: 0, running: true, started: true, loaded: true },
  // 点开看过一眼、一轮都没跑过：列表上该是「待开始」，与它点进去底部那句一致
  { id: 'c3', title: '网关偶发 502，只有华东节点', status: 'open', updatedAt: now - 5 * 3600_000, current: false, todos: 0, running: false, started: false, loaded: true },
  { id: 'c4', title: '搜索结果里混进了已下架的节目', status: 'closed', updatedAt: now - 3 * 86400_000, current: false, todos: 0, running: false, started: true, loaded: false },
  { id: 'c5', title: '导出任务卡在 99%', status: 'aborted', updatedAt: now - 9 * 86400_000, current: false, todos: 0, running: false, started: true, loaded: false },
  // 后两条只为把 tab 条填到四五个（`?tabs=5`）：收了尾的调查不占 tab，所以能上 tab 条的
  // 只有 `open` 那几条。标题**故意一长一短**——一排收缩之后省略号出不出得来只有长的那种看得见
  { id: 'c6', title: '账单导出的金额与后台对不上，只在跨月那几天', status: 'open', updatedAt: now - 2 * 3600_000, current: false, todos: 0, running: false, started: true, loaded: true },
  { id: 'c7', title: 'CDN 回源命中率掉到 47%', status: 'open', updatedAt: now - 26 * 3600_000, current: false, todos: 0, running: false, started: true, loaded: false },
];

/**
 * 旁白：**这份夹具是拿来压版面的，不是凑数**（同下面 `ask2` 那条）。下限逐条都有出处，
 * 少哪一条，对应的那种错法在预览里就复现不出来：
 *
 * - **连着五步、每步三句以上**：这样才看得出一组收成一行组头之后主干的节奏，
 *   以及全部展开时它会长成什么样；
 * - **至少一步一句都没有**（`live1`）：没说过话的那一步一个像素都不该多占，
 *   它与下一张卡之间该是干净的 `vGap`；
 * - **至少一句说在支线卡落笔之后**（`ch16`，说在 `lane1` 与 `lane2` 之间）：
 *   归属只认主干卡，认领到支线上的话它会整组挪到 1 列去；
 * - **至少一句两百字以上且带换行**（`ch5`）：短句在画布上根本裁不着，
 *   "被裁了、要开抽屉才读得全"这件事就复现不出来。
 */
const CHAT: ChatLine[] = [
  // 开场白由 main 标出来（每次会话最早那条 user 行），舞台不织它——信息卡上已经逐字有了
  { id: 'ch0', opening: true, role: 'user', at: now - 14 * min, text: '线上反馈：12:03 前后，用户 u1001 只提交了一次订单，系统里却出现了两条重复记录。请排查根因。\n基准日期：2026-08-15（时区 +08:00）。' },
  // 第一步之前的几句归信息卡
  { id: 'ch1', role: 'user', at: now - 13 * min - 20_000, text: '补一句：只有 App 端有这个现象，小程序那边没人报。' },

  // ── st1 ──
  { id: 'ch2', role: 'assistant', at: now - 12 * min - 45_000, text: '先看这两条记录是不是同一个请求写进去的。我去查网关日志里 u1001 那一段。' },
  { id: 'ch3', role: 'assistant', at: now - 12 * min - 30_000, text: '两条 order 落库时间差 1.8s，req_id 不一样——不是前端连点，像是重试。' },
  { id: 'ch4', role: 'user', at: now - 12 * min - 15_000, text: '重试是网关自己发的还是客户端 SDK 发的？这两条追下去不是一回事。' },

  // ── st2 ──
  { id: 'ch5', role: 'assistant', at: now - 11 * min - 45_000, text: '网关侧的记录是这样：第一次 POST /v1/order 打到 order-api 之后等了 2140ms 没等到响应，网关按默认策略重发了一次，第二次 47ms 就回来了。两次的 cart_key 完全相同，req_id 不同。\n\n也就是说重复不是前端连点造成的，而是超时重试打进来的第二个请求——它在业务上和第一次是同一次下单。\n\n接下来要确认的是幂等这条路：下单接口用 cart_key 做幂等，如果 t_order 上 cart_key 只是普通索引而不是唯一索引，那么两次写入在数据库层面都会成功，幂等就只剩应用层那一道，而应用层在并发窗口里很可能读不到对方还没提交的那一行。' },
  { id: 'ch6', role: 'assistant', at: now - 11 * min - 30_000, text: '所以方向改成「幂等键为什么没拦住第二次」，先看建表语句。' },
  { id: 'ch7', role: 'user', at: now - 11 * min - 15_000, text: '上个月有人动过这张表的 DDL，记得一起对一遍。' },

  // ── st3 ──
  { id: 'ch8', role: 'assistant', at: now - 10 * min - 45_000, text: '先把影响面圈出来：同型重复订单按 cart_key 聚合，窗口取 12:00–12:10。' },
  { id: 'ch9', role: 'assistant', at: now - 10 * min - 30_000, text: '37 笔，涉及 29 个用户，全部伴随一次网关重试。' },
  { id: 'ch10', role: 'system', at: now - 10 * min - 15_000, text: '已接管：接下来除只读与杂务外，每次工具调用都要你放行。' },

  // ── st4 ──
  { id: 'ch11', role: 'assistant', at: now - 9 * min - 48_000, text: '建表语句拿到了，cart_key 那一行是 KEY 不是 UNIQUE KEY。' },
  { id: 'ch12', role: 'user', at: now - 9 * min - 36_000, text: '那第二次写入在数据库这一层根本不会被挡。' },
  { id: 'ch13', role: 'assistant', at: now - 9 * min - 24_000, text: '对，所以幂等只剩应用层那一道。下一步看它当时为什么也没兜住。' },
  { id: 'ch14', role: 'assistant', at: now - 9 * min - 12_000, text: '顺手把 2026-03 那次迁移的 DDL 变更记录也拉了，唯一约束确实是那一版漏建的。' },

  // ── st5 ──
  { id: 'ch15', role: 'assistant', at: now - 8 * min - 45_000, text: '应用层的幂等检查是写后读，读的是从库。' },
  { id: 'ch16', role: 'assistant', at: now - 8 * min - 30_000, text: 'seconds_behind_master 当时 0.34s，检查因此 MISS——两次写入都以为自己是第一次。' },
  { id: 'ch17', role: 'user', at: now - 8 * min - 15_000, text: '那这条链路上还有别的接口也这么写吗？留个遗留问题。' },

  // ── st6：这一句说在支线第一步落笔之后，归属仍旧是主干上那一步 ──
  { id: 'ch18', role: 'assistant', at: now - 4 * min - 30_000, text: '子 agent 那条线在捞重试记录，我这边先把重试为什么没退避挂成遗留问题。' },

  // ── live1 一句都没有：没说过话的那一步不该多占一个像素 ──

  // ── live2（正在跑的那一步）：组头行给主色活口记号，计数在涨 ──
  { id: 'ch19', role: 'assistant', at: now - 30_000, text: '再看一眼同机房另外两台的成功率，确认那条链路是不是唯一的差异项。' },
  { id: 'ch20', role: 'user', at: now - 20_000, text: '边看边说，别等全查完再一起讲。' },
];

const PENDING: PendingAsk[] = [
  {
    id: 'ask1',
    engine: 'mysql',
    statement: 'SHOW CREATE TABLE `t_order`;',
    why: '要确认 cart_key 上是唯一索引还是普通索引——这决定第二次写入能不能被数据库自己挡住。',
    expect: '建表语句里 cart_key 那一行的索引类型',
    env: 'prod-读库',
    // 对上夹具里那次调用：舞台靠它把「等你处理」标回那一步（真实数据由 main 认领后带上来）
    callId: 'tc1',
    askedAt: now - 90_000,
  },
  /**
   * 🔴 **第二条是拿来压版面的，不是凑数**：engine 短、env 是 agent 写的一整句话、
   * 语句多行且长。上面那条 `SHOW CREATE TABLE` / `prod-读库` 短得什么都触发不了——
   * 只有这条能看出徽标会不会被挤到换行、语句块封没封住高度。删它等于把这两处的版面回归网撤了。
   */
  {
    id: 'ask2',
    engine: 'mongo',
    statement: [
      'db.userdevices.find(',
      '  { users: ObjectId("6a8579973eea10374dd3179d") },',
      '  { shumeiDeviceId: 1, nativeDeviceIds: 1, users: 1, deviceModel: 1, deviceName: 1, createdAt: 1, riskLevel: 1, selfRiskLevel: 1, status: 1 }',
      ').sort({ createdAt: -1 })',
    ].join('\n'),
    why: '先取被举报账号名下的全部设备文档，看每台设备的 users 数组里除了他还有谁——这是设备指纹关联的第一跳。',
    expect:
      '预期返回 1 到几条设备文档。若每条的 users 长度都为 1（只有他自己），说明设备维度看不到马甲，本方向被推翻，要改走 IP / idfv；若出现 users 长度 >= 3 的设备，那些同设备账号就是第一批嫌疑小号。',
    env: 'prod userProfile 库 (device-mongo service 的 userProfileMongoUrl, 只读从库即可)',
    askedAt: now - 40_000,
  },
];

const GATES: PendingGate[] = [
  {
    id: 'gate1',
    toolName: 'Bash',
    input: JSON.stringify({ command: 'kubectl -n prod logs deploy/order-api --since=30m | grep u1001' }, null, 2),
    reason: '要读生产 pod 的日志',
    askedAt: now - 20_000,
    deadline: now + 100_000,
  },
];

/**
 * 一份"什么都有"的快照：在跑、有待办、有闸门、有支线、报告四栏都装得出来。
 *
 * 空态不靠改这里看——`?empty` 会把它换成 {@link EMPTY_LIKE}，两种都要能一眼切过去。
 */
const FULL: Snapshot = {
  case: {
    id: 'c1',
    title: '订单提交产生了两条重复记录',
    question: '线上反馈：12:03 前后，用户 u1001 只提交了一次订单，系统里却出现了两条重复记录。请排查根因。',
    projectRoot: '/Users/ziyu/Projects/order-api',
    incidentDate: new Date(now).toISOString().slice(0, 10),
    // 故意留在未确认这一档：它是信息卡上唯一会多出一个元素的状态，调版面时要看得见
    incidentDateSource: 'intake',
    tzOffset: '+08:00',
    clues: null,
    agent: { backend: 'claude', model: 'opus[1m]', effort: 'high' },
    status: 'open',
    verdictShape: null,
  },
  cases: CASES,
  sessionStatus: 'live',
  takeover: true,
  lastError: null,
  busy: true,
  // **必须与上面那几步的 sessionId 对得上**：对不上的话心跳层会把每一步都当成上一次会话
  // 留下的旧账，底带与列头芯片一个都不出——而这份夹具正是拿来看它们的
  sessionId: 'se1',
  context: { usedTokens: 63_400, maxTokens: 200_000, percent: 31.7, model: 'claude-opus-5[1m]' },
  backgroundLanes: 1,
  // **与上面那条支线用的是同一个键**：对不上的话「停」与列头芯片一个都不出现，
  // 而它们恰恰是这份夹具要看的东西
  liveLanes: [LANE],
  steps,
  incident: INCIDENT,
  pending: PENDING,
  gates: GATES,
  chat: CHAT,
  closingGaps: ['impact'],
  shapeSuggestion: { shape: 'chain', source: 'agent', rootStepId: 'st4', stateFillable: true },
  report: REPORT,
};

/**
 * 别的两个 tab 各自的快照。**tab 条要调版面就得真切得动**——只有一份快照的话，
 * 点哪个 tab 屏幕都不变，"切过去之后这一屏该整个换掉"这件事在预览里根本看不出来。
 *
 * 两份各挑一档：c2 挂着一条待办、没在跑（tab 上是暖色点），c3 一轮都没跑过（不点）。
 * 与 {@link CASES} 里那两行的 `todos` / `running` **必须对得上**：对不上的话，
 * tab 上的点与切过去看到的界面说的是两回事，而这正是这一版要防的那种谎报。
 */
const stub = (c: CaseBrief): Snapshot => ({
  ...EMPTY_SNAPSHOT,
  cases: CASES,
  case: {
    ...FULL.case!,
    id: c.id,
    title: c.title,
    question: c.title,
    status: c.status,
    verdictShape: c.status === 'closed' ? 'chain' : c.status === 'aborted' ? 'open' : null,
  },
});

const OTHERS: Record<string, Snapshot> = {
  c2: {
    ...FULL,
    case: {
      ...FULL.case!,
      id: 'c2',
      title: '推送在 12:40 之后整体延迟',
      question: '12:40 之后推送整体延迟十几分钟，先看是不是队列积压。',
      projectRoot: '/Users/ziyu/Projects/push-gateway',
    },
    busy: false,
    backgroundLanes: 0,
    liveLanes: [],
    steps: steps.slice(0, 3),
    chat: CHAT.slice(0, 8),
    pending: [PENDING[0]!],
    gates: [],
    takeover: false,
  },
  c3: {
    ...FULL,
    case: {
      ...FULL.case!,
      id: 'c3',
      title: '网关偶发 502，只有华东节点',
      question: '华东节点偶发 502，其余机房没有。',
      projectRoot: '/Users/ziyu/Projects/gateway',
    },
    sessionStatus: 'idle',
    busy: false,
    takeover: false,
    context: null,
    backgroundLanes: 0,
    liveLanes: [],
    steps: [],
    incident: [],
    pending: [],
    gates: [],
    chat: [],
  },
};

/**
 * 刚建完、一步都没跑的样子：空态与"什么都有"是两种要分别看的版面。
 *
 * 🔴 **`cases` 里必须有它自己那一条。** 一度写成空数组（只为看首页那句「暂无记录」），
 * 而当前调查在真快照里一定在列表上（main 把它钉住），于是 tab 条查不到 brief、
 * 只好把裸 caseId 印上去——一个生产里不可能出现的版面。刚建完的首页本来也不是空的：
 * 那一行就是他刚建的这次调查。
 */
const EMPTY_LIKE: Snapshot = {
  ...FULL,
  // 「待开始」那一档：建完还没跑过一轮，与它点进去底部那句一致
  cases: [
    {
      id: FULL.case!.id,
      title: FULL.case!.title,
      status: 'open',
      updatedAt: now,
      current: true,
      todos: 0,
      running: false,
      started: false,
      loaded: true,
    },
  ],
  case: { ...FULL.case!, status: 'open' },
  sessionStatus: 'idle',
  takeover: false,
  busy: false,
  // 一轮都没跑过就问不到上下文用量，那一格因此整个不显示——编一个 0% 与"真的还没用"长得一样
  context: null,
  backgroundLanes: 0,
  liveLanes: [],
  steps: [],
  incident: [],
  pending: [],
  gates: [],
  chat: [],
  closingGaps: ['impact', 'leftover'],
  report: {
    rootCause: null,
    impact: null,
    remediation: null,
    expected: null,
    actual: null,
    leftovers: [],
    refuted: [],
    roster: null,
    metrics: [],
  },
};

const INTAKE_OPTIONS: IntakeOptions = {
  backends: [
    { value: 'claude', label: 'Claude', enabled: true },
    { value: 'codex', label: 'Codex', enabled: false, note: '未接入' },
  ],
  // 与真探测回来的那份同形：带 resolvedModel，且 Haiku 一档 effort 都没有
  models: [
    { value: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]', description: 'Opus 5 with 1M context', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus[1m]', label: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]', description: 'Opus 5 with 1M context', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', label: 'Sonnet', resolvedModel: 'claude-sonnet-5', description: 'Sonnet 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', label: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001', description: 'Haiku 4.5', efforts: [] },
  ],
  modelsProbed: true,
  recentRoots: ['/Users/ziyu/Projects/order-api', '/Users/ziyu/Projects/gateway', '/Users/ziyu/Projects/inquestry'],
  agentDefaults: { agent: { backend: 'claude', model: null, effort: null }, takeover: false },
};

const APP_INFO: AppInfo = {
  version: '0.0.0-preview',
  electron: '—（浏览器预览）',
  chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '—',
  node: '—（浏览器预览）',
  sqlite: '—（浏览器预览）',
  claudeVersion: '2.0.0',
  dbPath: '~/Library/Application Support/inquestry/inquestry.db',
  dbBytes: 4_812_345,
};

/**
 * 更新那一行的预览档。默认给 `ready`——那是唯一带第二颗按钮的形态；
 * `?upd=downloading|error|current|checking|idle` 换档看其余几种。
 */
function updateFixture(params: URLSearchParams): UpdateStatus {
  switch (params.get('upd')) {
    case 'downloading':
      return { phase: 'downloading', version: '0.2.0', percent: 62 };
    case 'error':
      return { phase: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' };
    case 'current':
      return { phase: 'current' };
    case 'checking':
      return { phase: 'checking' };
    case 'idle':
      return { phase: 'idle' };
    default:
      return { phase: 'ready', version: '0.2.0' };
  }
}

/** 没人接的那些手势统一从这儿出声，免得点了没反应像是界面坏了。 */
function inert(name: string) {
  return (...args: unknown[]) => {
    console.info(`[preview] ${name} 在浏览器预览里不做事`, ...args);
  };
}

export function installPreviewApi(): void {
  const params = new URLSearchParams(location.search);
  const listeners = new Set<(s: Snapshot) => void>();
  /**
   * 每个调查一份快照，**切 tab 是真切**：只有一份的话，点哪个 tab 屏幕都不变，
   * 而"切过去整屏换掉"正是这一版要看的东西。
   */
  const snaps: Record<string, Snapshot> = {
    // 没单独造过快照的那几条也要切得过去：tab 条上点下去落到一屏空白的话，
    // 看起来像是切换坏了，而其实只是这份夹具没给数据
    ...Object.fromEntries(CASES.map((c) => [c.id, stub(c)])),
    ...OTHERS,
    c1: params.has('empty') ? EMPTY_LIKE : FULL,
  };
  let currentId = 'c1';
  /** 当前是哪个调查由这一层现算，夹具里不写死——写死的话切过去之后两处各说各的。 */
  const view = (): Snapshot => {
    const s = snaps[currentId] ?? EMPTY_SNAPSHOT;
    return { ...s, cases: s.cases.map((c) => ({ ...c, current: c.id === currentId })) };
  };
  const push = () => listeners.forEach((cb) => cb(view()));
  const patch = (p: Partial<Snapshot>) => {
    snaps[currentId] = { ...(snaps[currentId] ?? EMPTY_SNAPSHOT), ...p };
    push();
  };
  /** 这一层里读"当前那份"的地方都走它——`snaps[currentId]` 会随切换换掉。 */
  const cur = (): Snapshot => snaps[currentId] ?? EMPTY_SNAPSHOT;
  /**
   * 收尾之后**那份调查概览也要跟着改**：tab 条是照概览上的 `status` 决定还留不留的，
   * 只改当前这份快照的话，定稿完 tab 还挂在那儿，而真 app 里它当场就没了。
   */
  const froze = (caseId: string, status: CaseBrief['status']) => {
    const row = CASES.find((c) => c.id === caseId);
    if (row) row.status = status;
    patch({ cases: [...CASES] });
  };
  /**
   * 起手开着几个 tab。`?tabs=N` 换档：一个、两个、挤到要省略的那几档，
   * 以及**多到均分不下、整排改横向滚**的那一档（`?tabs=12` 起）——tab 宽度是可收缩的，
   * 只看两个的话省略号与横向滚那两版永远没人看过。
   *
   * 夹具里的真调查不够用时**现造几条填上**：那一档看的是版面，不是数据。
   */
  // **只取 `open` 那几条**：起手这排就是"重启恢复回来"的那一排，而恢复会过滤掉收了尾的
  // （`backend/db/tabs.ts` 的 `restoreCaseTabs`）。收尾之后那个 tab 照旧留着，只是活不过下一次重启。
  // `?empty` 那一档只有它自己一条调查（那份快照的 `cases` 就只有一行），
  // 多开的 tab 在那儿查不到 brief——而"tab 上印着裸 caseId"是生产里不会有的版面
  const openable = params.has('empty')
    ? ['c1']
    : ['c1', ...CASES.filter((c) => c.status === 'open' && c.id !== 'c1').map((c) => c.id)];
  const want = Math.max(Number(params.get('tabs') ?? 2) || 2, 1);
  // 标题**长短交替**：横向滚那一档要同时看得到省略号与短标题旁边多出来的空当
  const FILL = ['定时任务在跨月那几天重复执行', '登录验证码偶发发不出', 'MQ 堆积'];
  while (!params.has('empty') && openable.length < want) {
    const id = `cfill${openable.length}`;
    const row: CaseBrief = {
      id,
      title: `${FILL[openable.length % FILL.length]}（${openable.length}）`,
      status: 'open',
      updatedAt: now - openable.length * 3600_000,
      current: false,
      todos: 0,
      running: false,
      started: true,
      loaded: false,
    };
    CASES.push(row);
    snaps[id] = stub(row);
    openable.push(id);
  }
  const tabCount = Math.min(want, openable.length);
  let tabs: CaseTabs = { open: openable.slice(0, tabCount), active: 'c1' };

  /**
   * 落库 / 切当前调查**故意失败几次**（`?failput[=次数]` / `?failswitch[=次数]`，默认 1 次）。
   *
   * 这两条失败路在浏览器里没有别的办法触发，而它们正是"界面显示的与 main 那边不是同一份"
   * 那种谎报唯一的防线：退回、补切、以及退不回来时那句不撒谎的横幅。同 `?upd=error`——
   * 不给档的话，这几条路永远没人看过。
   */
  const budget = (key: string) => (params.has(key) ? Number(params.get(key)) || 1 : 0);
  const hangExport = () =>
    params.has('slowexport')
      ? new Promise((r) => setTimeout(r, Number(params.get('slowexport')) || 4000))
      : Promise.resolve();
  let putLeft = budget('failput');
  let switchLeft = budget('failswitch');

  const api: InquestryApi = {
    envCheck: async () => ({ loggedIn: true, email: 'you@example.com' }),
    // `?noroots`：第一次用这个应用的那一版，没有最近用过的目录
    intakeOptions: async () =>
      params.has('noroots') ? { ...INTAKE_OPTIONS, recentRoots: [] } : INTAKE_OPTIONS,
    // 浏览器里没有系统目录选择器，给个像样的路径，好让「选中之后」那一版也看得到
    pickProjectRoot: async () => '/Users/ziyu/Projects/order-api',
    /**
     * **建完就把当前调查换成新建那个**，与 main 一样（`adopt` 里那一下 `select`）。
     * 只回一个 id 的话，"main 已经选中新 case、而 tab 落库失败"那条错配路
     * 在预览里复现不出来——那正是它要防的。
     */
    createCase: async () => {
      const id = `cnew${CASES.length}`;
      const row: CaseBrief = {
        id,
        title: '新建的一次调查',
        status: 'open',
        updatedAt: Date.now(),
        current: false,
        todos: 0,
        running: false,
        started: false,
        loaded: true,
      };
      CASES.unshift(row);
      snaps[id] = stub(row);
      currentId = id;
      push();
      return { ok: true, caseId: id };
    },
    renameCase: async (_id, title) => {
      const meta = cur().case;
      patch({ case: meta && { ...meta, title } });
      return true;
    },
    // 真切：tab 条要在这儿调版面，切不动的话点哪个 tab 屏幕都不变
    switchCase: async (caseId) => {
      if (switchLeft > 0) {
        switchLeft -= 1;
        throw new Error('(预览) 这一次切当前调查故意失败');
      }
      if (!snaps[caseId]) return;
      currentId = caseId;
      tabs = focusOrAppend(tabs, caseId);
      push();
    },
    newCase: async () => {},
    start: async () => {},
    restart: async () => {},
    setTakeover: async (_id, on) => {
      patch({ takeover: on });
      return 'ok';
    },
    send: async (_id, text) => {
      patch({ chat: [...cur().chat, { id: `mem_${cur().chat.length}`, role: 'user', text, at: Date.now() }] });
      return true;
    },
    interrupt: async () => patch({ busy: false, sessionStatus: 'ended' }),
    stopLane: async (_id, lane) => {
      patch({ liveLanes: cur().liveLanes.filter((l) => l !== lane), backgroundLanes: 0 });
      return true;
    },
    requestClosing: async () => ({ missing: cur().closingGaps, asked: true, suggestion: cur().shapeSuggestion }),
    closeCase: async () => {
      if (cur().closingGaps.length) return { ok: false, missing: cur().closingGaps };
      // 真 main 在落库那一刻现算（`closeCase()`）；这里照它的来源取，别另挑一个
      const meta = cur().case;
      patch({ case: meta && { ...meta, status: 'closed', verdictShape: cur().shapeSuggestion.shape } });
      froze(currentId, 'closed');
      return { ok: true, status: 'closed' };
    },
    archiveCase: async () => {
      const meta = cur().case;
      patch({ case: meta && { ...meta, status: 'aborted', verdictShape: 'open' } });
      froze(currentId, 'aborted');
      return true;
    },
    // 真的从夹具里摘掉，不只回 true：历史页删完一行之后还要看剩下那几行怎么排、
    // 删到空了那一屏长什么样，回个 true 的话这两件事在预览里都看不到
    deleteCase: async (caseId) => {
      // `?slowdel[=毫秒]`：真删要走一遍事件 + 投影 + 删原文，回调因此隔了一会儿才到；
      // 浏览器这一侧是个微任务，"await 期间人又动了 tab"那条竞态复现不出来。
      // 给得出具体毫秒数是因为**这条竞态只能靠窗口够宽来稳定重放**——手点也好、
      // 脚本驱动也好，几百毫秒的窗口撞不撞得上全看运气
      if (params.has('slowdel')) {
        await new Promise((r) => setTimeout(r, Number(params.get('slowdel')) || 900));
      }
      const at = CASES.findIndex((c) => c.id === caseId);
      if (at < 0) return { ok: false, pendingBlobs: 0 };
      CASES.splice(at, 1);
      patch({ cases: [...CASES] });
      return { ok: true, pendingBlobs: 0 };
    },
    answerOperator: async (_id, reply) => {
      patch({ pending: cur().pending.filter((p) => p.id !== reply.id) });
      return true;
    },
    decideGate: async (_id, d) => {
      patch({ gates: cur().gates.filter((g) => g.id !== d.id) });
      return true;
    },
    getTabs: async () => tabs,
    putTabs: async (next) => {
      if (putLeft > 0) {
        putLeft -= 1;
        throw new Error('(预览) 这一次落库故意失败');
      }
      tabs = next;
      // 🔴 **这一下只存列表，不许顺手换当前调查**——main 那边的 `tabs:put` 就只存
      // （切当前调查是 `switchCase` 独一条路）。跟着换的话，"落库成了、切当前调查失败了"
      // 那条错配路在预览里永远复现不出来：屏幕看着一直是对的，而真 app 里两边已经岔开了
      push();
    },
    // 浏览器自己吃掉 ⌘W，预览里没有应用菜单——这条只为让 App 挂得上
    onMenuCloseTab: () => () => {},
    closeWindow: async () => inert('closeWindow')(),
    /**
     * 浏览器里导不出真文件。`?slowexport[=毫秒]` 让它先挂一会儿再回失败——
     * **「导出中」那一档只有这样才看得见**：它是全应用一把锁（`App.tsx` 的 `exporting`），
     * 而"另一次调查在导时这一屏按不动""切走再切回锁还攥着"这两条都只在挂着的那几秒里成立。
     */
    exportMarkdown: async () => {
      await hangExport();
      return { ok: false, reason: 'failed', error: '浏览器预览里没有 main 进程，导不出文件' };
    },
    exportImage: async () => {
      await hangExport();
      return { ok: false, reason: 'failed', error: '浏览器预览里没有 main 进程，导不出文件' };
    },
    exportPayload: async () => null,
    searchCases: async (term) =>
      !term.trim()
        ? []
        : CASES.filter((c) => c.title.includes(term)).map((c) => ({
            ...c,
            hits: 2,
            snippet: `…命中「${term}」附近的原文…`,
            where: 'verdict' as const,
          })),
    snapshot: async () => view(),
    onSnapshot: (cb) => {
      listeners.add(cb);
      // 微任务里补一发：组件挂上来的时候第一帧已经过去了
      queueMicrotask(() => cb(view()));
      return () => listeners.delete(cb);
    },
    excerpt: async () => '12:03:02.240 [order] idempotency check MISS key=u1001:cart7 (read from replica)\n12:03:02.245 [replica] seconds_behind_master=0.340',
    listCases: async (q: CaseListQuery): Promise<CaseListPage> => {
      const all = CASES.filter((c) => !q.status || q.status === 'all' || c.status === q.status);
      return {
        rows: all.map((c) => ({
          ...c,
          projectRoot: '/Users/ziyu/Projects/order-api',
          incidentDate: new Date(c.updatedAt).toISOString().slice(0, 10),
          verdictShape: c.status === 'closed' ? 'chain' : null,
          steps: 7,
          headline: c.status === 'closed' ? '下架状态没同步进检索索引' : null,
        })),
        total: all.length,
      };
    },
    getSettings: async () => DEFAULT_UI_SETTINGS,
    putSettings: async (patchIn) => ({ ...DEFAULT_UI_SETTINGS, ...patchIn }),
    appInfo: async () => APP_INFO,
    revealDb: async () => inert('revealDb')(),
    openExternal: async (url) => void window.open(url, '_blank', 'noopener'),
    updateStatus: async () => updateFixture(params),
    updateCheck: async () => inert('updateCheck')(),
    updateInstall: async () => inert('updateInstall')(),
    onUpdateStatus: () => () => {},
  };

  (window as unknown as { inquestry: InquestryApi }).inquestry = api;
}
