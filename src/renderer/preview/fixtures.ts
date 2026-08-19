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
import type { UpdateStatus } from '../../shared/update.js';
import { DEFAULT_UI_SETTINGS } from '../../shared/settings.js';
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
const STORY: Record<string, { direction: string; verdict: string }> = {
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
};
const EV_STORY: Record<string, { claim: string; occurredAtRaw: string | null }> = {
  e1: { claim: 't_order 落下第一条 u1001:cart7 订单', occurredAtRaw: '12:03:02' },
  e2: { claim: '同一 cart_key 的第二条写入落库，没有被索引拦下', occurredAtRaw: '12:04:51' },
  e3: { claim: '从库 seconds_behind_master=0.34，幂等检查读到的是旧数据', occurredAtRaw: null },
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
  remediation: '给 `t_order.cart_key` 补 UNIQUE 索引并清理 37 笔重复；迁移脚本加一条索引一致性校验',
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
};

/**
 * 舞台是画布之后，**列**成了语义轴（主干 / 子 agent 支线 / agent 声明的分叉，见 `track.ts`）。
 * 借来的那份报告夹具全是主干，一列都看不见——所以这儿另接三步，专门把三种列各摆一条出来。
 *
 * **只加在预览这一侧**：报告那几屏读的是 `report` / `incident` 两份投影，与这三步无关；
 * 往共用夹具里加的话，`spike:report` 覆盖的那个案子就和屏幕上这个慢慢变成两回事。
 */
const LANE = 'toolu_01ab9f';
steps.push(
  {
    ...rawSteps[0]!,
    id: 'lane1',
    ordinal: 7,
    startedAt: now - 5 * min,
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
    ordinal: 8,
    startedAt: now - 4 * min,
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
    ordinal: 9,
    startedAt: now - 3 * min,
    parentStepId: steps[3]!.id,
    direction: '换个角度：先看这张表的唯一约束是不是从来就没建上过',
    status: 'confirmed',
    verdict: '建表语句里是 KEY `idx_cart_key`，不是 UNIQUE KEY——2026-03 那次迁移漏了这一行。',
    evidence: [],
    calls: [],
  },
);

const CASES: CaseBrief[] = [
  // 五行**各占一档节点**（运行中 / 等你 / 待开始 / 已定稿 / 已归档）：少一档就等于那一档的配色没人看过。
  // 这一条要的是「运行中」那颗，所以待办给 0——挂着待办的话它显示的是「等你」那颗
  { id: 'c1', title: '订单提交产生了两条重复记录', status: 'open', updatedAt: now - 2 * min, current: false, todos: 0, running: true, started: true, loaded: true },
  // 当前调查**故意不是最近那条**：轨道按时间排，当前是哪一条只由 `.cur` 说。
  // 把 current 放在第一行的话，"当前被提到最前"与"它本来就在最前"长得一模一样
  { id: 'c2', title: '推送在 12:40 之后整体延迟', status: 'open', updatedAt: now - 40 * min, current: true, todos: 1, running: false, started: true, loaded: true },
  // 点开看过一眼、一轮都没跑过：列表上该是「待开始」，与它点进去底部那句一致
  { id: 'c3', title: '网关偶发 502，只有华东节点', status: 'open', updatedAt: now - 5 * 3600_000, current: false, todos: 0, running: false, started: false, loaded: true },
  { id: 'c4', title: '搜索结果里混进了已下架的节目', status: 'closed', updatedAt: now - 3 * 86400_000, current: false, todos: 0, running: false, started: true, loaded: false },
  { id: 'c5', title: '导出任务卡在 99%', status: 'aborted', updatedAt: now - 9 * 86400_000, current: false, todos: 0, running: false, started: true, loaded: false },
];

const CHAT: ChatLine[] = [
  // 开场白由 main 标出来（每次会话最早那条 user 行），舞台不织它——信息卡上已经逐字有了
  { id: 'ch0', opening: true, role: 'user', at: now - 13 * min, text: '线上反馈：12:03 前后，用户 u1001 只提交了一次订单，系统里却出现了两条重复记录。请排查根因。\n基准日期：2026-08-15（时区 +08:00）。' },
  { id: 'ch1', role: 'user', at: now - 12 * min, text: '线上反馈：12:03 前后用户 u1001 只提交了一次订单，系统里出现了两条重复记录。' },
  { id: 'ch2', role: 'assistant', at: now - 11 * min, text: '先看这两条记录是不是同一个请求写进去的。我去查网关日志里 u1001 那一段。' },
  { id: 'ch3', role: 'assistant', at: now - 6 * min, text: '两条记录来自两个 req_id，第一条超时了 2140ms。方向改成「幂等键为什么没拦住第二次」。' },
  { id: 'ch4', role: 'system', at: now - 5 * min, text: '已接管：接下来除只读与杂务外，每次工具调用都要你放行。' },
  { id: 'ch5', role: 'user', at: now - 2 * min, text: '重点看 t_order 上那个 cart_key 的索引。' },
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
  context: { usedTokens: 63_400, maxTokens: 200_000, percent: 31.7, model: 'claude-opus-5[1m]' },
  backgroundLanes: 1,
  liveLanes: ['lane_a'],
  steps,
  incident: INCIDENT,
  pending: PENDING,
  gates: GATES,
  chat: CHAT,
  closingGaps: ['impact'],
  shapeSuggestion: { shape: 'chain', source: 'agent', rootStepId: 'st4', stateFillable: true },
  report: REPORT,
};

