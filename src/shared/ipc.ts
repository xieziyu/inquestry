/**
 * main ↔ renderer 的契约。
 *
 * **这里只有领域类型，不出现任何 backend / SDK 类型**（D20 纪律 2）：
 * renderer 不该知道背后跑的是 Claude 还是 codex。
 */

/**
 * 立案面板收集的东西（ui.md §8.1）。
 *
 * agent 三项与其余分开：前者落 `sessions`，后者落 `cases`（D27）。
 */
export type AgentChoice = {
  backend: 'claude' | 'codex';
  model: string | null;
  effort: string | null;
};

/**
 * 时区不在这里：它由 main 取立案机器的本机偏移，用户不填也改不了。
 * 因此本工具的前提是**日志时区 = 立案机器时区**——排查异地系统时这条会错，
 * 而且错法是整体偏移几小时，见 ui.md §8.1。
 */
export type IntakeDraft = {
  projectRoot: string | null;
  question: string;
  incidentDate: string;
  clues: string | null;
  agent: AgentChoice;
};

/** 立案的结果。失败要指明是哪个字段，否则面板只能给一句无处下手的错误。 */
export type IntakeResult = { ok: true } | { ok: false; field: 'projectRoot'; error: string };

export type ModelOption = {
  value: string;
  label: string;
  description: string;
  /** 不支持时整项隐藏，而不是给个假开关（D19）。 */
  efforts: string[];
};

/** 立案面板的可选项。model 一栏是真探测出来的，探测不到才退回内置列表。 */
export type IntakeOptions = {
  backends: { value: 'claude' | 'codex'; label: string; enabled: boolean; note?: string }[];
  models: ModelOption[];
  modelsProbed: boolean;
  recentRoots: string[];
  /** `tzOffset` 只用于显示"按哪个时区解释"，不是可编辑项。 */
  defaults: { incidentDate: string; tzOffset: string };
  /** 内置演示事故的预填。选它就是「不给项目起点」，玩具数据源才会挂上去。 */
  demo: { question: string; incidentDate: string };
};

/** 案件切换栏的一行（D28）。 */
export type CaseBrief = {
  id: string;
  title: string;
  status: 'open' | 'closed' | 'aborted';
  updatedAt: number;
  current: boolean;
  /**
   * 等你处理的条数。**跨 case 汇总的价值全在这一个字段上**：
   * 你在 A 案上工作时 B 案卡在 ask_operator 上等人，只在当前案子显示的话那条支线会静静挂死。
   */
  todos: number;
  /** 有一轮正在跑。 */
  running: boolean;
  /** main 里还持有它的运行时；false 表示只剩库里的历史，点开会新起一个 session。 */
  loaded: boolean;
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
   * 会话内序号，**不是案子内的**：一个案子跨多会话，重开一次它就从 1 重来。
   * 轨道上因此会出现两个 #1，得靠 `sessionIndex` 标出断点。
   */
  ordinal: number;
  sessionId: string;
  /** 这是本案子的第几次会话，从 1 起。 */
  sessionIndex: number;
  /**
   * 在哪一步之下细分（`open_step` 的可选入参）。轨道靠它把分叉往右缩进。
   * 认不得的父 id 在写入侧就归一成了 null 并回一条 warning（`parent_step_id` 上有外键，
   * 原样落库会直接炸），所以这里到手的要么是本案子里的真 step，要么就是 null。
   */
  parentStepId: string | null;
  kind: 'normal' | 'unclassified' | 'impact' | 'leftover';
  status: 'open' | 'confirmed' | 'refuted' | 'inconclusive' | 'superseded';
  direction: string | null;
  verdict: string | null;
  confidence: number | null;
  supersededBy: string | null;
  calls: CallNode[];
  evidence: EvidenceNode[];
};

export type IncidentEntry = {
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
  /** 数据源可以给个建议答案，UI 预填、人再改。演示数据源用它免去手敲。 */
  suggestedAnswer?: string;
};

/**
 * 卡在闸门上的一次调用（②档，ui.md §4）。
 *
 * 与 ①档 `PendingAsk` 的分别在于**不处理会怎样**：这一档到点按预设放行，
 * 所以有 `deadline`；①档故意没有，自动填个假结果比让人等着更糟。
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
  deadline: number;
};

/** 闸门的三个手势。改写与放行是一个动作的两种形态，拒绝必须留话——不留话 agent 不知道换什么。 */
export type GateDecision =
  | { id: string; action: 'allow' }
  | { id: string; action: 'rewrite'; input: string }
  | { id: string; action: 'deny'; message: string };

export type ChatLine = { role: 'user' | 'assistant' | 'system'; text: string; at: number };

/** 结案前的两个强制 step（overview §6.2）。 */
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
 * 结案确认条上的预选值。
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
 * 结案的结果。**不成立时要说清差什么**，否则界面只能给一句"还不能结案"，人无从下手。
 *
 * 与 `ClosingRequest` 分开是因为两者的语义天差地别：那个只问，这个**执行且不可逆**。
 * 合成一个的话，界面就得靠快照决定"这一下是问还是执行"——而快照是 60ms 合流推的，
 * 隔着这一拍，一次本以为"去补两步"的点击会直接把案子冻上，且完全没经过确认。
 */
export type ClosingOutcome =
  | { ok: true; status: 'open' | 'closed' | 'aborted' }
  | { ok: false; missing: ClosingStepKind[] };

