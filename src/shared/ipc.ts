/**
 * main ↔ renderer 的契约。
 *
 * **这里只有领域类型，不出现任何 backend / SDK 类型**（D20 纪律 2）：
 * renderer 不该知道背后跑的是 Claude 还是 codex。
 */

export type CallNode = {
  id: string;
  callNumber: number;
  toolName: string;
  origin: 'agent' | 'operator';
  status: string;
  input: string;
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

export type ChatLine = { role: 'user' | 'assistant' | 'system'; text: string; at: number };

export type Snapshot = {
  caseTitle: string | null;
  sessionStatus: 'idle' | 'live' | 'ended' | 'crashed';
  busy: boolean;
  steps: StepNode[];
  incident: IncidentEntry[];
  pending: PendingAsk[];
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
  caseTitle: null,
  sessionStatus: 'idle',
  busy: false,
  steps: [],
  incident: [],
  pending: [],
  chat: [],
  report: { rootCause: null, impact: null, leftovers: 0, refuted: 0 },
};

export type InquestryApi = {
  start(question: string): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  answerOperator(reply: OperatorReply): Promise<void>;
  excerpt(callId: string, anchor: string | null): Promise<string>;
  snapshot(): Promise<Snapshot>;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
};
