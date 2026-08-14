/**
 * main ↔ renderer 的契约。
 *
 * **这里只有领域类型，不出现任何 backend / SDK 类型**（D20 纪律 2）：
 * renderer 不该知道背后跑的是 Claude 还是 codex。
 */

// 只借一个类型：报告要装哪几块由 `shared/report.ts` 定，在这儿照抄一份必然与它长歪
import type { ReportInput } from './report.js';
import type { UiSettings } from './settings.js';

/**
 * 新建排查面板收集的东西（ui.md §8.1）。
 *
 * agent 三项与其余分开：前者落 `sessions`，后者落 `cases`（D27）。
 */
export type AgentChoice = {
  backend: 'claude' | 'codex';
  model: string | null;
  effort: string | null;
};

/**
 * 基准日期与时区都不在这里：由 main 取立案那一刻的本机日期与偏移落库。
 * 因此本工具的前提是**日志时区 = 立案机器时区、事发就在立案当天**——
 * 排查异地系统或补查前几天的事故时这条会错，错法是无日期的时间串整体挪几小时 / 几天，
 * 且不会有任何报错，见 ui.md §8.1。
 */
export type IntakeDraft = {
  /** 工作区目录，必填：它决定 agent 继承哪套 skill / MCP，也是唯一的信任边界。 */
  projectRoot: string;
  question: string;
  agent: AgentChoice;
  /**
   * 权限模式初值：`true` = 全程接管（ui.md §8.1）。设置屏给的只是预填，
   * **这一次选的什么以这个字段为准**——不带过来的话面板上那个开关是个假开关。
   */
  takeover: boolean;
};

/** 新建排查的结果。失败要指明是哪个字段，否则面板只能给一句无处下手的错误。 */
export type IntakeResult = { ok: true } | { ok: false; field: 'projectRoot'; error: string };

/**
 * ⚠️ **加字段要同时把 `backend/agent/capabilities.ts` 的 `CACHE_VERSION` +1。**
 * 那份探测结果缓存 24 小时，旧形状不作废的话老库上会安静地顶着少一个字段的行，
 * 而界面上没有任何地方看得出来。
 */
export type ModelOption = {
  value: string;
  label: string;
  /**
   * 这一档实际落到的模型 id（`sonnet` → `claude-sonnet-5`）。**面板要把它显示出来**：
   * backend 报的 `label` 只有系列名，看不出跑的是第几代——而报告里要标"这一步是哪个模型跑的"。
   * 探测不到时没有这一项（内置兜底表故意不写死版本号，那才是真正会烂的东西）。
   */
  resolvedModel?: string;
  description: string;
  /** 不支持时整项隐藏，而不是给个假开关（D19）。 */
  efforts: string[];
};

/** 新建排查面板的可选项。model 一栏是真探测出来的，探测不到才退回内置列表。 */
export type IntakeOptions = {
  backends: { value: 'claude' | 'codex'; label: string; enabled: boolean; note?: string }[];
  models: ModelOption[];
  modelsProbed: boolean;
  recentRoots: string[];
  /**
   * 设置屏里定的那份预填（agent 三项 + 权限模式初值）。
   *
   * ⚠️ `agent.model` **可能不在上面那张 `models` 表里**：设置那会儿探测到的模型，
   * 这会儿可能探测不到、退回了内置表。面板要按"选不到就回默认那一档"处理，
   * 而不是把一个列表上根本没有的值显示成选中。
   */
  agentDefaults: { agent: AgentChoice; takeover: boolean };
};

/** 排查列表的一行（D28）。 */
export type CaseBrief = {
  id: string;
  title: string;
  status: 'open' | 'closed' | 'aborted';
  updatedAt: number;
  current: boolean;
  /**
   * 等你处理的条数。**跨 case 汇总的价值全在这一个字段上**：
   * 你在排查 A 上工作时排查 B 卡在 ask_operator 上等人，只在当前排查显示的话那条支线会静静挂死。
   */
  todos: number;
  /** 有一轮正在跑。 */
  running: boolean;
  /** main 里还持有它的运行时；false 表示只剩库里的历史，点开会新起一个 session。 */
  loaded: boolean;
};

