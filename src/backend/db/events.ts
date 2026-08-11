/**
 * 领域事件面。
 *
 * **命名不带 backend 词汇**（D20 纪律 4）：是 `ToolCallStarted` 不是 `PreToolUseEvent`。
 * 事件名 → 载荷的映射是单一来源，projector 用 never 哨兵收敛，漏接一个编译期就报。
 *
 * 载荷里**不能有任何在 apply 时才算出来的值**（序号、id、时间戳都要在发事件前定好），
 * 否则重放结果与原始写入不一致，`events` 也就不再是真相。
 */

export type DomainEvents = {
  /** 立案单（D27）。基准日与时区是必填：没有它们事故时间线排不出来。 */
  'case.opened': {
    caseId: string;
    title: string;
    question: string;
    projectRoot: string | null;
    incidentDate: string;
    tzOffset: string;
    clues: string | null;
    at: number;
  };
  'session.started': {
    sessionId: string;
    caseId: string;
    backend: 'claude' | 'codex';
    nativeSessionRef?: string;
    model?: string;
    effort?: string;
    at: number;
  };
  'session.ended': { sessionId: string; status: 'ended' | 'crashed'; at: number };

  'step.opened': {
    stepId: string;
    sessionId: string;
    ordinal: number;
    kind: 'normal' | 'unclassified' | 'impact' | 'leftover';
    direction: string | null;
    parentStepId?: string;
    lane?: string;
    at: number;
  };
  'step.closed': {
    stepId: string;
    status: 'confirmed' | 'refuted' | 'inconclusive';
    verdict: string;
    confidence: number;
    at: number;
  };
  'step.superseded': { stepId: string; by: string };

  'blob.stored': { sha256: string; size: number; mime: string; lineCount: number; at: number };

  'toolcall.started': {
    callId: string;
    sessionId: string;
    stepId: string;
    agentId?: string;
    toolName: string;
    origin: 'agent' | 'operator';
    input: string;
    inputRewritten: boolean;
    gateDecision: 'auto' | 'allow' | 'rewrite' | 'deny' | 'timeout';
    at: number;
  };
  /**
   * 闸门的处置（ui.md §8.2）。与 `toolcall.started` 分开是因为两者到达顺序不保证：
   * PreToolUse 与 canUseTool 谁先谁后由 backend 决定，先到的那个不该等另一个。
   *
   * deny 的留话不在这里 —— 它就是 agent 真正收到的工具结果，走 `toolcall.completed` 的 blob。
   */
  'toolcall.gated': {
    callId: string;
    decision: 'allow' | 'rewrite' | 'deny' | 'timeout';
    /** 改写后的参数，rewrite 才有。 */
    input?: string;
    at: number;
  };
  'toolcall.completed': {
    callId: string;
    outputSha256: string | null;
    status: 'done' | 'failed' | 'denied' | 'abandoned';
    at: number;
  };

  'evidence.attached': {
    evidenceId: string;
    stepId: string;
    callId: string;
    anchorKind: 'lines' | 'jsonpath' | 'whole';
    anchor: string | null;
    anchorResolved: string | null;
    claim: string;
    observedAt: number;
    occurredAtMs: number | null;
    occurredAtRaw: string | null;
    occurredSource: 'auto' | 'operator' | 'agent';
    actor: string | null;
  };
};

export type EventName = keyof DomainEvents;
export type DomainEvent<K extends EventName = EventName> = {
  [N in K]: { type: N; payload: DomainEvents[N] };
}[K];
