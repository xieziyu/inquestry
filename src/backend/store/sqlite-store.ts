/**
 * InvestigationStore 的 SQLite 实现 —— 把三个工具接到 events → 投影这条链上。
 *
 * 每次写入都是「append 事件 + 同事务 apply 投影」，与重放路径共用 applyEvent。
 */

import type { Db } from '../db/database.js';
import type { DomainEvent } from '../db/events.js';
import { applyEvent, type ProjectorDeps } from '../db/projector.js';
import { effectiveStep } from '../db/queries.js';
import { locateEvidence, readBlobText, storeBlob } from '../db/blobs.js';
import type { InvestigationStore } from '../tools/definitions.js';
import type { AskOperatorArgs, CloseStepArgs, OpenStepArgs } from '../tools/schemas.js';
import type { ClosingStepKind } from '../../shared/ipc.js';

export type SessionContext = {
  caseId: string;
  sessionId: string;
  backend: 'claude' | 'codex';
  blobDir: string;
  /** 落 sessions 而非 cases（D27）：一个案子跨多会话，中途换模型是常态。 */
  model?: string | null;
  effort?: string | null;
  /** 哪些工具的输出自带时间戳 —— 决定 occurredAt 强制到什么程度（tools.md §3）。 */
  isTimestampedSource: (toolName: string) => boolean;
  now: () => number;
  newId: (prefix: string) => string;
  /** 人工回填的执行入口。UI 上是那个 pending 节点，spike 里是个假操作员。 */
  runOperator: (args: AskOperatorArgs) => Promise<{ answer: string; statement: string; executedAt?: string }>;
};

/**
 * 立案单（ui.md §8.1）。
 *
 * `incidentDate` / `tzOffset` 是硬字段不是可选线索：日志里常常只有 `12:03:01.220`
 * 这种既无日期也无时区的时间串，没有基准日 occurredAt 就落不成绝对时刻，
 * 事故时间线也就排不出来。
 */
export type CaseIntake = {
  title: string;
  question: string;
  projectRoot: string | null;
  incidentDate: string;
  tzOffset: string;
  clues: string | null;
};

/** 时间基准的最小切面：解析日志时间串只需要这两项。 */
export type TimeBase = Pick<CaseIntake, 'incidentDate' | 'tzOffset'>;

/** 闸门给出的处置。`input` 只有 rewrite 用得上，`message` 只有 deny 用得上。 */
export type GateOutcome = {
  decision: 'allow' | 'rewrite' | 'deny' | 'timeout';
  input?: string;
  message?: string;
};

export type InvestigationSession = {
  store: InvestigationStore;
  /** 案子的立案单。已存在的 case 以库里那份为准，不被本次调用方覆盖。 */
  intake: CaseIntake;
  /** 由 PreToolUse hook 调用：把任意工具调用归属到当前 open 的 step 上。 */
  recordToolStart(input: {
    callId: string;
    toolName: string;
    input: unknown;
    agentId?: string;
    /** 闸门先于 PreToolUse 落定时，判决直接写进 started，不必再补一条 gated。 */
    gate?: GateOutcome;
  }): { callNumber: number; stepId: string };
  /** 闸门后于 PreToolUse 落定时补记判决。 */
  recordGate(input: { callId: string; gate: GateOutcome }): void;
  /** 由 PostToolUse hook 调用：原始输出落 blob，只把 sha256 进库。 */
  recordToolEnd(input: {
    callId: string;
    output: string;
    status?: 'done' | 'failed' | 'denied' | 'abandoned';
  }): void;
  /** 这个 callId 有没有落过库 —— 闸门用它判断该补记还是该等 started 带上判决。 */
  hasToolCall(callId: string): boolean;
  endSession(status?: 'ended' | 'crashed'): void;
};

type CaseContext = Pick<SessionContext, 'caseId' | 'blobDir'> & { now: () => number };

/**
 * 立案：case 只开一次（overview §4.1）。
 *
 * **与开会话分开**，因为两者的时机不同：立案是人点「立案」那一刻，
 * 开会话是真的要跑第一轮的时候。合在一起会让"打开 app 看一眼"也留下一个空 session。
 *
 * 返回生效的立案单——已存在的 case 以库里那份为准：基准日一旦变过，
 * 已落库的 occurred_at_ms 就对不上了。
 */
export function openCase(db: Db, ctx: CaseContext, intake: CaseIntake): CaseIntake {
  if (!db.prepare(`SELECT 1 FROM cases WHERE id=?`).get(ctx.caseId)) {
    emitTo(db, ctx, null, { type: 'case.opened', payload: { caseId: ctx.caseId, ...intake, at: ctx.now() } });
  }
  return readIntake(db, ctx.caseId) ?? intake;
}