/**
 * 历史排查页要的一行（ui.md §8.3）。
 *
 * 比 `CaseBrief` 多的都是**只在那一页看得见**的：工作区、步数、当前结论摘要。
 * 快照里那份 `cases` 每 60ms 推一轮，把这些塞进去等于每一轮都多跑几条聚合查询，
 * 而它们只有历史排查页开着时才有人看。
 */
export type CaseListRow = CaseBrief & {
  projectRoot: string | null;
  incidentDate: string;
  verdictShape: VerdictShape | null;
  steps: number;
  /** 当前生效的那条结论，截断过。没有就是 null——半程与刚起步的排查都会这样。 */
  headline: string | null;
};

/**
 * 历史排查页的筛选。**`status` 里没有"进行中"这一档的运行时含义**：
 * 库里只有 open / closed / aborted，"在跑"是运行时状态，由 `running` 合上去。
 */
export type CaseListQuery = {
  status?: 'all' | 'open' | 'closed' | 'aborted';
  limit?: number;
  offset?: number;
};

export type CaseListPage = {
  rows: CaseListRow[];
  /** 库里符合这个筛选的总数，用来画"还有多少没显示"。 */
  total: number;
};

/** 关于那一节。版本号一律由 main 现取，renderer 里写死的那份必然与打包出来的对不上。 */
export type AppInfo = {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  sqlite: string;
  /** claude 可执行文件路径；没找到是 null。版本号探测不到时为 null，不编一个。 */
  claudePath: string | null;
  claudeVersion: string | null;
  dbPath: string;
  dbBytes: number;
};

/**
 * 检索命中的一次排查（ui.md §8.3 的「历史」那一半）。
 *
 * 与 `CaseBrief` 是同一种东西加三项"为什么命中"——**不另起一种类型**：
 * 两种列表长得一样、点下去做的也是同一件事，分成两种的话
 * 徽标（等你 N / 运行中）迟早只在其中一边跟得上。
 */
export type CaseHit = CaseBrief & {
  /** 这次排查里命中了几条。只作展示，不参与排序（排序与最近列表同一条规则）。 */
  hits: number;
  /** 命中处附近的原文，已截断。 */
  snippet: string;
  /** 命中出自哪一类文本；标签由界面给，这里只给类别。 */
  where: 'case' | 'verdict' | 'direction' | 'evidence' | 'lane' | 'chat';
};

export type CallNode = {
  id: string;
  callNumber: number;
  toolName: string;
  origin: 'agent' | 'operator';
  status: string;
  input: string;
  /** 闸门判决。`auto` 是自动放行的多数情况，UI 只标出其余四种。 */
  gate: string | null;
  outputPreview: string;
  outputLines: number;
};

export type EvidenceNode = {
  id: string;
  claim: string;
  anchor: string | null;
  occurredAtRaw: string | null;
  actor: string | null;
  callId: string;
};

export type StepNode = {
  id: string;
  /**
   * 会话内序号，**不是排查内的**：一次排查跨多会话，重开一次它就从 1 重来。
   * 轨道上因此会出现两个 #1，得靠 `sessionIndex` 标出断点。
   */
  ordinal: number;
  sessionId: string;
  /** 这是本次排查的第几次会话，从 1 起。 */
  sessionIndex: number;
  /**
   * 在哪一步之下细分（`open_step` 的可选入参）。轨道靠它把分叉往右缩进。
   * 认不得的父 id 在写入侧就归一成了 null 并回一条 warning（`parent_step_id` 上有外键，
   * 原样落库会直接炸），所以这里到手的要么是本次排查里的真 step，要么就是 null。
   */
  parentStepId: string | null;
  /**
   * 这一步属于哪条子 agent 泳道（overview §4.5）；null = 主干。
   *
   * 值是**起这条支线那次调用的 `tool_use_id`**，UI 只拿它当"是不是支线"的开关与短标识，
   * 缩进照旧走 `parentStepId`——轨道不必认识泳道，一条支线在它眼里就是一次分叉（D23）。
   */
  lane: string | null;
  kind: 'normal' | 'unclassified' | 'impact' | 'leftover';
  /**
   * `converged` 只出现在支线的兜底步上（ui.md §3.2）：那一步没有命题，所以它不是一种结论，
   * 只是说"这条支线到此为止"。报告那几栏按具体 status 取，它因此哪一栏都不进。
   */
  status: 'open' | 'confirmed' | 'refuted' | 'inconclusive' | 'superseded' | 'converged';
  direction: string | null;
  verdict: string | null;
  confidence: number | null;
  supersededBy: string | null;
  calls: CallNode[];
  evidence: EvidenceNode[];
};

