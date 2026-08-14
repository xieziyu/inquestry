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
import { DEFAULT_UI_SETTINGS } from '../../shared/settings.js';
import { incident, report, steps } from '../../../scripts/fixtures/report-case.js';

const now = Date.now();
const min = 60_000;

const CASES: CaseBrief[] = [
  { id: 'c1', title: '订单提交产生了两条重复记录', status: 'open', updatedAt: now - 2 * min, current: true, todos: 2, running: true, loaded: true },
  { id: 'c2', title: '推送在 12:40 之后整体延迟', status: 'open', updatedAt: now - 40 * min, current: false, todos: 1, running: false, loaded: true },
  { id: 'c3', title: '网关偶发 502，只有华东节点', status: 'open', updatedAt: now - 5 * 3600_000, current: false, todos: 0, running: false, loaded: false },
  { id: 'c4', title: '搜索结果里混进了已下架的节目', status: 'closed', updatedAt: now - 3 * 86400_000, current: false, todos: 0, running: false, loaded: false },
  { id: 'c5', title: '导出任务卡在 99%', status: 'aborted', updatedAt: now - 9 * 86400_000, current: false, todos: 0, running: false, loaded: false },
];

const CHAT: ChatLine[] = [
  { role: 'user', at: now - 12 * min, text: '线上反馈：12:03 前后用户 u1001 只提交了一次订单，系统里出现了两条重复记录。' },
  { role: 'assistant', at: now - 11 * min, text: '先看这两条记录是不是同一个请求写进去的。我去查网关日志里 u1001 那一段。' },
  { role: 'assistant', at: now - 6 * min, text: '两条记录来自两个 req_id，第一条超时了 2140ms。方向改成「幂等键为什么没拦住第二次」。' },
  { role: 'system', at: now - 5 * min, text: '已接管：接下来除只读与杂务外，每次工具调用都要你放行。' },
  { role: 'user', at: now - 2 * min, text: '重点看 t_order 上那个 cart_key 的索引。' },
];

const PENDING: PendingAsk[] = [
  {
    id: 'ask1',
    engine: 'mysql',
    statement: 'SHOW CREATE TABLE `t_order`;',
    why: '要确认 cart_key 上是唯一索引还是普通索引——这决定第二次写入能不能被数据库自己挡住。',
    expect: '建表语句里 cart_key 那一行的索引类型',
    env: 'prod-读库',
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
  backgroundLanes: 1,
  liveLanes: ['lane_a'],
  steps,
  incident,
  pending: PENDING,
  gates: GATES,
  chat: CHAT,
  closingGaps: ['impact'],
  shapeSuggestion: { shape: 'chain', source: 'agent', rootStepId: 'st4', stateFillable: true },
  report,
};

/** 刚建完、一步都没跑的样子：空态与"什么都有"是两种要分别看的版面。 */
const EMPTY_LIKE: Snapshot = {
  ...FULL,
  cases: [],
  case: { ...FULL.case!, status: 'open' },
  sessionStatus: 'idle',
  takeover: false,
  busy: false,
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
  claudePath: '/opt/homebrew/bin/claude',
  claudeVersion: '2.0.0',
  dbPath: '~/Library/Application Support/inquestry/inquestry.db',
  dbBytes: 4_812_345,
};

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
    envCheck: async () => ({ claude: '/opt/homebrew/bin/claude', hint: '' }),
    intakeOptions: async () => INTAKE_OPTIONS,
    // 浏览器里没有系统目录选择器，给个像样的路径，好让「选中之后」那一版也看得到
    pickProjectRoot: async () => '/Users/ziyu/Projects/order-api',
    createCase: async () => ({ ok: true }),
    switchCase: async () => {},
    newCase: async () => {},
    start: async () => {},
    restart: async () => {},
    setTakeover: async (_id, on) => {
      patch({ takeover: on });
      return 'ok';
    },
    send: async (_id, text) => {
      patch({ chat: [...current.chat, { role: 'user', text, at: Date.now() }] });
      return true;
    },
    interrupt: async () => patch({ busy: false, sessionStatus: 'ended' }),
    stopLane: async (_id, lane) => {
      patch({ liveLanes: current.liveLanes.filter((l) => l !== lane), backgroundLanes: 0 });
      return true;
    },
    requestClosing: async () => ({ missing: current.closingGaps, asked: true, suggestion: current.shapeSuggestion }),
    closeCase: async (_id, shape) => {
      if (current.closingGaps.length) return { ok: false, missing: current.closingGaps };
      patch({ case: current.case && { ...current.case, status: 'closed', verdictShape: shape } });
      return { ok: true, status: 'closed' };
    },
    archiveCase: async () => {
      patch({ case: current.case && { ...current.case, status: 'aborted', verdictShape: 'open' } });
      return true;
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
  };

  (window as unknown as { inquestry: InquestryApi }).inquestry = api;
}
