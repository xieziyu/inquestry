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

/** 案件切换栏的一行（D28 的载体，第 3 项才会用满）。 */
export type CaseBrief = {
  id: string;
  title: string;
  status: 'open' | 'closed' | 'aborted';
  updatedAt: number;
  current: boolean;
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
  ordinal: number;
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
  sessionStatus: 'idle' | 'live' | 'ended' | 'crashed';
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
  sessionStatus: 'idle',
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
  start(question?: string): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  answerOperator(reply: OperatorReply): Promise<void>;
  decideGate(decision: GateDecision): Promise<void>;
  excerpt(callId: string, anchor: string | null): Promise<string>;
  snapshot(): Promise<Snapshot>;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
};