export type IncidentEntry = {
  /**
   * 这一行出自哪一条证据。**导出的脚注靠它对上文末索引**（ui.md §7.1）：
   * 正文只留 `[^e3]`，工具 / 锚点 / 时间戳来源统一落在索引里。
   * 没有它就只能按 `claim` + `callId` 反猜，而同一次调用里两条同文的证据分不开。
   */
  evidenceId: string;
  occurredAtRaw: string | null;
  occurredAtMs: number;
  actor: string | null;
  claim: string;
  stepId: string;
  stepStatus: string;
  callId: string;
  anchor: string | null;
};

/** 挂起的人工回填。resolve 靠 main 里活着的 Promise，进程重启即失效（data-model.md §4）。 */
export type PendingAsk = {
  id: string;
  engine: string;
  statement: string;
  why: string;
  expect: string;
  env?: string;
  askedAt: number;
};

/**
 * 卡在闸门上的一次调用（②档，ui.md §4）。
 *
 * 与 ①档 `PendingAsk` 的分别在于**不处理会怎样**：这一档到点按预设放行，
 * 所以有 `deadline`；①档故意没有，自动填个假结果比让人等着更糟。
 *
 * **接管模式下没有 `deadline`**（overview §3.5）：人刚刚明说了"每一条我自己判"，
 * 三分钟后替他放行等于把这句话作废，而那时挂在闸门上的多半正是敏感写。
 * 那一档因此与 ①档同形：等到有人处置，或这一轮被停掉为止。
 */
export type PendingGate = {
  /** 就是 backend 的 toolUseID —— 与 `CallNode.id` 同一个键，处置后能直接对上节点。 */
  id: string;
  toolName: string;
  /** 参数的 JSON 文本，可改后放行。 */
  input: string;
  agentId?: string;
  /** backend 说得出「为什么问你」时带上，说不出就没有。 */
  reason?: string;
  askedAt: number;
  /** 到点自动放行的时刻；接管模式下没有这一项，界面那颗倒计时环也就不该出现。 */
  deadline?: number;
};

/** 闸门的三个手势。改写与放行是一个动作的两种形态，拒绝必须留话——不留话 agent 不知道换什么。 */
export type GateDecision =
  | { id: string; action: 'allow' }
  | { id: string; action: 'rewrite'; input: string }
  | { id: string; action: 'deny'; message: string };

export type ChatLine = { role: 'user' | 'assistant' | 'system'; text: string; at: number };

/** 定稿前的两个强制 step（overview §6.2）。 */
export type ClosingStepKind = 'impact' | 'leftover';

/**
 * 报告按哪种形态组装（D25 / overview §6.1.1）。
 *
 * **时间线只是五种之一**：配置写错、索引缺失这类故障没有"事发瞬间"，硬凑一条时间线
 * 只会得到「某天变更、某天发现」两行，还稀释掉真正该对照的东西。
 */
export type VerdictShape = 'sequence' | 'state' | 'chain' | 'distribution' | 'open';

/** 顺序即选择器上的顺序：从「有时序」到「没查出来」。 */
export const VERDICT_SHAPES: readonly VerdictShape[] = [
  'sequence',
  'state',
  'chain',
  'distribution',
  'open',
];

/**
 * 定稿确认条上的预选值。
 *
 * `agent` = 某一步的 `close_step` 里声明过；`inferred` = 没人声明，harness 按现有数据推的。
 * **两者必须让人分得出来**：推断值只是个不至于装错块的兜底，不是一次判断。
 */
