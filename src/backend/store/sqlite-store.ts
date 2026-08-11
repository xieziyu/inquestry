/**
 * InvestigationStore 的 SQLite 实现 —— 把三个工具接到 events → 投影这条链上。
 *
 * 每次写入都是「append 事件 + 同事务 apply 投影」，与重放路径共用 applyEvent。
 */

import type { Db } from '../db/database.js';
import type { DomainEvent } from '../db/events.js';
import { applyEvent, type ProjectorDeps } from '../db/projector.js';
import { locateEvidence, readBlobText, storeBlob } from '../db/blobs.js';
import type { InvestigationStore } from '../tools/definitions.js';
import type { AskOperatorArgs, CloseStepArgs, OpenStepArgs } from '../tools/schemas.js';

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

export type InvestigationSession = {
  store: InvestigationStore;
  /** 案子的立案单。已存在的 case 以库里那份为准，不被本次调用方覆盖。 */
  intake: CaseIntake;
  /** 由 PreToolUse hook 调用：把任意工具调用归属到当前 open 的 step 上。 */
  recordToolStart(input: { callId: string; toolName: string; input: unknown; agentId?: string }): {
    callNumber: number;
    stepId: string;
  };
  /** 由 PostToolUse hook 调用：原始输出落 blob，只把 sha256 进库。 */
  recordToolEnd(input: { callId: string; output: string; failed?: boolean }): void;
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

    recordToolStart({ callId, toolName, input, agentId }) {
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
          input: JSON.stringify(input ?? {}),
          inputRewritten: false,
          gateDecision: 'auto',
          at: ctx.now(),
        },
      });
      return { callNumber: before.c + 1, stepId };
    },

    recordToolEnd({ callId, output, failed }) {
      const blob = storeBlob(ctx.blobDir, output);
      emit({ type: 'blob.stored', payload: { ...blob, at: ctx.now() } });
      emit({
        type: 'toolcall.completed',
        payload: {
          callId,
          outputSha256: blob.sha256,
          status: failed ? 'failed' : 'done',
          at: ctx.now(),
        },
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