/**
 * 收尾三档里改状态的那两档（D29）。
 *
 * 走事件而不是 `UPDATE cases`：重放时 `case.opened` 会把 status 写回 `open`，
 * 直接改的库值一重建投影就没了，而且没有任何报错。
 */
export function setCaseStatus(db: Db, ctx: CaseContext, status: CaseStatus): void {
  if (readCaseStatus(db, ctx.caseId) === status) return;
  emitTo(db, ctx, null, {
    type: 'case.status_changed',
    payload: { caseId: ctx.caseId, status, at: ctx.now() },
  });
}

export type CaseStatus = 'open' | 'closed' | 'aborted';

export function readCaseStatus(db: Db, caseId: string): CaseStatus | null {
  const row = db.prepare(`SELECT status FROM cases WHERE id=?`).get(caseId) as
    | { status: CaseStatus }
    | undefined;
  return row?.status ?? null;
}

/**
 * 结案前必须走完的两步（overview §6.2）：影响面要量化，遗留疑点必须明写。
 * 取值本身是 renderer 也要认的契约，所以类型在 `shared/ipc` 里，这里只给清单。
 */
export const CLOSING_STEP_KINDS: readonly ClosingStepKind[] = ['impact', 'leftover'];

/**
 * 还差哪几步才能结案。
 *
 * 判的是**当前生效的那一步**（`effectiveStep`），不是"历史上出现过没有"：
 *
 * - 只问"有没有一条收好的 impact"的话，agent 收好一条之后又新开一条打算重做、还没 close，
 *   这里照样放行——而报告取的是最新那条，于是影响面栏是空的。结案校验与报告章节
 *   必须共用同一条"哪一步算数"的规则，否则两边各说各话
 * - 已被推翻的一律不算数：结论被明确否掉了。被同类的新 step 顶掉时新的自然接上，
 *   漏的是被**别的 kind** 推翻那种——章节看着齐全，报告那栏却是一份作废的影响面
 */
export function missingClosingSteps(db: Db, caseId: string): ClosingStepKind[] {
  return CLOSING_STEP_KINDS.filter((kind) => {
    const step = effectiveStep(db, caseId, kind);
    return !step || step.status === 'open';
  });
}

/**
 * 上一个进程留下的僵尸行（D29 / data-model.md §4）。**只在启动、任何 runner 建起来之前跑**：
 * 那一刻库里所有 `pending` 的调用与所有 `live` 的会话都必然是上次残留的。
 *
 * 不扫的话它们会一直挂在那儿：轨道上是永远「进行中」的调用，报告里数出来的
 * 「跑过多少次」也永远多几笔——而它们其实一次都没跑完。
 *
 * 同样走事件，理由同 `setCaseStatus`。
 */
export function sweepZombies(
  db: Db,
  opts: { blobDir: string; now: () => number },
): { calls: number; sessions: number } {
  const calls = db
    .prepare(
      `SELECT tc.id, se.case_id, tc.session_id FROM tool_calls tc
       JOIN sessions se ON se.id = tc.session_id WHERE tc.status='pending'`,
    )
    .all() as { id: string; case_id: string; session_id: string }[];
  const sessions = db
    .prepare(`SELECT id, case_id FROM sessions WHERE status='live'`)
    .all() as { id: string; case_id: string }[];

  for (const c of calls) {
    const ctx: CaseContext = { caseId: c.case_id, blobDir: opts.blobDir, now: opts.now };
    // 与人按停止散掉的那些记成同一档：它连"该不该跑"都没被问到，不是工具坏了
    const blob = storeBlob(opts.blobDir, '(已放弃) 上一次运行没有跑完这次调用。');
    emitTo(db, ctx, c.session_id, { type: 'blob.stored', payload: { ...blob, at: opts.now() } });
    emitTo(db, ctx, c.session_id, {
      type: 'toolcall.completed',
      payload: { callId: c.id, outputSha256: blob.sha256, status: 'abandoned', at: opts.now() },
    });
  }
  for (const s of sessions) {
    const ctx: CaseContext = { caseId: s.case_id, blobDir: opts.blobDir, now: opts.now };
    emitTo(db, ctx, s.id, {
      type: 'session.ended',
      payload: { sessionId: s.id, status: 'crashed', at: opts.now() },
    });
  }
  return { calls: calls.length, sessions: sessions.length };
}