export type ShapeSuggestion = {
  shape: VerdictShape;
  source: 'agent' | 'inferred';
  /**
   * 这份建议是按哪一条根因算出来的；一条已证实的根因都没有时为 null。
   *
   * 界面靠它判断"手上冻的这份还说的是不是同一步"：根因换了人，实时快照上的
   * `stateFillable` 说的就是另一步的事，拿来配已经冻住的形态会得出相反的结论。
   */
  rootStepId: string | null;
  /**
   * 那条根因给了应然/实然没有——状态型的主体装不装得出来全看它。
   * 与 `shape` 同次算出，两者因此一定说的是同一步。
   */
  stateFillable: boolean;
};

/**
 * 「现在还差什么」的问询结果。**这条路永远不改状态**，问完顺带把缺的那两步派给 agent。
 * `asked` = 真派出去了（会话还活着才派得出去）。
 *
 * `suggestion` 与 `missing` 出自**同一次库状态**，确认条冻的就是它。
 * 让界面拿自己那份快照去取形态的话，两者会差着一拍：main 按最新状态放行了弹窗，
 * 而界面冻的是点击那一帧的推断值——agent 刚落定的声明就此被一个过期值盖掉。
 * 这与「不拿快照上的 closingGaps 决定该弹确认还是派活」是同一条理由。
 */
export type ClosingRequest = {
  missing: ClosingStepKind[];
  asked: boolean;
  suggestion: ShapeSuggestion;
};

/**
 * 定稿的结果。**不成立时要说清差什么**，否则界面只能给一句"还不能定稿"，人无从下手。
 *
 * 与 `ClosingRequest` 分开是因为两者的语义天差地别：那个只问，这个**执行且不可逆**。
 * 合成一个的话，界面就得靠快照决定"这一下是问还是执行"——而快照是 60ms 合流推的，
 * 隔着这一拍，一次本以为"去补两步"的点击会直接把排查冻上，且完全没经过确认。
 */
export type ClosingOutcome =
  | { ok: true; status: 'open' | 'closed' | 'aborted' }
  | { ok: false; missing: ClosingStepKind[] };

/** 当前排查的建单信息投影。为 null 表示还没新建排查，UI 该显示新建排查面板。 */
export type CaseMeta = {
  id: string;
  title: string;
  question: string;
  projectRoot: string | null;
  incidentDate: string;
  tzOffset: string;
  /** 历史字段：新建排查面板不再单收「已知现象」，写清楚在 `question` 里就够了。 */
  clues: string | null;
  agent: AgentChoice;
  /** 收尾三档（D29）。`closed` / `aborted` 都是冻结：开不了新会话，只能导出。 */
  status: 'open' | 'closed' | 'aborted';
  /**
   * 报告按哪种形态装（D25）。**收尾那一下才落**，在那之前是 null。
   * 归档一律是 `open`：半程报告没有根因栏（ui.md §8.4）。
   */
  verdictShape: VerdictShape | null;
};

/** 报告里只用到一步的结论与命题时的窄投影（遗留问题 / 排除矩阵）。 */
export type ReportStepRef = {
  stepId: string;
  direction: string | null;
  text: string;
  supersededBy: string | null;
};

