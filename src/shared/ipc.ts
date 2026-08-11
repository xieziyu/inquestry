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
  report: {
    rootCause: string | null;
    impact: string | null;
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
  report: { rootCause: null, impact: null, leftovers: 0, refuted: 0 },
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
  interrupt(caseId: string): Promise<void>;
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