/** 当前案子的立案单投影。为 null 表示还没立案，UI 该显示立案面板。 */
export type CaseMeta = {
  id: string;
  title: string;
  question: string;
  projectRoot: string | null;
  incidentDate: string;
  tzOffset: string;
  clues: string | null;
  agent: AgentChoice;
  /** 收尾三档（D29）。`closed` / `aborted` 都是冻结：开不了新会话，只能导出。 */
  status: 'open' | 'closed' | 'aborted';
  /**
   * 报告按哪种形态装（D25）。**收尾那一下才落**，在那之前是 null。
   * 归档一律是 `open`：残报告没有根因栏（ui.md §8.4）。
   */
  verdictShape: VerdictShape | null;
};

export type Snapshot = {
  case: CaseMeta | null;
  /** 所有案子，含别处的待办数。为 null 的 `case` 配非空 `cases` = 正在立新案，切换栏照常在。 */
  cases: CaseBrief[];
  sessionStatus: 'idle' | 'live' | 'ended' | 'crashed';
  /**
   * 最近一轮的失败原因。**会话可能仍是 `live` 却已经跑不动了**——凭据过期时消息流
   * 一直开着，状态永远停在 `live`。有它才知道该显示重开的入口。
   */
  lastError: string | null;
  busy: boolean;
  steps: StepNode[];
  incident: IncidentEntry[];
  pending: PendingAsk[];
  gates: PendingGate[];
  chat: ChatLine[];
  /**
   * 结案还差哪几步（§6.2）。**放快照里而不是等点了结案再问**：
   * 「还差影响面」是排查中途就该看得见的进度，不是按钮弹出来的一句错误。
   */
  closingGaps: ClosingStepKind[];
  /** 结案确认条的预选形态。案子已冻结时它没有意义——那时看 `case.verdictShape`。 */
  shapeSuggestion: ShapeSuggestion;
  report: {
    rootCause: string | null;
    impact: string | null;
    /**
     * 状态型报告的主体（D25）：应然与实然的一对。挂在根因那一步上，
     * 所以根因被推翻时它跟着一起失效，不会留下一段没有出处的对照。
     */
    expected: string | null;
    actual: string | null;
    leftovers: number;
    refuted: number;
  };
};

export type OperatorReply = { id: string; statement: string; answer: string; executedAt?: string };

export const EMPTY_SNAPSHOT: Snapshot = {
  case: null,
  cases: [],
  sessionStatus: 'idle',
  lastError: null,
  busy: false,
  steps: [],
  incident: [],
  pending: [],
  gates: [],
  chat: [],
  closingGaps: [],
  shapeSuggestion: { shape: 'open', source: 'inferred', rootStepId: null, stateFillable: false },
  report: { rootCause: null, impact: null, expected: null, actual: null, leftovers: 0, refuted: 0 },
};

export type InquestryApi = {
  envCheck(): Promise<{ claude: string | null; hint: string }>;
  intakeOptions(): Promise<IntakeOptions>;
  /** 打开系统目录选择器；用户取消返回 null。 */
  pickProjectRoot(): Promise<string | null>;
  createCase(draft: IntakeDraft): Promise<IntakeResult>;
  /** 切到另一个案子。**不中断任何一个**：main 持有全部运行时，这里只是换个投影看。 */
  switchCase(caseId: string): Promise<void>;
  /** 去立案面板开新案子；当前案子照旧在后台跑。 */
  newCase(): Promise<void>;
  /**
   * 下面这四个都要带上**这一屏看到的 caseId**。
   *
   * 切案子那一瞬 main 那边当时就换了当前案子，而这一屏要等下一次快照（最多 60ms）才换——
   * 不带的话，在 A 案里按下的发送/停止会落到 B 案头上。对不上就不执行。
   */
  start(caseId: string, question?: string): Promise<void>;
  /** 收掉当前会话再起一轮。会话卡在 `live` 却每轮都失败时，这是唯一出路。 */
  restart(caseId: string): Promise<void>;
  /** 返回是否真的送出去了；没送出去 renderer 要把草稿留着。 */
  send(caseId: string, text: string): Promise<boolean>;
  /** 收尾三档（D29 / ui.md §8.4）。三个动作各有各的后果，不能合成一个「结束」。 */
  interrupt(caseId: string): Promise<void>;
  /**
   * 问「现在还差哪几步」，缺了就顺手派给 agent。**不执行任何收尾**——
   * 点「结案」先走这条，拿到空缺口才弹确认条，于是快照过期也绕不过那道确认。
   */
  requestClosing(caseId: string): Promise<ClosingRequest | null>;
  /**
   * 结案：**执行且不可逆**，只该由确认按钮调。仍会再校验一次强制 step。
   *
   * `shape` 与 caseId 同理，取的是**确认条弹出时**那一份：它决定报告装哪几块，
   * 是人在确认条上看着后果按下去的那个选择，不该被这中间到的新快照换掉。
   */
  closeCase(caseId: string, shape: VerdictShape): Promise<ClosingOutcome>;
  /** 归档：同「停止」，外加标记放弃。证据一条不销毁，残报告照旧能导。回执是执行了没有。 */
  archiveCase(caseId: string): Promise<boolean>;
  /**
   * 待办的两个处置同样要带 caseId，理由同上；回执是**处置成功了没有**。
   * 丢掉一次闸门判决的后果比丢一条消息重：人按了拒绝却没落地，三分钟后它会自动放行。
   */
  answerOperator(caseId: string, reply: OperatorReply): Promise<boolean>;
  decideGate(caseId: string, decision: GateDecision): Promise<boolean>;
  excerpt(callId: string, anchor: string | null): Promise<string>;
  snapshot(): Promise<Snapshot>;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
};