export type Snapshot = {
  case: CaseMeta | null;
  /** 所有排查，含别处的待办数。`case` 为 null = 手上没有打开的排查，而列表照旧要给（首页靠它）。 */
  cases: CaseBrief[];
  sessionStatus: 'idle' | 'live' | 'ended' | 'crashed';
  /**
   * 接管模式开着没有（overview §3.5）。开着时每一次非放行档的调用都挂到闸门上，
   * 且**那些闸门没有超时兜底**——所以它必须在界面上一眼看得见，
   * 而不是等第一张闸门卡冒出来才知道自己开着它。
   */
  takeover: boolean;
  /**
   * 最近一轮的失败原因。**会话可能仍是 `live` 却已经跑不动了**——凭据过期时消息流
   * 一直开着，状态永远停在 `live`。有它才知道该显示重开的入口。
   */
  lastError: string | null;
  busy: boolean;
  /**
   * 还有几条子 agent 支线在后台跑（§3.4）。
   *
   * **与 `busy` 分开**：`result` 一到主线就不忙了，而支线默认就在后台跑，那一刻很可能
   * 还有一条在查。合成一个的话，界面要么把"只剩支线"说成主线在跑（停止按钮跟着冒出来，
   * 而它中断的是一轮已经收完的 turn），要么把它说成空闲——正是这一条要防的。
   */
  backgroundLanes: number;
  /**
   * 还没收尾的那几条泳道（值是 `StepNode.lane`）。**与 `backgroundLanes` 是两个来源**：
   * 电平由 backend 推，只说得出"还有几条"；这一份按 hook 侧的 `agent_id` 认，说得出
   * "是哪几条"，也只有它认得出停一条要用的 `task_id`。UI 只给这里面的泳道显示「停」。
   */
  liveLanes: string[];
  steps: StepNode[];
  incident: IncidentEntry[];
  pending: PendingAsk[];
  gates: PendingGate[];
  chat: ChatLine[];
  /**
   * 定稿还差哪几步（§6.2）。**放快照里而不是等点了定稿再问**：
   * 「还差影响面」是排查中途就该看得见的进度，不是按钮弹出来的一句错误。
   */
  closingGaps: ClosingStepKind[];
  /** 定稿确认条的预选形态。排查已冻结时它没有意义——那时看 `case.verdictShape`。 */
  shapeSuggestion: ShapeSuggestion;
  /**
   * 报告那几栏的投影。**装的是「哪一步算数」的答案，不是原料**：
   * 挑根因的选择器只有 `queries.reportSections()` 那一条，renderer 不再挑第二次
   * （另起一条的后果见 `data-model.md`：报告的结构与内容会指着两条不同的根因）。
   * 章节怎么组装则在 `shared/report.ts`，报告屏与两种导出共用。
   */
  report: {
    rootCause: { stepId: string; text: string; confidence: number | null } | null;
    impact: string | null;
    /**
     * 修复建议：四栏里唯一由 agent 生成、没有投影来源的那一块（overview §6.1）。
     * 取的是**最新一条仍然成立的声明**，不跟着根因走——未决型与归档的半程报告没有根因，
     * 而它们恰恰最该留下"下一步该怎么查"。选择器只有 `queries.effectiveRemediation` 一条。
     */
    remediation: string | null;
    /**
     * 状态型报告的主体（D25）：应然与实然的一对。挂在根因那一步上，
     * 所以根因被推翻时它跟着一起失效，不会留下一段没有出处的对照。
     */
    expected: string | null;
    actual: string | null;
    leftovers: ReportStepRef[];
    refuted: ReportStepRef[];
  };
};

/**
 * Markdown 导出的结果（D26 / ui.md §7.1）。
 *
 * **失败必须分得出是哪一种**：取消是人自己按的，其余两种是这次导出没成——
 * 只回一个 boolean 的话，界面对"取消"和"写盘失败"只能给同一句话，
 * 而后者意味着报告压根没落地，人却以为自己刚刚存下了它。
 */
export type ExportResult =
  /**
   * `pages` 只有长图用得上（>1 时界面要说清共几张，否则人只看到第一张的路径）。
   *
   * `stale` 是**顶着同一个名字、这次却没被覆盖到的旧文件**：单页落 `<target>`、
   * 多页落 `<target>-1…N`，页数一变，上一次的产物就原样留在旁边，看起来像是这次导出的。
   * 只报不删——保存框只问过用户那一个名字，别的那些是不是他自己的文件，main 这儿不知道。
   */
  | { ok: true; path: string; pages?: number; stale?: string[] }
  | { ok: false; reason: 'canceled' }
  | { ok: false; reason: 'no-case' | 'failed'; error: string };