function emitTo(db: Db, ctx: CaseContext, sessionId: string | null, ev: DomainEvent) {
  const deps: ProjectorDeps = { blobDir: ctx.blobDir, caseId: ctx.caseId };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO events (case_id,session_id,type,payload,created_at) VALUES (?,?,?,?,?)`,
    ).run(ctx.caseId, sessionId, ev.type, JSON.stringify(ev.payload), ctx.now());
    applyEvent(db, ev, deps);
  })();
}

export function createInvestigationSession(
  db: Db,
  ctx: SessionContext,
  opts: CaseIntake,
): InvestigationSession {
  const emit = (ev: DomainEvent) => emitTo(db, ctx, ctx.sessionId, ev);

  const intake = openCase(db, ctx, opts);

  emit({
    type: 'session.started',
    payload: {
      sessionId: ctx.sessionId,
      caseId: ctx.caseId,
      backend: ctx.backend,
      model: ctx.model ?? undefined,
      effort: ctx.effort ?? undefined,
      at: ctx.now(),
    },
  });

  /** 没有 open step 时的兜底节点（overview §4.4）：工具调用不能丢。 */
  function ensureStep(): string {
    const open = db
      .prepare(`SELECT id FROM steps WHERE session_id=? AND status='open' ORDER BY ordinal DESC LIMIT 1`)
      .get(ctx.sessionId) as { id: string } | undefined;
    if (open) return open.id;
    const id = ctx.newId('st');
    emit({
      type: 'step.opened',
      payload: {
        stepId: id,
        sessionId: ctx.sessionId,
        ordinal: nextOrdinal(),
        kind: 'unclassified',
        direction: null,
        at: ctx.now(),
      },
    });
    return id;
  }

  const nextOrdinal = () =>
    ((db.prepare(`SELECT MAX(ordinal) m FROM steps WHERE session_id=?`).get(ctx.sessionId) as { m: number | null })
      .m ?? 0) + 1;

  /** `#N` → callId：按 step 内 started_at 顺序取第 N 个，不依赖内存状态，重启后照样解析。 */
  function resolveCallRef(stepId: string, ref: string) {
    const n = Number(String(ref).match(/\d+/)?.[0] ?? NaN);
    if (!Number.isFinite(n)) return undefined;
    return db
      .prepare(
        `SELECT tc.id, tc.tool_name, tc.output_sha256, b.line_count
         FROM tool_calls tc LEFT JOIN blobs b ON b.sha256 = tc.output_sha256
         WHERE tc.step_id=? ORDER BY tc.started_at, tc.rowid LIMIT 1 OFFSET ?`,
      )
      .get(stepId, n - 1) as
      | { id: string; tool_name: string; output_sha256: string | null; line_count: number | null }
      | undefined;
  }

  const store: InvestigationStore = {
    async openStep(args: OpenStepArgs) {
      const stepId = ctx.newId('st');
      const ordinal = nextOrdinal();
      emit({
        type: 'step.opened',
        payload: {
          stepId,
          sessionId: ctx.sessionId,
          ordinal,
          kind: args.kind ?? 'normal',
          direction: args.direction,
          parentStepId: args.parentStepId,
          at: ctx.now(),
        },
      });
      return { stepId, ordinal };
    },

    async closeStep(args: CloseStepArgs) {
      const warnings: string[] = [];
      const step = db.prepare(`SELECT id FROM steps WHERE id=?`).get(args.stepId) as { id: string } | undefined;
      if (!step) return { warnings: [`未知 stepId ${args.stepId}`] };

      if (args.status !== 'inconclusive' && args.evidence.length === 0) {
        warnings.push('这个结论没有任何证据，无法被复核。请补 evidence 后重新 close。');
      }

      for (const e of args.evidence) {
        const call = resolveCallRef(args.stepId, e.callRef);
        if (!call) {
          warnings.push(`callRef ${e.callRef} 在本 step 内不存在。`);
          continue;
        }
        const occurred = parseOccurredAt(e.occurredAt, intake);
        // 只有「自带时间戳的数据源 + 本次确实有命中」才强制 occurredAt：
        // 一刀切会逼 agent 拿查询执行时间凑数，假时间直接进报告主体（tools.md §3）
        const hasHits = (call.line_count ?? 0) > 1;
        if (ctx.isTimestampedSource(call.tool_name) && hasHits && !occurred.ms) {
          warnings.push(
            e.occurredAt
              ? `证据「${e.claim.slice(0, 16)}…」的 occurredAt "${e.occurredAt}" 解析不了。`
              : `证据「${e.claim.slice(0, 16)}…」来自 ${call.tool_name} 却缺 occurredAt，事故时间线会断在这里。`,
          );
        }
        // 行号只是提示：工具输出常自带另一套编号，直接按物理行高亮会悄悄指错行（blobs.ts）
        const blobText = call.output_sha256 ? readBlobText(ctx.blobDir, call.output_sha256) : null;
        const located = blobText ? locateEvidence(blobText, e.anchor, e.occurredAt) : null;
        if (located?.corrected) {
          warnings.push(`证据「${e.claim.slice(0, 16)}…」的行号已按内容校正为 ${located.anchor}。`);
        }

        emit({
          type: 'evidence.attached',
          payload: {
            evidenceId: ctx.newId('ev'),
            stepId: args.stepId,
            callId: call.id,
            anchorKind: anchorKind(e.anchor),
            anchor: e.anchor ?? null,
            anchorResolved: located?.anchor ?? e.anchor ?? null,
            claim: e.claim,
            observedAt: ctx.now(),
            occurredAtMs: occurred.ms,
            occurredAtRaw: e.occurredAt ?? null,
            occurredSource: call.tool_name.includes('ask_operator') ? 'operator' : 'agent',
            actor: e.actor ?? null,
          },
        });
      }

      emit({
        type: 'step.closed',
        payload: {
          stepId: args.stepId,
          status: args.status,
          verdict: args.verdict,
          confidence: args.confidence,
          at: ctx.now(),
        },
      });
      for (const sid of args.supersedes ?? []) {
        emit({ type: 'step.superseded', payload: { stepId: sid, by: args.stepId } });
      }
      return { warnings };
    },

    async askOperator(args: AskOperatorArgs) {
      return ctx.runOperator(args);
    },
  };

  return {
    store,
    intake,

    recordToolStart({ callId, toolName, input, agentId, gate }) {
      const stepId = ensureStep();
      const before = db
        .prepare(`SELECT COUNT(*) c FROM tool_calls WHERE step_id=?`)
        .get(stepId) as { c: number };
      emit({
        type: 'toolcall.started',
        payload: {
          callId,
          sessionId: ctx.sessionId,
          stepId,
          agentId,
          toolName,
          origin: toolName.includes('ask_operator') ? 'operator' : 'agent',
          input: gate?.input ?? JSON.stringify(input ?? {}),
          inputRewritten: gate?.decision === 'rewrite',
          gateDecision: gate?.decision ?? 'auto',
          at: ctx.now(),
        },
      });
      return { callNumber: before.c + 1, stepId };
    },

    recordGate({ callId, gate }) {
      emit({
        type: 'toolcall.gated',
        payload: { callId, decision: gate.decision, input: gate.input, at: ctx.now() },
      });
    },

    hasToolCall(callId) {
      return !!db.prepare(`SELECT 1 FROM tool_calls WHERE id=?`).get(callId);
    },

    recordToolEnd({ callId, output, status }) {
      const blob = storeBlob(ctx.blobDir, output);
      emit({ type: 'blob.stored', payload: { ...blob, at: ctx.now() } });
      emit({
        type: 'toolcall.completed',
        payload: { callId, outputSha256: blob.sha256, status: status ?? 'done', at: ctx.now() },
      });
    },

    endSession(status = 'ended') {
      emit({ type: 'session.ended', payload: { sessionId: ctx.sessionId, status, at: ctx.now() } });
    },
  };
}