/** 刚建完、一步都没跑的样子：空态与"什么都有"是两种要分别看的版面。 */
const EMPTY_LIKE: Snapshot = {
  ...FULL,
  cases: [],
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
  report: { rootCause: null, impact: null, remediation: null, expected: null, actual: null, leftovers: [], refuted: [] },
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
  const snap = params.has('empty') ? EMPTY_LIKE : FULL;
  const listeners = new Set<(s: Snapshot) => void>();
  // 快照是活的：闸门放行 / 待办回填要真的从列表里消失，否则那几张卡的收尾动作看不出对不对
  let current = snap;
  const push = () => listeners.forEach((cb) => cb(current));
  const patch = (p: Partial<Snapshot>) => {
    current = { ...current, ...p };
    push();
  };

  const api: InquestryApi = {
    envCheck: async () => ({ loggedIn: true, email: 'you@example.com' }),
    // `?noroots`：第一次用这个应用的那一版，没有最近用过的目录
    intakeOptions: async () =>
      params.has('noroots') ? { ...INTAKE_OPTIONS, recentRoots: [] } : INTAKE_OPTIONS,
    // 浏览器里没有系统目录选择器，给个像样的路径，好让「选中之后」那一版也看得到
    pickProjectRoot: async () => '/Users/ziyu/Projects/order-api',
    createCase: async () => ({ ok: true }),
    renameCase: async (_id, title) => {
      patch({ case: current.case && { ...current.case, title } });
      return true;
    },
    switchCase: async () => {},
    newCase: async () => {},
    start: async () => {},
    restart: async () => {},
    setTakeover: async (_id, on) => {
      patch({ takeover: on });
      return 'ok';
    },
    send: async (_id, text) => {
      patch({ chat: [...current.chat, { id: `mem_${current.chat.length}`, role: 'user', text, at: Date.now() }] });
      return true;
    },
    interrupt: async () => patch({ busy: false, sessionStatus: 'ended' }),
    stopLane: async (_id, lane) => {
      patch({ liveLanes: current.liveLanes.filter((l) => l !== lane), backgroundLanes: 0 });
      return true;
    },
    requestClosing: async () => ({ missing: current.closingGaps, asked: true, suggestion: current.shapeSuggestion }),
    closeCase: async () => {
      if (current.closingGaps.length) return { ok: false, missing: current.closingGaps };
      // 真 main 在落库那一刻现算（`closeCase()`）；这里照它的来源取，别另挑一个
      patch({
        case: current.case && { ...current.case, status: 'closed', verdictShape: current.shapeSuggestion.shape },
      });
      return { ok: true, status: 'closed' };
    },
    archiveCase: async () => {
      patch({ case: current.case && { ...current.case, status: 'aborted', verdictShape: 'open' } });
      return true;
    },
    // 真的从夹具里摘掉，不只回 true：历史页删完一行之后还要看剩下那几行怎么排、
    // 删到空了那一屏长什么样，回个 true 的话这两件事在预览里都看不到
    deleteCase: async (caseId) => {
      const at = CASES.findIndex((c) => c.id === caseId);
      if (at < 0) return { ok: false, pendingBlobs: 0 };
      CASES.splice(at, 1);
      patch({ cases: [...CASES] });
      return { ok: true, pendingBlobs: 0 };
    },
    answerOperator: async (_id, reply) => {
      patch({ pending: current.pending.filter((p) => p.id !== reply.id) });
      return true;
    },
    decideGate: async (_id, d) => {
      patch({ gates: current.gates.filter((g) => g.id !== d.id) });
      return true;
    },
    exportMarkdown: async () => ({ ok: false, reason: 'failed', error: '浏览器预览里没有 main 进程，导不出文件' }),
    exportImage: async () => ({ ok: false, reason: 'failed', error: '浏览器预览里没有 main 进程，导不出文件' }),
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
    snapshot: async () => current,
    onSnapshot: (cb) => {
      listeners.add(cb);
      // 微任务里补一发：组件挂上来的时候第一帧已经过去了
      queueMicrotask(() => cb(current));
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