/**
 * 长图渲染视图（`?export=image`）要的东西。**由 main 备好一份交过去**，
 * 不让那一屏自己去查快照：它是离屏开的，等它开起来时当前排查可能已经切走了，
 * 而导出的产物与文件名会因此指着两个排查。
 *
 * `generatedAt` 同 Markdown 那条由调用方给：渲染侧读时钟的话同一次排查导两次的产物不同。
 */
export type ExportPayload = { input: ReportInput; generatedAt: string };

export type OperatorReply = { id: string; statement: string; answer: string; executedAt?: string };

export const EMPTY_SNAPSHOT: Snapshot = {
  case: null,
  cases: [],
  sessionStatus: 'idle',
  takeover: false,
  lastError: null,
  busy: false,
  backgroundLanes: 0,
  liveLanes: [],
  steps: [],
  incident: [],
  pending: [],
  gates: [],
  chat: [],
  closingGaps: [],
  shapeSuggestion: { shape: 'open', source: 'inferred', rootStepId: null, stateFillable: false },
  report: {
    rootCause: null,
    impact: null,
    remediation: null,
    expected: null,
    actual: null,
    leftovers: [],
    refuted: [],
  },
};

/**
 * 接管切没切成，以及没切成时是哪一种。**几种失败的下一步动作各不相同，不能合成一个 false**：
 *
 * - `gone`：状态冲突（切了排查 / 已收尾）。排查不在手上，切回去再点一次就行
 * - `failed`：这一轮维持原样。要么 backend 的权限模式没切动，要么切动了但落不了库、
 *   已经切回来了——两种都是"什么都没变"，人必须知道自己**没有**拿到想要的那一档，
 *   否则会拿一个并不存在的保护继续查下去
 * - `unsaved`：**会话确实切过去了，但只活到下次重启**。落库失败且连回滚都失败时才有它——
 *   说成 `failed` 的话人会再按一次（这一次会把它切回去），说成 `ok` 的话重开 app 它自己就没了
 */
export type TakeoverResult = 'ok' | 'gone' | 'failed' | 'unsaved';