export function readIntake(db: Db, caseId: string): CaseIntake | null {
  const row = db
    .prepare(
      `SELECT title, question, project_root, incident_date, tz_offset, clues FROM cases WHERE id=?`,
    )
    .get(caseId) as
    | {
        title: string;
        question: string | null;
        project_root: string | null;
        incident_date: string;
        tz_offset: string;
        clues: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    title: row.title,
    question: row.question ?? row.title,
    projectRoot: row.project_root,
    incidentDate: row.incident_date,
    tzOffset: row.tz_offset,
    clues: row.clues,
  };
}
function anchorKind(anchor?: string): 'lines' | 'jsonpath' | 'whole' {
  if (!anchor) return 'whole';
  if (anchor.trim().startsWith('$')) return 'jsonpath';
  return /\d/.test(anchor) ? 'lines' : 'whole';
}

/**
 * 日志时间串大多既无日期也无时区，必须靠 case 的基准日与时区补齐；
 * 原始串照样存进 `occurred_at_raw`，解析错了才有得回溯（data-model.md §2）。
 */
export function parseOccurredAt(raw: string | undefined, ctx: TimeBase) {
  if (!raw) return { ms: null };
  const s = raw.trim();
  const timeOnly = s.match(/^(\d{1,2}):(\d{2}):(\d{2})(\.\d{1,3})?$/);
  const candidate = timeOnly
    ? `${ctx.incidentDate}T${s.padStart(8, '0')}${ctx.tzOffset}`
    : /[zZ]|[+-]\d{2}:?\d{2}$/.test(s)
      ? s.replace(' ', 'T')
      : `${s.replace(' ', 'T')}${ctx.tzOffset}`;
  const ms = Date.parse(candidate);
  return { ms: Number.isNaN(ms) ? null : ms };
}
