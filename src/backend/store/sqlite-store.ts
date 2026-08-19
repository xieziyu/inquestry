/**
 * InvestigationStore 的 SQLite 实现 —— 把三个工具接到 events → 投影这条链上。
 *
 * 每次写入都是「append 事件 + 同事务 apply 投影」，与重放路径共用 applyEvent。
 */

import { rmSync } from 'node:fs';
import path from 'node:path';

import type { Db } from '../db/database.js';
import type { DomainEvent } from '../db/events.js';
import { applyEvent, type ProjectorDeps } from '../db/projector.js';
import { effectiveStep, reportSections, timestampedEvidenceCount } from '../db/queries.js';
import { locateEvidence, readBlobText, storeBlob } from '../db/blobs.js';
import { isTimeOnly, parseOccurredAt, type TimeBase, type TimeBaseSource } from '../db/timebase.js';
import type { InvestigationStore } from '../tools/definitions.js';
import type { AskOperatorArgs, CloseStepArgs, OpenStepArgs } from '../tools/schemas.js';
import {
  VERDICT_SHAPES,
  type ClosingStepKind,
  type DeleteOutcome,
  type ShapeSuggestion,
  type VerdictShape,
} from '../../shared/ipc.js';
import { isRealDate } from '../../shared/time.js';