export type InquestryApi = {
  envCheck(): Promise<{ claude: string | null; hint: string }>;
  intakeOptions(): Promise<IntakeOptions>;
  /** 打开系统目录选择器；用户取消返回 null。 */
  pickProjectRoot(): Promise<string | null>;
  createCase(draft: IntakeDraft): Promise<IntakeResult>;
  /** 切到另一次排查。**不中断任何一个**：main 持有全部运行时，这里只是换个投影看。 */
  switchCase(caseId: string): Promise<void>;
  /** 去新建排查面板开新排查；当前排查照旧在后台跑。 */
  newCase(): Promise<void>;
  /**
   * 跨 case 检索（D28 / [data-model](data-model.md) §5）。空串回空数组，不回"全部"——
   * 清空输入框该是回到最近列表那条路，不是搜出一屏。
   *
   * **不走快照**：它是人打字驱动的一次性查询，塞进 60ms 一轮的全量快照里
   * 等于每次推送都跑一遍全库检索，而结果只有输入框还开着的时候有人看。
   */
  searchCases(term: string): Promise<CaseHit[]>;
  /**
   * 下面这四个都要带上**这一屏看到的 caseId**。
   *
   * 切排查那一瞬 main 那边当时就换了当前排查，而这一屏要等下一次快照（最多 60ms）才换——
   * 不带的话，在排查 A 里按下的发送/停止会落到排查 B 头上。对不上就不执行。
   */
  start(caseId: string, question?: string): Promise<void>;
  /** 收掉当前会话再起一轮。会话卡在 `live` 却每轮都失败时，这是唯一出路。 */
  restart(caseId: string): Promise<void>;
  /**
   * 开 / 关接管模式（overview §3.5）：开着时每次调用都过闸门，由人当场放行 / 改写 / 拒绝。
   * 回执是切没切成——冻结的排查切不了，静默 return 会让开关在界面上翻过去却什么都没做。
   */
  setTakeover(caseId: string, on: boolean): Promise<TakeoverResult>;
  /** 返回是否真的送出去了；没送出去 renderer 要把草稿留着。 */
  send(caseId: string, text: string): Promise<boolean>;
  /** 收尾三档（D29 / ui.md §8.4）。三个动作各有各的后果，不能合成一个「结束」。 */
  interrupt(caseId: string): Promise<void>;
  /**
   * 停掉一条还在跑的支线（§3.4）。**只停那一条**，主线与别的支线照旧跑。
   * 回执是请求发出去了没有：已经跑完的支线停不掉，那不是故障，但按钮得有回音。
   */
  stopLane(caseId: string, lane: string): Promise<boolean>;
  /**
   * 问「现在还差哪几步」，缺了就顺手派给 agent。**不执行任何收尾**——
   * 点「定稿」先走这条，拿到空缺口才弹确认条，于是快照过期也绕不过那道确认。
   */
  requestClosing(caseId: string): Promise<ClosingRequest | null>;
  /**
   * 定稿：**执行且不可逆**，只该由确认按钮调。仍会再校验一次强制 step。
   *
   * `shape` 与 caseId 同理，取的是**确认条弹出时**那一份：它决定报告装哪几块，
   * 是人在确认条上看着后果按下去的那个选择，不该被这中间到的新快照换掉。
   */
  closeCase(caseId: string, shape: VerdictShape): Promise<ClosingOutcome>;
  /** 归档：同「停止」，外加标记放弃。证据一条不销毁，半程报告照旧能导。回执是执行了没有。 */
  archiveCase(caseId: string): Promise<boolean>;
  /**
   * 待办的两个处置同样要带 caseId，理由同上；回执是**处置成功了没有**。
   * 丢掉一次闸门判决的后果比丢一条消息重：人按了拒绝却没落地，三分钟后它会自动放行。
   */
  answerOperator(caseId: string, reply: OperatorReply): Promise<boolean>;
  decideGate(caseId: string, decision: GateDecision): Promise<boolean>;
  excerpt(callId: string, anchor: string | null): Promise<string>;
  /**
   * 导出 Markdown（D26）。**带 caseId 同上**：导出的是一份要交出去的文档，
   * 落到别的排查头上会得到一个文件名与内容对不上、且没人会察觉的产物。
   *
   * 章节由 `shared/report.ts` 组装、`shared/markdown.ts` 渲染，与报告屏同一份。
   */
  exportMarkdown(caseId: string): Promise<ExportResult>;
  /**
   * 导出长图（D26 的后一半 / ui.md §7.2）。同吃 `reportPlan()`，只是换个渲染目标。
   * 超长时按顶层小节切成几张，`pages` 会说共几张。
   */
  exportImage(caseId: string): Promise<ExportResult>;
  /**
   * 长图那个离屏视图取自己要渲染的东西。**只有它会调**：token 由 main 现给现收，
   * 对不上就是 null——正常界面拿不到 token，也就取不走别人的快照。
   */
  exportPayload(token: string): Promise<ExportPayload | null>;
  snapshot(): Promise<Snapshot>;
  onSnapshot(cb: (s: Snapshot) => void): () => void;

  /**
   * 历史排查页的分页列表。**与快照里那份 `cases` 是两条路**：那一份是最近 20 条 + 钉住的，
   * 每 60ms 推一次；这一份是人翻页翻出来的，带筛选、带工作区与结论摘要。
   */
  listCases(q: CaseListQuery): Promise<CaseListPage>;
  /** 应用级设置。回的是**归一化之后**那一份——夹逼过的值才是真正生效的那个。 */
  getSettings(): Promise<UiSettings>;
  /**
   * 存设置。回的同样是归一化之后的整份，界面直接认它：
   * 只回 ok 的话，人填了个越界的数字，屏幕上留着他填的、实际生效的是夹过的，
   * 而这个差别一个字都不会显示出来。
   */
  putSettings(patch: UiSettings): Promise<UiSettings>;
  appInfo(): Promise<AppInfo>;
  /** 在访达里定位数据库文件。 */
  revealDb(): Promise<void>;
  /** 用系统浏览器开链接。**只认 https**，别的一律不开。 */
  openExternal(url: string): Promise<void>;
};