export type SessionContext = {
  caseId: string;
  sessionId: string;
  backend: 'claude' | 'codex';
  blobDir: string;
  /** 落 sessions 而非 cases（D27）：一次调查跨多会话，中途换模型是常态。 */
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
 * 建单信息（ui.md §8.1）。
 *
 * `incidentDate` / `tzOffset` 是硬字段不是可选背景：日志里常常只有 `12:03:01.220`
 * 这种既无日期也无时区的时间串，没有基准日期 occurredAt 就落不成绝对时刻，
 * 系统时间线也就排不出来。
 */
export type CaseIntake = {
  title: string;
  question: string;
  projectRoot: string | null;
  incidentDate: string;
  tzOffset: string;
  clues: string | null;
};


/** 闸门给出的处置。`input` 只有 rewrite 用得上，`message` 只有 deny 用得上。 */
export type GateOutcome = {
  decision: 'auto_deny' | 'allow' | 'rewrite' | 'deny' | 'timeout';
  input?: string;
  message?: string;
};

export type InvestigationSession = {
  store: InvestigationStore;
  /** 调查的建单信息。已存在的 case 以库里那份为准，不被本次调用方覆盖。 */
  intake: CaseIntake;
  /** 由 PreToolUse hook 调用：把任意工具调用归属到当前 open 的 step 上。 */
  recordToolStart(input: {
    callId: string;
    toolName: string;
    input: unknown;
    agentId?: string;
    /**
     * 这次调用属于哪条子 agent 泳道（overview §4.5），主线为空。
     * 由 `LaneBridge` 算出——**不能在这里按 agentId 猜**，两个键天生不同。
     */
    lane?: string;
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
  /** 对话带上添一句。**agent 的结论重建得出来，人当时说的话重建不出来**（`chat.appended`）。 */
  appendChat(input: { role: 'user' | 'assistant' | 'system'; text: string }): void;
  /**
   * 一条支线跑完，收口它的兜底步（data-model.md 的 `converged` 一节）。返回收的是哪一步，没有开着的步就返回 null。
   *
   * **收口的人只能是 harness**：支线自己开不了步也收不了步（PreToolUse 当场回绝），
   * 而主线拿不到那一步的 id。没有这一手，一条跑完的支线会永远停在「进行中」。
   */
  convergeLane(input: { lane: string; outcome: LaneOutcome; summary: string }): string | null;
  /**
   * 会话收尾时还开着的支线一并收口。**不做的话它们再没有人收得了**：
   * 消息流一关就不会再有 `task_notification`，那几步会一直显示成还在查，
   * 而它们所属的会话早就没了。
   */
  convergeOpenLanes(summary: string): number;
  endSession(status?: 'ended' | 'crashed'): void;
};

/** 支线是怎么结束的。`orphaned` 是会话先没的那种——不是支线自己跑完。 */
export type LaneOutcome = 'completed' | 'failed' | 'stopped' | 'orphaned';

type CaseContext = Pick<SessionContext, 'caseId' | 'blobDir'> & { now: () => number };

/**
 * 新建调查：case 只开一次（overview §4.1）。
 *
 * **与开会话分开**，因为两者的时机不同：新建调查是人点「新建调查」那一刻，
 * 开会话是真的要跑第一轮的时候。合在一起会让"打开 app 看一眼"也留下一个空 session。
 *
 * 返回生效的建单信息——已存在的 case 以库里那份为准，本次调用方给的那份不覆盖它：
 * 重开旧调查时按当天重算基准，会让这一轮的证据与上一轮错开一天。
 * 要改基准走 `setCaseTimebase`，它带着重算。
 */
export function openCase(db: Db, ctx: CaseContext, intake: CaseIntake): CaseIntake {
  if (!db.prepare(`SELECT 1 FROM cases WHERE id=?`).get(ctx.caseId)) {
    emitTo(db, ctx, null, { type: 'case.opened', payload: { caseId: ctx.caseId, ...intake, at: ctx.now() } });
  }
  return readIntake(db, ctx.caseId) ?? intake;
}

/**
 * 改标题。返回改没改成——同一句话再落一次是空操作，界面不必为此再推一轮快照。
 *
 * **标题不在建单信息里**：`openCase` 只在 case 不存在时发一次事件，之后不再碰那份 intake。
 * 标题却是要改的（建单兜底 → agent 读完问题 → 人再改），所以它自己一条事件。
 * 基准日期同理，见 `setCaseTimebase`。
 */
export function renameCase(
  db: Db,
  ctx: CaseContext,
  title: string,
  source: 'agent' | 'operator',
): boolean {
  const next = title.trim();
  if (!next) return false;
  const row = db.prepare(`SELECT title FROM cases WHERE id=?`).get(ctx.caseId) as
    | { title: string }
    | undefined;
  if (!row || row.title === next) return false;
  emitTo(db, ctx, null, {
    type: 'case.renamed',
    payload: { caseId: ctx.caseId, title: next, source, at: ctx.now() },
  });
  return true;
}

/**
 * 改基准日期。返回改没改成——同一天再落一次是空操作。
 *
 * **这是一次会动历史数据的写**：投影器接到事件后按新基准把已落库的 `occurred_at_ms`
 * 由 `occurred_at_raw` 重算一遍。所以「建单时猜错了日期」不再是不可挽回的——
 * 这正是 `occurred_at_raw` 一直存着的用处。
 *
 * **人动过手之后 agent 不该再盖上去**：判断放在调用方（main 的 `setTimebase`），
 * 与标题那条同一个理由——这里看不见「是谁在什么时候动的」。
 */
export function setCaseTimebase(
  db: Db,
  ctx: CaseContext,
  incidentDate: string,
  source: 'agent' | 'operator',
): boolean {
  const next = incidentDate.trim();
  // **这是落库前最后一道闸**：格式对不等于这一天存在，而不存在的那些会被
  // `Date.parse` 静默挪到另一天（见 `isRealDate`）——挪走之后卡片与整条事故时间线
  // 各按一天算，两边都不报错
  if (!isRealDate(next)) return false;
  const row = db
    .prepare(`SELECT incident_date, incident_date_source FROM cases WHERE id=?`)
    .get(ctx.caseId) as { incident_date: string; incident_date_source: TimeBaseSource } | undefined;
  // 日期没变也要落：agent 确认「问题说的就是建单那天」同样是一次确认，
  // 只比日期的话它落不下来，`incident_date_source` 会永远停在 intake，
  // 那条提醒也就永远关不掉
  if (!row || (row.incident_date === next && row.incident_date_source === source)) return false;
  emitTo(db, ctx, null, {
    type: 'case.timebase_set',
    payload: { caseId: ctx.caseId, incidentDate: next, source, at: ctx.now() },
  });
  return true;
}

/** 基准日期与它的来源。**每次落证据都现读**——见 `closeStep` 里那处注释。 */
export function readTimeBase(db: Db, caseId: string): (TimeBase & { source: TimeBaseSource }) | null {
  const row = db
    .prepare(
      `SELECT incident_date AS incidentDate, tz_offset AS tzOffset,
              incident_date_source AS source FROM cases WHERE id=?`,
    )
    .get(caseId) as (TimeBase & { source: TimeBaseSource }) | undefined;
  return row ?? null;
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

/**
 * 报告形态落库（D25）。与 `setCaseStatus` 分开发两条事件：形态是「报告长什么样」，
 * 状态是「调查还能不能动」。收尾时形态先落、状态最后落——
 * 状态是那道冻结闸，它一落下之后再写别的东西，写的就是一个已经宣告冻结的调查。
 */
export function setVerdictShape(db: Db, ctx: CaseContext, shape: VerdictShape): void {
  if (readVerdictShape(db, ctx.caseId) === shape) return;
  emitTo(db, ctx, null, {
    type: 'case.verdict_decided',
    payload: { caseId: ctx.caseId, shape, at: ctx.now() },
  });
}

export function readVerdictShape(db: Db, caseId: string): VerdictShape | null {
  const row = db.prepare(`SELECT verdict_shape FROM cases WHERE id=?`).get(caseId) as
    | { verdict_shape: VerdictShape | null }
    | undefined;
  return row?.verdict_shape ?? null;
}

export const isVerdictShape = (v: unknown): v is VerdictShape =>
  VERDICT_SHAPES.includes(v as VerdictShape);

/**
 * 定稿确认条的预选形态。
 *
 * **只认根因那一步的声明**：形态说的是"这次调查的根因属于哪一类故障"，只有报告认定的
 * 那条根因说得出这句话。别处（比如一条误填了 shape 的 impact step）说了不算，
 * 否则报告会按 A 步的形态装块、却填 B 步的内容。
 *
 * **`open` 不是 agent 说得算的一档**，所以它已经不在 `close_step` 的枚举里（`schemas.ts`）。
 * 它是事实：一条已证实的根因都没有就是它，归档强制也是它。库里若躺着更早写进去的
 * `open` 声明，这里当作没声明——留着的话，一次真查出了根因的调查会因为那句声明而
 * 不印根因栏，而声明与事实哪个对，事实说了算。
 *
 * 没声明才推，而推的规则只有一条准绳：**宁可少装一块，也不能装一块空的或不存在的**。
 *
 * - 没有已证实的根因 → `open`。这不是猜：没查出来就是没查出来，报告里本就不该有根因栏
 * - 根因那一步给了应然/实然 → `state`。这对字段正是它排最前的那一块，它在就说明是这一类
 * - 系统时间线上有两条以上证据 → `sequence`。**两条这个数与 `shared/report.ts` 里
 *   时间线那一块的门槛是同一个**，两边分叉的话推出来的时序型会配上一个装不出主体的报告
 * - 其余 → `chain`。它是**终点档**，不是"一定装得出来的那一档"
 *
 * 🔴 **兜底兜的是形态，不是"这份报告一定有主体"。** 一次只有一条已证实结论的调查
 * （没时间戳、没应然实然）会推到 `chain`，而链要两环才成立（`shared/report.ts` 的 `block()`）——
 * 五种主体这时一个都装不出来。**这不是缺陷，是那种调查本来就没有"重点"这一块**：
 * 报告仍旧是根因加通用四块。所以别在这儿为了"凑一个装得出来的"去改推断，
 * 那只会让形态说一件数据不支持的事；报告那侧靠 `mainAssembled` 照实说，纸头不会承诺一块不在的东西。
 */
export function suggestVerdictShape(db: Db, caseId: string): ShapeSuggestion {
  const root = reportSections(db, caseId).rootCause;
  // 这三项**必须同次算出**：状态型的主体是根因那一步的应然/实然，
  // 而形态说的也是那一步。分两次取（比如形态问库、能不能填看界面自己的快照）的话，
  // 两边会指着不同的根因——预选了新根因的 state，却按旧根因判定"这一块填得出来"
  const from = {
    rootStepId: root?.step_id ?? null,
    // trim 是兜底：写入侧已经把纯空白归一掉了，但同一 schema 版本里可能躺着更早写进去的
    stateFillable: !!(root?.expected?.trim() && root?.actual?.trim()),
  };
  if (root && isVerdictShape(root.shape) && root.shape !== 'open') {
    return { shape: root.shape, source: 'agent', ...from };
  }

  const shape: VerdictShape = !root
    ? 'open'
    : from.stateFillable
      ? 'state'
      : timestampedEvidenceCount(db, caseId) >= 2
        ? 'sequence'
        : 'chain';
  return { shape, source: 'inferred', ...from };
}

export type CaseStatus = 'open' | 'closed' | 'aborted';

export function readCaseStatus(db: Db, caseId: string): CaseStatus | null {
  const row = db.prepare(`SELECT status FROM cases WHERE id=?`).get(caseId) as
    | { status: CaseStatus }
    | undefined;
  return row?.status ?? null;
}

/**
 * 删掉一次调查，**连它的事件一起**。返回删没删着（库里没有这个 id 时 false）。
 *
 * 🔴 **这是全库唯一一处删事件的写，也是唯一一处不走事件的写。**别处改状态一律 emit
 * （见 `setCaseStatus` 那段：直接 UPDATE 的话一重放就被 `case.opened` 抹回去）。
 * 删除反过来——记一条 `case.deleted` 只会让重放时先建再删，而**事件本身就是要销毁的东西**：
 * 留着它们，`rebuildProjections` 会把这次调查连同证据原文一并重建回来，
 * 于是「删了」在下一次迁移之后自己撤销，且不报错。
 *
 * 六张投影表里只需显式删三处，其余靠外键级联（schema 里 sessions / chat_lines /
 * case_ui_state 都对 cases 带 ON DELETE CASCADE，steps 以下再往下级联）：
 *
 *   - `events`   —— 真相层，没有外键，删不掉就等于没删（见上）
 *   - 两张 FTS  —— 虚拟表也没有外键，留下的是**指不到 cases 的脏索引**：
 *                  `searchCases` 靠 INNER JOIN 把它们挡在结果外，但索引本身一直在长
 *   - `blobs`   —— 内容寻址、**跨调查共享**，所以按"删完之后还有没有人引用"逐个清，
 *                  不能跟着 case 一起删。文件与库行一起清，留一个是另一个的孤儿
 *
 * 整件事必须在一个事务里：中断在半路的话，库里会留下一次没有 `cases` 行、
 * 却仍能被重放建回来的调查。
 *
 * 🔴 **「这个 blob 属于哪次调查」认 `payload_fts`，不认 `tool_calls`。**
 * 落一次工具输出是**两条事件两个事务**（`recordToolEnd`：先 `blob.stored`，再
 * `toolcall.completed`），进程卡在两者之间时，`blobs` 行、`payload_fts` 行、磁盘文件都在了，
 * 而 `tool_calls.output_sha256` 还是空的。只认 `tool_calls` 的话这一对错在两个方向上：
 *
 *   - 漏删：这次调查落下的那份原文谁都指不到它，界面说删干净了，它永远留在库和磁盘上
 *   - **误删**：另一次调查卡在同一个窗口里，它那份原文看起来"没人引用"，于是被这一下清掉
 *
 * `payload_fts` 每条 `blob.stored` 都写一行、且带 `case_id`，正是这份归属。两处都查是因为
 * 落 FTS 那一下要能读回正文（`readBlobText`），读不回来就没有那一行，那时只剩 `tool_calls`。
 */
export function deleteCase(db: Db, caseId: string, opts: { blobDir: string }): DeleteOutcome {
  const seen = db.prepare(`SELECT 1 FROM cases WHERE id=?`).get(caseId);
  if (!seen) return { ok: false, pendingBlobs: 0 };
  // 先记下这次调查落过哪些 blob；删完之后才判得出哪些成了孤儿
  const touched = new Set(
    (
      db
        .prepare(
          `SELECT sha256 AS sha FROM payload_fts WHERE case_id = ?
           UNION
           SELECT tc.output_sha256 AS sha FROM tool_calls tc
             JOIN sessions s ON s.id = tc.session_id
            WHERE s.case_id = ? AND tc.output_sha256 IS NOT NULL`,
        )
        .all(caseId, caseId) as { sha: string }[]
    ).map((r) => r.sha),
  );

  const owed = db.transaction((): string[] => {
    db.prepare(`DELETE FROM events WHERE case_id=?`).run(caseId);
    db.prepare(`DELETE FROM narrative_fts WHERE case_id=?`).run(caseId);
    db.prepare(`DELETE FROM payload_fts WHERE case_id=?`).run(caseId);
    // 级联从这一行开始：sessions → steps → tool_calls → evidence_refs，
    // 外加 chat_lines 与 case_ui_state
    db.prepare(`DELETE FROM cases WHERE id=?`).run(caseId);
    // 两处都要问过才算没人要：这次调查的两处记录上面已经删干净了，剩下的都是别人的
    const usedByCall = db.prepare(`SELECT 1 FROM tool_calls WHERE output_sha256=? LIMIT 1`);
    const usedByCase = db.prepare(`SELECT 1 FROM payload_fts WHERE sha256=? LIMIT 1`);
    const dropBlob = db.prepare(`DELETE FROM blobs WHERE sha256=?`);
    // 🔴 **欠磁盘那一刀记在同一个事务里。** 记在事务外的话，两句之间崩掉留下的
    // 正是这张表要防的东西：库里没有任何一行指得到那个文件，也没人记得该去删它
    const owe = db.prepare(`INSERT OR REPLACE INTO blob_trash (sha256,at) VALUES (?,?)`);
    const now = Date.now();
    const mine: string[] = [];
    for (const sha of touched) {
      if (usedByCall.get(sha) || usedByCase.get(sha)) continue;
      dropBlob.run(sha);
      owe.run(sha, now);
      mine.push(sha);
    }
    return mine;
  })();

  /**
   * 🔴 **走到这儿事务已经提交，这次删除已经不可逆——所以这之后一句都不许抛。**
   *
   * 抛出去的话调用方（main 的 `case:delete`）收到的是"删失败了"：它不会收运行时，
   * 于是那个 runner 还活着、还会往一个已经不存在的 case 上写事件，而界面上那一行照旧在。
   * 库里那一半明明已经删干净了。**这条错法在 `pendingBlobs` 那种小事上翻不了车，
   * 翻车的是回执本身说反了。**
   *
   * 清理整个失败也不要紧：欠账已经在 `blob_trash` 里，下次启动接着删。
   */
  let pendingBlobs = owed.length;
  try {
    emptyBlobTrash(db, opts);
    // **只数这一次删除欠下的那几个**，不是整张表：表里可能还压着别的调查历史上没删成的，
    // 把它们算进来的话，界面会把旧欠账说成"这次调查的原文没删掉"
    const stillOwed = db.prepare(`SELECT 1 FROM blob_trash WHERE sha256=? LIMIT 1`);
    pendingBlobs = owed.filter((sha) => stillOwed.get(sha)).length;
  } catch (err) {
    // 数不出来就按"一个都没清掉"报：宁可多说几份没删成，也不能说成删干净了
    console.error('[store] 删调查后清证据原文整个失败了，欠账留在 blob_trash 里', err);
  }
  return { ok: true, pendingBlobs };
}

/**
 * 把「还欠磁盘一刀」的那几份证据原文真的删掉（`blob_trash`，建表处写了它为什么存在）。
 *
 * 每次删调查之后跑一遍，**启动时也跑一遍**——上一次没删成的，这一次接着删。
 * 返回删掉几个、还欠几个；还欠着的留在表里，下次再来。
 *
 * 🔴 **删之前必须再问一次"现在还有没有人引用它"。** blob 是内容寻址的：欠着的这段时间里，
 * 一次新调查完全可能落下**逐字相同**的输出——`storeBlob` 见文件已在就不重写，
 * `blobs` 行由 `INSERT OR IGNORE` 补回来，于是这个 sha 又活了。不问就删的话，
 * 删掉的是一份**正在用的**证据原文，而那次调查一点没被动过。
 */
export function emptyBlobTrash(
  db: Db,
  opts: { blobDir: string },
): { removed: number; pending: number } {
  const owed = db.prepare(`SELECT sha256 FROM blob_trash`).all() as { sha256: string }[];
  if (!owed.length) return { removed: 0, pending: 0 };
  const usedByCall = db.prepare(`SELECT 1 FROM tool_calls WHERE output_sha256=? LIMIT 1`);
  const usedByCase = db.prepare(`SELECT 1 FROM payload_fts WHERE sha256=? LIMIT 1`);
  const settle = db.prepare(`DELETE FROM blob_trash WHERE sha256=?`);
  let removed = 0;
  let pending = 0;
  for (const { sha256 } of owed) {
    // 又被人用上了：这一刀不欠了，划掉但别动文件
    if (usedByCall.get(sha256) || usedByCase.get(sha256)) {
      settle.run(sha256);
      continue;
    }
    try {
      rmSync(path.join(opts.blobDir, sha256), { force: true });
      settle.run(sha256);
      removed++;
    } catch (err) {
      // 留在表里，下次再来。**这里不能划掉**——划掉就等于把它变成一个没人记得的孤儿文件
      pending++;
      console.error('[store] 清证据原文失败，留着下次再删', sha256, err);
    }
  }
  return { removed, pending };
}

/**
 * 定稿前必须走完的两步（overview §6.2）：影响面要量化，遗留问题必须明写。
 * 取值本身是 renderer 也要认的契约，所以类型在 `shared/ipc` 里，这里只给清单。
 */
export const CLOSING_STEP_KINDS: readonly ClosingStepKind[] = ['impact', 'leftover'];

/**
 * 还差哪几步才能定稿。
 *
 * 判的是**当前生效的那一步**（`effectiveStep`），不是"历史上出现过没有"：
 *
 * - 只问"有没有一条收好的 impact"的话，agent 收好一条之后又新开一条打算重做、还没 close，
 *   这里照样放行——而报告取的是最新那条，于是影响面栏是空的。定稿校验与报告章节
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
): { calls: number; sessions: number; lanes: number } {
  const calls = db
    .prepare(
      `SELECT tc.id, se.case_id, tc.session_id FROM tool_calls tc
       JOIN sessions se ON se.id = tc.session_id WHERE tc.status='pending'`,
    )
    .all() as { id: string; case_id: string; session_id: string }[];
  const sessions = db
    .prepare(`SELECT id, case_id FROM sessions WHERE status='live'`)
    .all() as { id: string; case_id: string }[];
  const lanes = db
    .prepare(
      `SELECT s.id, s.lane, s.session_id, se.case_id FROM steps s
       JOIN sessions se ON se.id = s.session_id
       WHERE s.lane IS NOT NULL AND s.status='open'`,
    )
    .all() as { id: string; lane: string; session_id: string; case_id: string }[];

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
  // 支线的兜底步同理，而且**它比僵尸调用更没人管**：收口只在 `task_notification` 到达时发生，
  // 上一个进程的消息流已经没了，那条通知永远不会来。会话是不是 `live` 都要扫——
  // 已经标了 ended 的会话下面照样可能留着一条开着的支线（进程被杀在两件事之间）
  for (const l of lanes) {
    const ctx: CaseContext = { caseId: l.case_id, blobDir: opts.blobDir, now: opts.now };
    emitTo(db, ctx, l.session_id, {
      type: 'lane.converged',
      payload: {
        stepId: l.id,
        lane: l.lane,
        outcome: 'orphaned',
        summary: '（这条支线没有收尾：上一次运行结束时它还开着，结果没有留下来。）',
        at: opts.now(),
      },
    });
  }
  return { calls: calls.length, sessions: sessions.length, lanes: lanes.length };
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

  /**
   * 没有 open step 时的兜底节点（overview §4.4）：工具调用不能丢。
   *
   * **按泳道各算各的。** 主干与每条支线各有一个「当前 open 的 step」——共用一个的话，
   * 一条后台支线查到的东西会记进主线正开着的那一步，报告里于是有一步的证据来自
   * 一条它从没发起过的查询。`lane IS ?` 而不是 `=`：主干那侧绑的是 NULL。
   *
   * 支线的兜底节点**挂在起它那次调用所在的步下面**：lane key 就是那次调用的
   * `tool_use_id`，顺着它查一次就得到父。轨道因此不必认识泳道，照旧按
   * `parent_step_id` 把它缩进成一条分叉（D23）。
   */
  function ensureStep(lane?: string): string {
    const open = db
      .prepare(
        `SELECT id FROM steps WHERE session_id=? AND lane IS ? AND status='open'
         ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(ctx.sessionId, lane ?? null) as { id: string } | undefined;
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
        parentStepId: lane ? laneParent(lane) : undefined,
        lane,
        at: ctx.now(),
      },
    });
    return id;
  }

  /**
   * 起这条支线那次调用落在哪一步。查不到就当主干——`parent_step_id` 上有开着的外键，
   * 编一个 id 出去换来的是整个事务回滚，那次工具调用连账都记不上。
   */
  function laneParent(lane: string): string | undefined {
    return (db.prepare(`SELECT step_id FROM tool_calls WHERE id=?`).get(lane) as
      | { step_id: string }
      | undefined)?.step_id;
  }

  /** 这条泳道当前开着的那一步。与 `ensureStep` 认的是同一条（`lane IS ?` / `status='open'`）。 */
  function openLaneStep(lane: string): string | undefined {
    return (
      db
        .prepare(
          `SELECT id FROM steps WHERE session_id=? AND lane=? AND status='open'
           ORDER BY ordinal DESC LIMIT 1`,
        )
        .get(ctx.sessionId, lane) as { id: string } | undefined
    )?.id;
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
      const warnings: string[] = [];
      // **`parent_step_id` 上有开着的外键**，照原样发出去的话，一个手写错的 id 不是"退回主干"
      // 而是 `FOREIGN KEY constraint failed` —— 整个事务回滚，这一步压根开不出来。
      // 按 case 认而不是只认存在：别的调查的 step 能过外键，却不在这条轨道上，
      // 落库之后照样只能当主干显示，而 agent 以为自己分叉了
      let parentStepId = args.parentStepId;
      if (parentStepId) {
        const known = db
          .prepare(
            `SELECT 1 FROM steps s JOIN sessions se ON se.id=s.session_id
             WHERE s.id=? AND se.case_id=?`,
          )
          .get(parentStepId, ctx.caseId);
        if (!known) {
          // 静默丢掉不算修好：agent 会以为分叉已经记下了（ui.md §3）
          warnings.push(`parentStepId ${parentStepId} 不是本次调查里的 step，这一步按主干记。`);
          parentStepId = undefined;
        }
      }
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
          parentStepId,
          at: ctx.now(),
        },
      });
      return { stepId, ordinal, warnings };
    },

    async closeStep(args: CloseStepArgs) {
      const warnings: string[] = [];
      const step = db
        .prepare(`SELECT id, kind, expected, actual, shape, remediation FROM steps WHERE id=?`)
        .get(args.stepId) as
        | {
            id: string;
            kind: string;
            expected: string | null;
            actual: string | null;
            shape: string | null;
            remediation: string | null;
          }
        | undefined;
      if (!step) return { warnings: [`未知 stepId ${args.stepId}`] };

      // **投影是 patch 语义（缺省=不动），所以判断一律按合成之后的最终值来。**
      // 按本次入参判的话，重新 close 那一次会两头错：只补了 evidence 的那次看不见
      // 库里已经躺着的 `state`（缺主体不报警），只补了 expected 的那次又会被当成
      // "只给了一半"（其实 actual 上次就填过了）。合成规则要与投影里的 COALESCE 一致
      const final = {
        // 纯空白按没填算：`" "` 能过 z.string()，而 truthiness 会把它当成填好了，
        // 于是既不报"缺主体"、`stateFillable` 也成了 true——报告最后拿到一块视觉上的空白
        expected: blankToUndefined(args.expected) ?? step.expected ?? undefined,
        actual: blankToUndefined(args.actual) ?? step.actual ?? undefined,
        shape: args.shape ?? (step.shape as CloseStepArgs['shape']) ?? undefined,
        remediation: blankToUndefined(args.remediation) ?? step.remediation ?? undefined,
      };

      if (args.status !== 'inconclusive' && args.evidence.length === 0) {
        warnings.push('这个结论没有任何证据，无法被复核。请补 evidence 后重新 close。');
      }
      warnings.push(...shapeWarnings(final, args.status, step.kind));

      // **基准现读，不用闭包里那份 `intake`。** agent 读完问题后可能把基准改到别的日子
      // （`case.timebase_set`），而这个会话是在那之前开的——用捕获值的话，改基准之前落的
      // 证据被投影器重算成了新基准，之后落的却还按旧基准算，同一条时间线上两段错开一天。
      const base = readTimeBase(db, ctx.caseId) ?? { ...intake, source: 'intake' as const };
      // 一步里可能有好几条纯时分秒的证据，提醒只发一次：同一句话重复几遍，
      // 剩下那几条真正要 agent 动手的 warning 就被顶下去了
      let guessedBase = false;
      for (const e of args.evidence) {
        const call = resolveCallRef(args.stepId, e.callRef);
        if (!call) {
          warnings.push(`callRef ${e.callRef} 在本 step 内不存在。`);
          continue;
        }
        const occurred = parseOccurredAt(e.occurredAt, base);
        // 纯时分秒的串把整个基准都用掉了，而基准还只是建单那一刻按本机当天猜的。
        // 猜错了不会有任何报错，只让这条证据整体挪几天——所以要在**落进去的这一刻**说，
        // 事后没有任何东西看得出来。给的出路是写全日期：那一档压根不经过基准
        if (isTimeOnly(e.occurredAt) && base.source === 'intake') guessedBase = true;
        // 只有「自带时间戳的数据源 + 本次确实有命中」才强制 occurredAt：
        // 一刀切会逼 agent 拿查询执行时间凑数，假时间直接进报告主体（tools.md §3）
        const hasHits = (call.line_count ?? 0) > 1;
        if (ctx.isTimestampedSource(call.tool_name) && hasHits && !occurred.ms) {
          warnings.push(
            e.occurredAt
              ? `证据「${e.claim.slice(0, 16)}…」的 occurredAt "${e.occurredAt}" 解析不了。`
              : `证据「${e.claim.slice(0, 16)}…」来自 ${call.tool_name} 却缺 occurredAt，系统时间线会断在这里。`,
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

      if (guessedBase) {
        warnings.push(
          `本步有只写了时分秒的 occurredAt，正按基准日期 ${base.incidentDate} 理解——` +
            `那是建单当天，还没被确认过。这批日志不是那天的，就把 occurredAt 写成完整日期` +
            `（如 2026-08-14 23:47:01），带日期的串不经过基准。`,
        );
      }

      emit({
        type: 'step.closed',
        payload: {
          stepId: args.stepId,
          status: args.status,
          verdict: args.verdict,
          confidence: args.confidence,
          // 空白已归一成 undefined；三项都保持"缺省=不动"，由投影的 COALESCE 承接
          expected: blankToUndefined(args.expected),
          actual: blankToUndefined(args.actual),
          shape: args.shape,
          remediation: blankToUndefined(args.remediation),
          at: ctx.now(),
        },
      });
      for (const sid of args.supersedes ?? []) {
        emit({ type: 'step.superseded', payload: { stepId: sid, by: args.stepId } });
      }
      // 这一条只有落库之后才判得了：形态取的是**报告认定的那条根因**的声明，
      // 而谁是根因要等这一步的置信度也进了库才比得出来。
      //
      // 只对**够得着根因资格**的那些说（confirmed 的 normal）：影响面、遗留问题、
      // 被推翻的结论压根不可能成为根因，它们上面那句"不生效"已经说完了。
      // 再补一句"现在的根因是谁"只会把 agent 引向一条它不该走的路。
      //
      // 而且这里**只陈述事实，不给处置**：写"要让它算数就把那条根因推翻"等于教它去
      // 推翻一条有效结论、或把置信度往上凑——真该不该推翻，只有查过的它自己判得了。
      if (args.status === 'confirmed' && step.kind === 'normal') {
        const sections = reportSections(db, ctx.caseId);
        const root = sections.rootCause;
        if (final.shape && root && root.step_id !== args.stepId) {
          warnings.push(
            `形态取的是报告认定的那条根因的声明——现在那条是 ${root.step_id}` +
              `（置信度 ${root.confidence}），所以这一条目前不生效。`,
          );
        }
        // 修复建议是**报告四栏里唯一没有投影来源的那一栏**，不填就永远是「无」。
        // 只在这一步真的成了根因、而全案一条建议都还没有时说一次：说早了（还没根因）
        // 建议无从谈起，逐条都说则会变成每次 close 都挨一句的噪声。
        // 只提醒不阻挡——它不是强制 step（那要动 kind 的 CHECK），归档的半程报告
        // 少这一栏也是诚实的
        if (root?.step_id === args.stepId && !sections.remediation) {
          warnings.push(
            '报告的「修复建议」那一栏目前是空的，而它是四栏里唯一没有投影来源的一块。' +
              '这一步已经是报告认定的根因，重新 close 它并补上 remediation 即可（只填这一项也行）。',
          );
        }
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

    recordToolStart({ callId, toolName, input, agentId, lane, gate }) {
      const stepId = ensureStep(lane);
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

    appendChat({ role, text }) {
      emit({
        type: 'chat.appended',
        payload: { lineId: ctx.newId('ch'), sessionId: ctx.sessionId, role, text, at: ctx.now() },
      });
    },

    recordToolEnd({ callId, output, status }) {
      const blob = storeBlob(ctx.blobDir, output);
      emit({ type: 'blob.stored', payload: { ...blob, at: ctx.now() } });
      emit({
        type: 'toolcall.completed',
        payload: { callId, outputSha256: blob.sha256, status: status ?? 'done', at: ctx.now() },
      });
    },

    convergeLane({ lane, outcome, summary }) {
      const step = openLaneStep(lane);
      // 没有开着的步 = 这条支线一次工具调用都没打（兜底步只在第一次调用时才开），
      // 或者它已经收过口了。两种都不该补一个空步出来充数
      if (!step) return null;
      emit({ type: 'lane.converged', payload: { stepId: step, lane, outcome, summary, at: ctx.now() } });
      return step;
    },

    convergeOpenLanes(summary) {
      const rows = db
        .prepare(
          `SELECT id, lane FROM steps WHERE session_id=? AND lane IS NOT NULL AND status='open'
           ORDER BY ordinal`,
        )
        .all(ctx.sessionId) as { id: string; lane: string }[];
      for (const r of rows) {
        emit({
          type: 'lane.converged',
          payload: { stepId: r.id, lane: r.lane, outcome: 'orphaned', summary, at: ctx.now() },
        });
      }
      return rows.length;
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
/**
 * 形态与应然实然的当场提醒。三条都是「填了但不生效」那一类——
 * 不当场说，agent 以为自己已经交代过了，而报告到定稿那天才发现那一块是空的。
 */
function shapeWarnings(
  /** **合成之后的最终值**，不是本次入参：投影是 patch 语义，两者在重新 close 时会分叉。 */
  final: { shape?: string; expected?: string; actual?: string },
  status: CloseStepArgs['status'],
  kind: string,
): string[] {
  const out: string[] = [];
  if (final.shape && status !== 'confirmed') {
    out.push(
      `形态 ${final.shape} 声明在一个 ${status} 的结论上，不会生效——形态说的是"这是哪一类故障"，` +
        '只有已证实的结论说得出这句话。',
    );
  }
  // 形态只由根因那一步说得算，而根因一定是 normal。声明在影响面/遗留问题上不报的话，
  // 它会被静默忽略——比"错误地采纳"好，但同样是 agent 以为自己交代过了
  if (final.shape && kind !== 'normal') {
    out.push(
      `形态 ${final.shape} 声明在一个 ${kind} step 上，不会生效——它只由根因那一步（kind=normal）说了算。`,
    );
  }
  if (final.shape === 'state' && !(final.expected && final.actual)) {
    out.push(
      '状态型（state）排最前的那一块就是 expected / actual 这一对，缺了这一块整个装不出来，' +
        '报告上只会留一句"声明的是状态型，但根因那一步没给这一对"。',
    );
  }
  if (!final.expected !== !final.actual) {
    out.push('expected 与 actual 要成对给：只有一半的对照说明不了任何事。');
  }
  return out;
}

/** 纯空白等于没填：`" "` 过得了 `z.string()`，却会让所有 truthiness 判断以为它填好了。 */
const blankToUndefined = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

function anchorKind(anchor?: string): 'lines' | 'jsonpath' | 'whole' {
  if (!anchor) return 'whole';
  if (anchor.trim().startsWith('$')) return 'jsonpath';
  return /\d/.test(anchor) ? 'lines' : 'whole';
}

