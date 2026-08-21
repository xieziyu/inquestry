/**
 * Spike Close —— 验三种收尾这一带（D29 / ui.md §8.4）。
 *
 * 不起真会话：要验的都是 harness 侧的记账、状态与投影，与模型无关，而这几处的错法都是**静默**的——
 *
 *   1. **状态变更必须走领域事件。** 直接 `UPDATE cases` 的值一重放就被 `case.opened`
 *      抹回 `open`，而重放正是换 schema 时重建投影的唯一手段——结过的调查悄悄又开着了
 *   2. **终止要把挂起的回填也收掉。** 闸门那侧一直有，回填这侧原先没有：
 *      那次 `ask_operator` 调用会永远挂在 `pending` 上，轨道上是一次"发起了但没有结果"的调用
 *   3. **散场的收尾不能被迟到的 PostToolUse 盖掉。** 散场靠的就是给工具那侧一个结果，
 *      它随后照样走完 PostToolUse——不挡这一下，`abandoned` 会被改写成 `done`
 *   4. **定稿前置只认已收尾的强制 step。** 拿一个还开着的 impact step 放行，
 *      等于让报告的影响面栏空着定稿
 *   5. **启动清扫必须赶在任何 runner 之前。** 那一刻库里的 pending 与 live 必然是上次残留的；
 *      建完 runner 再扫会把这一轮自己的活计一起判成放弃（这条是调用点顺序，见 main/index.ts）
 *
 * 跑：npm run rebuild:node && npm run spike:close
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { blobDir, openDatabase, type Db } from '../src/backend/db/database.js';
import { rebuildProjections } from '../src/backend/db/projector.js';
import {
  createInvestigationSession,
  emptyBlobTrash,
  missingClosingSteps,
  readCaseStatus,
  readIntake,
  suggestVerdictShape,
  sweepZombies,
  type InvestigationSession,
} from '../src/backend/store/sqlite-store.js';
import { readBlobHead } from '../src/backend/db/blobs.js';
import { searchNarrative } from '../src/backend/db/queries.js';
import { TOOL_DEFS, type InvestigationStore } from '../src/backend/tools/definitions.js';
import { closeStepShape } from '../src/backend/tools/schemas.js';
import { METRICS_MAX, ROSTER_MAX } from '../src/shared/ipc.js';
import { reportMarkdown } from '../src/shared/markdown.js';
import { reportInput } from '../src/shared/report.js';
import { CaseRunner, closingMessage } from '../src/main/case-runner.js';
import { callStatusLabel } from '../src/renderer/StepSheet.js';
import type { DeclarableShape, Snapshot, VerdictShape } from '../src/shared/ipc.js';

const ASK = 'mcp__inquestry__ask_operator';

/** 收尾要验的正是 runner 的私有面（hook 入口、回填、会话准备），只好从旁边够进去。 */
type Probe = {
  beginSession(): InvestigationSession;
  onToolStart(input: unknown, toolUseID: string | undefined): unknown;
  onToolEnd(input: unknown, toolUseID: string | undefined): unknown;
  onToolFailed(input: unknown, toolUseID: string | undefined): unknown;
  onPermissionDenied(input: unknown, toolUseID: string | undefined): unknown;
  askOperator(args: { engine: string; statement: string; why: string; expect: string; env?: string }): Promise<unknown>;
  gate(
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; signal: AbortSignal },
  ): Promise<unknown>;
  status: Snapshot['sessionStatus'];
  busy: boolean;
  /** 派活那一手判的是「有没有活着的查询」——验它就得先给一个。 */
  q: unknown;
  inbox: { push(t: string): void };
  /** 回填卡 → 调用的连线只存在这里，验它只能直接读。 */
  pending: Map<string, { callId?: string; ask: { id: string; statement: string } }>;
  /** 记了账、还没被工具正文认领的 ask_operator 调用。 */
  askCalls: { callId: string; ask: { statement: string; env: string } }[];
  /** 闸门赶在 PreToolUse 之前落定时判决先搁这儿。要验那个时序只能自己摆一个进去。 */
  preGated: Map<string, { decision: string; input?: string; message?: string }>;
  /** 落库失败那条路要靠注入故障才走得到——真把磁盘写坏了没法在 spike 里复原。 */
  session: { recordToolEnd(input: unknown): void } | undefined;
  /** 断流 / 崩溃只有这一条路走得到——收尾漏没漏东西，只有喂一个真会断的流才验得出来。 */
  consume(q: unknown): Promise<void>;
};

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

let db: Db;
let blobs: string;

function makeRunner(caseId: string, title?: string): CaseRunner {
  return new CaseRunner({
    db,
    blobDir: blobs,
    promptText: '',
    caseId,
    intake: readIntake(db, caseId) ?? {
      title: title ?? caseId,
      question: `${title ?? caseId} 的问题`,
      projectRoot: null,
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    },
    agent: { backend: 'claude', model: null, effort: null },
    onChange: () => {},
  });
}

const callStatus = (id: string) =>
  (db.prepare(`SELECT status FROM tool_calls WHERE id=?`).get(id) as { status: string } | undefined)?.status;

/** 跑一步带证据的调查，用来喂定稿前置与"证据不该被销毁"两条。 */
async function work(
  session: InvestigationSession,
  opts: {
    direction: string;
    kind?: 'normal' | 'impact' | 'leftover';
    callId: string;
    occurredAt: string;
    /** 形态与应然实然只有下根因那一步才给（D25）。 */
    shape?: DeclarableShape;
    expected?: string;
    actual?: string;
    remediation?: string;
  },
) {
  const { stepId } = await session.store.openStep({ direction: opts.direction, kind: opts.kind });
  session.recordToolStart({ callId: opts.callId, toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  session.recordToolEnd({ callId: opts.callId, output: `命中 1 条\n${opts.occurredAt} 502 gateway\n(end)` });
  const { warnings } = await session.store.closeStep({
    stepId,
    status: 'confirmed',
    verdict: `${opts.direction} —— 成立`,
    confidence: 0.8,
    shape: opts.shape,
    remediation: opts.remediation,
    expected: opts.expected,
    actual: opts.actual,
    evidence: [
      { callRef: '#1', anchor: '2', claim: `${opts.occurredAt} 观察到 502`, occurredAt: opts.occurredAt, actor: 'gateway' },
    ],
  });
  return { stepId, warnings };
}

const shapeOf = (caseId: string) =>
  (db.prepare(`SELECT verdict_shape s FROM cases WHERE id=?`).get(caseId) as { s: string | null }).s;

async function main() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-close-')), 'inquestry.db');
  db = openDatabase(file);
  blobs = blobDir(file);

  // ── ① 定稿前置：两个强制 step 走完之前结不了案 ─────────────────────────
  const c1 = makeRunner('case_close', '订单 502');
  const p1 = c1 as unknown as Probe;
  const s1 = p1.beginSession();
  const first = await work(s1, { direction: '网关重试放大了下游压力', callId: 'call_c1', occurredAt: '12:41:07' });

  // 收口那一刻与调用的起止**要真的投影到快照上**。舞台的心跳层全靠这三个数：
  // `close_step` 是结构工具，不进 `tool_calls`（`case-runner.ts` 的三条 hook 挡着），
  // 所以"刚收了一步"这件事只有 `steps.t_end` 说得出。写进库了却没投影出来不会有任何报错
  {
    const open = (await s1.store.openStep({ direction: '还没收的一步', kind: 'normal' })).stepId;
    const snap = c1.snapshot();
    const closed = snap.steps.find((x) => x.id === first.stepId);
    const still = snap.steps.find((x) => x.id === open);
    const call = closed?.calls[0];
    check(
      '收口时刻与调用起止都投影到了快照上（心跳层与「最后更新」全靠它们）',
      typeof closed?.endedAt === 'number' &&
        closed.endedAt >= closed.startedAt &&
        still?.endedAt === null &&
        typeof call?.startedAt === 'number' &&
        typeof call.endedAt === 'number',
      `收了的 endedAt=${closed?.endedAt}（t_start=${closed?.startedAt}）· 还开着的 endedAt=${still?.endedAt}` +
        ` · 调用 ${call?.startedAt}→${call?.endedAt}`,
    );
    // 心跳层拿 `snap.sessionId` 与每一步的 `sessionId` 比，只认这一轮的那几步。
    // 两边对不上的话它不会报错，只是**整层安静地一个字都不出**——而那与"这会儿真没事在跑"
    // 在屏幕上长得一模一样，所以这条得由这儿盯着
    check(
      '快照报的 sessionId 与这一轮落下的步对得上',
      !!snap.sessionId && snap.sessionId === still?.sessionId && snap.sessionId === closed?.sessionId,
      `快照 ${snap.sessionId} · 步 ${still?.sessionId} —— 对不上的话舞台上的心跳层整层消失，且没有任何报错`,
    );
  }

  const gapsAtStart = c1.closingGaps;
  const refused = await c1.closeCase();
  check(
    '缺影响面与遗留问题时结不了案（§6.2）',
    !refused.ok && refused.missing.join(',') === 'impact,leftover' && readCaseStatus(db, 'case_close') === 'open',
    `missing=${refused.ok ? '(竟然结了)' : refused.missing.join(',')} · status=${readCaseStatus(db, 'case_close')}`,
  );
  check(
    '缺的那几步在快照里就看得见，不用点了定稿才知道',
    gapsAtStart.join(',') === 'impact,leftover' && c1.snapshot().closingGaps.length === 2,
    `closingGaps=${c1.snapshot().closingGaps.join(',')}`,
  );
  // 问询与执行是两个入口（否则界面只能靠 60ms 前的快照决定"这一下是问还是执行"）
  const asked1 = c1.requestClosing();
  check(
    '问询那条路只问不执行：缺步照样不改状态',
    asked1.missing.join(',') === 'impact,leftover' && readCaseStatus(db, 'case_close') === 'open',
    `missing=${asked1.missing.join(',')} · status=${readCaseStatus(db, 'case_close')}`,
  );
  check(
    '没有活着的会话就派不出去，得如实说（asked=false）',
    asked1.asked === false && c1.snapshot().chat.length === 0,
    `asked=${asked1.asked} · 聊天里多出 ${c1.snapshot().chat.length} 条`,
  );

  // ── ② 强制 step 必须是**已收尾的** ────────────────────────────────────
  //
  // 只看"有没有这一 kind"的话，一个刚开还没结论的影响面 step 就能放行定稿，
  // 而报告的影响面栏取的是它的 verdict——那时是空的
  const openImpact = await s1.store.openStep({ direction: '量化影响面', kind: 'impact' });
  check(
    '还开着的 impact step 不算走完',
    missingClosingSteps(db, 'case_close').includes('impact'),
    `missing=${missingClosingSteps(db, 'case_close').join(',')}`,
  );
  await s1.store.closeStep({
    stepId: openImpact.stepId,
    status: 'confirmed',
    verdict: '12:40–12:47 共 1832 次请求受影响，占同期 4.1%',
    confidence: 0.9,
    // 这一步没有自己的工具调用，所以它不带证据（下面那条形态检查数的正是"带时间的证据只有一条"）。
    // 写个认不出来的 callRef 是不行的：整次 close 会被退回，这一步压根收不了
    evidence: [],
  });
  const leftover = await s1.store.openStep({ direction: '重试上限为什么是 5', kind: 'leftover' });
  await s1.store.closeStep({
    stepId: leftover.stepId,
    status: 'inconclusive',
    verdict: '没查清：改动没有留下评审记录',
    confidence: 0.2,
    evidence: [],
  });

  // ── ②.2 执行入口在缺步时只回绝，绝不顺手替人做主 ──────────────────────────
  //
  // 这是"快照过期也绕不过确认"那道防线本身：界面拿的是 60ms 合流推来的快照，
  // agent 刚补完最后一步而这一屏还没收到时，按钮上写着"差 N 步"、点下去却会落进执行路径。
  // 只要执行入口缺步时一律不动手，那一下最坏也就是白点一次
  const cReport = makeRunner('case_exec', '执行入口不替人做主');
  const pReport = cReport as unknown as Probe;
  const sReport = pReport.beginSession();
  await work(sReport, { direction: '先查一步', callId: 'call_e1', occurredAt: '10:00:00' });
  // ⚠️ **必须有个活着的查询**：派活那一手写的是 `if (this.q)`，没有 q 的话
  // 合并语义与拆开语义跑出来一模一样——这条检查就是空的（第一次写就栽在这儿）
  pReport.q = {} as never;
  const execRefused = await cReport.closeCase();
  check(
    '执行入口缺步时只回绝，不冻调查也不派活',
    !execRefused.ok &&
      execRefused.missing.length === 2 &&
      readCaseStatus(db, 'case_exec') === 'open' &&
      cReport.snapshot().chat.length === 0,
    `status=${readCaseStatus(db, 'case_exec')} · 聊天多出 ${cReport.snapshot().chat.length} 条（派活是问询那条路的事）`,
  );
  // 问询那条路反过来：会话活着就真派出去
  const execAsk = cReport.requestClosing();
  check(
    '问询那条路在会话活着时把两步派给 agent',
    execAsk.asked === true && cReport.snapshot().chat.at(-1)?.text.includes('impact') === true,
    `asked=${execAsk.asked} · 末条=${cReport.snapshot().chat.at(-1)?.text.slice(0, 28) ?? '(没发出去)'}`,
  );
  pReport.q = null as never;
  cReport.close();

  // ── ②.3 收好之后又新开一条重做，缺口要重新出现 ────────────────────────────
  //
  // 只问"历史上有没有一条收好的 impact"的话，agent 收好一条、随后新开一条打算重做
  // 还没 close，这里照样放行——而报告取的是**最新**那条，于是影响面栏印出来是空的。
  // 定稿校验与报告章节必须共用同一条"哪一步算数"的规则
  const cRedo = makeRunner('case_redo', '影响面重做到一半');
  const sRedo = (cRedo as unknown as Probe).beginSession();
  await work(sRedo, { direction: '先查一步', callId: 'call_r1', occurredAt: '10:00:00' });
  const firstImpact = await sRedo.store.openStep({ direction: '先估一版影响面', kind: 'impact' });
  await sRedo.store.closeStep({
    stepId: firstImpact.stepId,
    status: 'confirmed',
    verdict: '约 300 次请求受影响',
    confidence: 0.6,
    // 这一步没有自己的调用，不带证据（要验的是"哪一步算数"，与证据无关）
    evidence: [],
  });
  const lo2 = await sRedo.store.openStep({ direction: '遗留', kind: 'leftover' });
  await sRedo.store.closeStep({ stepId: lo2.stepId, status: 'inconclusive', verdict: '无', confidence: 0.2, evidence: [] });
  check(
    '重做之前：两步都齐，可以定稿',
    missingClosingSteps(db, 'case_redo').length === 0 && cRedo.snapshot().report.impact === '约 300 次请求受影响',
    `missing=${missingClosingSteps(db, 'case_redo').join(',') || '(无)'} · 报告影响面=${cRedo.snapshot().report.impact}`,
  );
  // agent 觉得口径不对，新开一条重做——还没 close
  await sRedo.store.openStep({ direction: '换个口径重算影响面', kind: 'impact' });
  check(
    '当前那条 impact 还开着时缺口重新出现，历史上那条盖不住它',
    missingClosingSteps(db, 'case_redo').includes('impact'),
    `missing=${missingClosingSteps(db, 'case_redo').join(',') || '(无 —— 历史上那条把它盖住了)'}`,
  );
  cRedo.close();

  // ── ②.5 强制 step 被推翻之后，缺口要重新出现 ─────────────────────────────
  //
  // `superseded` 的意思是这条结论已被明确推翻。被**同类**的新 step 顶掉不影响（新的自己补上了），
  // 真正漏的是被别的 kind 推翻：章节看着齐全，而报告那一栏（`reportSections` 不按 status 过滤）
  // 取到的是一份已经作废的影响面
  // 单独一次调查：case_close 里已经有一个收好的 impact step 了，在那儿验会被它顶掉
  const cs = makeRunner('case_super', '影响面被推翻');
  const ss = (cs as unknown as Probe).beginSession();
  await work(ss, { direction: '重试放大', callId: 'call_s1', occurredAt: '12:41:07' });
  const wrongImpact = await ss.store.openStep({ direction: '先按网关日志估个影响面', kind: 'impact' });
  await ss.store.closeStep({
    stepId: wrongImpact.stepId,
    status: 'confirmed',
    verdict: '大约 300 次请求受影响',
    confidence: 0.5,
    evidence: [],
  });
  check(
    '推翻之前：这一步算走完了',
    !missingClosingSteps(db, 'case_super').includes('impact'),
    `missing=${missingClosingSteps(db, 'case_super').join(',') || '(无)'}`,
  );
  // 推翻它的是个 normal step —— 被同类顶掉的话新的自己就补上了，漏的是这一种
  const better = await ss.store.openStep({ direction: '网关计数漏了重试，按下游账本重算' });
  await ss.store.closeStep({
    stepId: better.stepId,
    status: 'confirmed',
    verdict: '网关那份少算了重试，前一步的影响面作废',
    confidence: 0.9,
    supersedes: [wrongImpact.stepId],
    evidence: [],
  });
  check(
    '强制 step 被别的 kind 推翻之后，缺口重新出现（不能拿作废的结论定稿）',
    missingClosingSteps(db, 'case_super').includes('impact'),
    `missing=${missingClosingSteps(db, 'case_super').join(',') || '(无 —— superseded 被当成走完了)'}`,
  );
  // 报告那侧走的必须是同一条规则：不共用的话它会把这份已经被推翻的影响面照印不误
  check(
    '同一条规则也管着报告：已被推翻的影响面不印进报告',
    cs.snapshot().report.impact === null,
    `报告影响面=${JSON.stringify(cs.snapshot().report.impact)}（各算各的话这里会是"大约 300 次请求受影响"）`,
  );
  cs.close();

  // ── ③ 补齐之后定稿成立，且状态走的是事件 ────────────────────────────────
  check(
    '定稿之前不写形态：调查中途的形态还会变，定死一个只会让报告按过期判断装',
    shapeOf('case_close') === null,
    `verdict_shape=${shapeOf('case_close')}`,
  );
  const closed = await c1.closeCase();
  const evidenceBefore = (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c;
  check(
    '两步走完就能定稿，case 落到 closed',
    closed.ok && readCaseStatus(db, 'case_close') === 'closed',
    `status=${readCaseStatus(db, 'case_close')}`,
  );
  // 这次调查 agent 一次形态都没声明过，走的是推断那条：有已证实的根因，没有应然实然，
  // 系统时间线上只有一条证据（影响面那一步没带证据，所以排不出"顺序"）→ chain。
  // 换成 open 会把一条真实结论从报告里抹掉，换成 sequence 是装一块空的
  check(
    '没人声明形态时定稿也得落一个装得出来的：chain，不是 open 也不是 sequence',
    shapeOf('case_close') === 'chain',
    `verdict_shape=${shapeOf('case_close')}（带时间的证据 ${(db.prepare(`SELECT COUNT(*) c FROM evidence_refs e JOIN steps s ON s.id=e.step_id JOIN sessions se ON se.id=s.session_id WHERE se.case_id='case_close' AND e.occurred_at_ms IS NOT NULL`).get() as { c: number }).c} 条）`,
  );
  check(
    '定稿顺手把会话收了，库里不留永远 live 的 session',
    (db.prepare(`SELECT status FROM sessions WHERE case_id='case_close'`).get() as { status: string }).status ===
      'ended',
    `session=${(db.prepare(`SELECT status FROM sessions WHERE case_id='case_close'`).get() as { status: string }).status}`,
  );

  // ── ④ 冻结：结完不能再开会话，也发不出消息 ──────────────────────────────
  const sessionsBefore = (db.prepare(`SELECT COUNT(*) c FROM sessions WHERE case_id='case_close'`).get() as {
    c: number;
  }).c;
  await c1.start();
  const sent = await c1.send('再帮我看一眼');
  check(
    '定稿后 start() 不再新起会话，send() 也回 false',
    sent === false &&
      (db.prepare(`SELECT COUNT(*) c FROM sessions WHERE case_id='case_close'`).get() as { c: number }).c ===
        sessionsBefore,
    `sessions=${sessionsBefore} → ${(db.prepare(`SELECT COUNT(*) c FROM sessions WHERE case_id='case_close'`).get() as { c: number }).c} · send=${sent}`,
  );
  check(
    '重开 app 不会自动回到已定稿的调查',
    (db.prepare(`SELECT id FROM cases WHERE status='open' ORDER BY updated_at DESC LIMIT 1`).get() as
      | { id: string }
      | undefined)?.id !== 'case_close',
    `候选=${(db.prepare(`SELECT id FROM cases WHERE status='open' ORDER BY updated_at DESC LIMIT 1`).get() as { id: string } | undefined)?.id ?? '(没有)'}`,
  );

  // ── ⑤ 停止（第一档）：散掉挂起的回填，并把那次调用记成放弃 ─────────────────
  //
  // ⚠️ 这里同时验**回填与 tool_use_id 的连线是按语句认的**：先记账的是 call_a（语句 A），
  // 但真正问出来的是语句 B。按先后认领的话这张卡会绑到 call_a 上——甲的放弃记到乙头上。
  const c2 = makeRunner('case_stop', '登录偶发失败');
  const p2 = c2 as unknown as Probe;
  p2.beginSession();
  p2.status = 'live';
  p2.onToolStart({ tool_name: ASK, tool_input: { statement: 'SELECT A' } }, 'call_a');
  p2.onToolStart({ tool_name: ASK, tool_input: { statement: 'SELECT B' } }, 'call_b');
  void p2.askOperator({ engine: 'mysql', statement: 'SELECT B', why: '看一眼', expect: '预期一条' });

  // 连线本身要直接验，不能只看散场之后谁被判了放弃——散场会把两条都收掉，
  // 那时候"绑对了没有"已经看不出来了
  check(
    '回填卡绑的是语句对得上的那次调用，不是队首那次',
    [...p2.pending.values()][0]?.callId === 'call_b',
    `绑到了 ${[...p2.pending.values()][0]?.callId ?? '(没绑上)'}（按先后认领会绑到 call_a）`,
  );
  // 语句对不上时**认不到就是认不到**：猜队首会把别人那次调用记成放弃，
  // 而真正该收的那条继续挂着
  void p2.askOperator({ engine: 'mysql', statement: '一条谁都对不上的语句', why: '看一眼', expect: '预期一条' });
  check(
    '语句对不上就不认领，不拿队首兜底',
    [...p2.pending.values()][1]?.callId === undefined && p2.askCalls.some((c) => c.callId === 'call_a'),
    `绑到了 ${[...p2.pending.values()][1]?.callId ?? '(没绑，对的)'} · call_a 还在待认领队列里`,
  );
  // 真实顺序：PreToolUse 先记账并回 ask，闸门才拦得住（canUseTool 不是每次都到）
  p2.onToolStart({ tool_name: 'mcp__logs__query', tool_input: { q: 'x' } }, 'call_g');
  void p2.gate('mcp__logs__query', { q: 'x' }, { toolUseID: 'call_g', signal: new AbortController().signal });
  // 排队里还没送出去的消息，停止要连它一起清（D7）
  p2.inbox.push('顺便看看重试次数');
  await c2.interrupt();

  check(
    '停止把挂起的回填也散掉，并把那次调用记成 abandoned',
    callStatus('call_b') === 'abandoned' && c2.snapshot().pending.length === 0,
    `call_b=${callStatus('call_b')} · pending=${c2.snapshot().pending.length}`,
  );
  // 记了账、工具正文还没跑到 askOperator 的那一段里撞上停止，这条调用两头不靠：
  // 不在 `pending` 里所以散场那轮扫不到，而库里的行确实已经挂着 pending 了
  check(
    '还没被认领的 ask_operator 调用，停止时也一并收掉',
    callStatus('call_a') === 'abandoned' && p2.askCalls.length === 0,
    `call_a=${callStatus('call_a')} · 待认领队列剩 ${p2.askCalls.length} 条（不收的话只有下次启动清扫才纠正得回来）`,
  );
  check(
    '闸门那侧记的也是 abandoned，不是被拒——没有人看过这一条',
    callStatus('call_g') === 'abandoned' &&
      (db.prepare(`SELECT gate_decision g FROM tool_calls WHERE id='call_g'`).get() as { g: string | null }).g ===
        'auto',
    `call_g=${callStatus('call_g')} · gate=${(db.prepare(`SELECT gate_decision g FROM tool_calls WHERE id='call_g'`).get() as { g: string | null }).g}`,
  );
  check(
    '停止连排队消息一起清（D7），并且说出清了几条',
    c2.snapshot().chat.at(-1)?.text.includes('1 条') === true,
    `末条=${c2.snapshot().chat.at(-1)?.text}`,
  );
  check(
    '停止不改调查状态：随时能接着查',
    readCaseStatus(db, 'case_stop') === 'open',
    `status=${readCaseStatus(db, 'case_stop')}`,
  );

  // ── ⑤.5 散场不改写已经有结论的调用 ────────────────────────────────────
  //
  // `askCalls` 里的条目不保证还是 pending：一次 `ask_operator` 在 PreToolUse 之后
  // 因为参数校验/工具异常走了 `onToolFailed`，账上已经是 `failed`，而条目还留在队列里
  // （只有被认领时才会清）。散场时无条件改判就会把它盖成 `abandoned` ——
  // 丢掉的正是"工具自己坏了"和"没人问到它"的区别
  const cf = makeRunner('case_terminal', '已有结论的不改写');
  const pf = cf as unknown as Probe;
  pf.beginSession();
  pf.onToolStart({ tool_name: ASK, tool_input: { statement: 'SELECT f' } }, 'call_f');
  pf.onToolStart({ tool_name: 'mcp__logs__query', tool_input: { q: 'x' } }, 'call_d');
  // 一条工具自己坏了，一条被规则层拒了——两种都是"有人/有事下过结论"
  pf.onToolFailed({ tool_name: ASK, error: '参数校验没过' }, 'call_f');
  pf.onPermissionDenied({ tool_name: 'mcp__logs__query', reason: '这个库不许读' }, 'call_d');
  await cf.interrupt();
  check(
    '散场不改写已经有结论的调用：failed 还是 failed，denied 还是 denied',
    callStatus('call_f') === 'failed' && callStatus('call_d') === 'denied',
    `call_f=${callStatus('call_f')} · call_d=${callStatus('call_d')}（无条件改判会把两条都盖成 abandoned）`,
  );

  // ── ⑥ 迟到的 PostToolUse 不能把 abandoned 盖成 done ──────────────────────
  //
  // 散场靠的正是"给工具那侧一个结果"，所以它随后照样会走完 PostToolUse
  p2.onToolEnd({ tool_name: ASK, tool_response: '(调查已关闭，这条回填作废)' }, 'call_b');
  check(
    '散场之后迟到的成功收尾不算数，abandoned 保持原样',
    callStatus('call_b') === 'abandoned',
    `call_b=${callStatus('call_b')}（不挡这一下会变成 done，轨道上多出一次没人回答过的"跑完了"）`,
  );

  // ── ⑥.5 人工拒绝：记成被拒，且说给 agent 的不是一句空结果 ─────────────────
  //
  // 人自己也没那个权限时，这张卡得有出口——否则只能干等到超时，十分钟里 agent 一动不动。
  // 两处错法都是静默的：
  //
  //   1. **记成 `done`**：轨道上于是有一次"跑完了"的查询，而它一行数据都没有。
  //      抢在 resolve 之前记才挡得住——工具正文一返回，PostToolUse 就来收这条的尾
  //   2. **把拒绝理由当结果回给 agent**：理由是选填的，空理由原样回过去读起来就是
  //      "查了，没数据"，而这两件事在后面的推理里分量正好相反
  const cd = makeRunner('case_decline', '人工拒绝');
  const pd = cd as unknown as Probe;
  pd.beginSession();
  pd.status = 'live';
  pd.onToolStart({ tool_name: ASK, tool_input: { statement: 'SELECT n' } }, 'call_n');
  const declined = pd.askOperator({
    engine: 'mysql',
    statement: 'SELECT n',
    why: '看一眼',
    expect: '预期一条',
  }) as Promise<{ answer: string; statement: string; declined?: boolean }>;
  const askN = cd.snapshot().pending[0]!.id;
  check(
    '拒绝也有回执，那条待办当场从快照上消失',
    cd.answerOperator({ id: askN, action: 'decline', reason: '生产库我也没权限' }) === true &&
      cd.snapshot().pending.length === 0,
    `pending=${cd.snapshot().pending.length}`,
  );
  const declinedResult = await declined;
  check(
    '拒绝记成 denied——有人看过这一条并说了不行，不是跑完了',
    callStatus('call_n') === 'denied',
    `call_n=${callStatus('call_n')}（记成 done 的话轨道上多出一次一行数据都没有的"成功"查询）`,
  );
  // 拒绝也是"给工具那侧一个结果"，所以 PostToolUse 照样会来
  pd.onToolEnd({ tool_name: ASK, tool_response: '⛔ 人没有执行这一条' }, 'call_n');
  check(
    '迟到的 PostToolUse 不能把 denied 盖回 done',
    callStatus('call_n') === 'denied',
    `call_n=${callStatus('call_n')}`,
  );
  check(
    '拒绝理由落进那次调用的输出里，节点上看得见人当时说了什么',
    (readBlobHead(
      blobs,
      (db.prepare(`SELECT output_sha256 s FROM tool_calls WHERE id='call_n'`).get() as { s: string }).s,
      200,
    ) ?? '').includes('生产库我也没权限'),
    `输出=${readBlobHead(blobs, (db.prepare(`SELECT output_sha256 s FROM tool_calls WHERE id='call_n'`).get() as { s: string }).s, 200)}`,
  );

  // 详情页那一格要真的写得出来。**只验库里的 status 是验不到这一层的**：每次调用都带着
  // 闸门判决进库（没人问到的记 `auto`），标签一旦按"有没有判决"让位，这条在真实数据上
  // 就永远不显示——那次调用在详情页里与跑成功的长得一模一样。所以按快照里那份取，不自己编
  const declinedNode = cd
    .snapshot()
    .steps.flatMap((st) => st.calls)
    .find((c) => c.id === 'call_n');
  check(
    '详情页把人工拒绝写出来：这一格不能被「没人问到」的那个 auto 判决顶掉',
    callStatusLabel(declinedNode!.status, declinedNode!.gate) === '你拒绝执行',
    `status=${declinedNode?.status} · gate=${declinedNode?.gate} · 标签=${callStatusLabel(declinedNode!.status, declinedNode!.gate) ?? '(没有)'}`,
  );

  // 闸门先于 PreToolUse 落定、且判的是放行时，这条调用带着判决进 onToolStart。
  // 按"有没有判决"入队的话它进不了 `askCalls`，卡上的拒绝就认不回这次调用，
  // 最后被迟到的 PostToolUse 记成 done —— 与这一轮要挡的正是同一个错法
  pd.preGated.set('call_m', { decision: 'allow' });
  pd.onToolStart({ tool_name: ASK, tool_input: { statement: 'SELECT m' } }, 'call_m');
  void pd.askOperator({ engine: 'mysql', statement: 'SELECT m', why: '看一眼', expect: '预期一条' });
  check(
    '闸门先落定且放行时，那次回填照样连得回它的调用',
    cd.snapshot().pending[0] !== undefined && [...pd.pending.values()][0]?.callId === 'call_m',
    `绑到了 ${[...pd.pending.values()][0]?.callId ?? '(没绑上)'}（按"有没有判决"排的话这里是空的）`,
  );
  // 改写过参数的那一档：正文收到的是改写后的语句，拿原参数去对必然对不上
  pd.preGated.set('call_w', { decision: 'rewrite', input: JSON.stringify({ statement: 'SELECT w2' }) });
  pd.onToolStart({ tool_name: ASK, tool_input: { statement: 'SELECT w1' } }, 'call_w');
  void pd.askOperator({ engine: 'mysql', statement: 'SELECT w2', why: '看一眼', expect: '预期一条' });
  check(
    '参数被改写过时按改写后的语句认，不按 agent 原来写的那句',
    [...pd.pending.values()][1]?.callId === 'call_w',
    `绑到了 ${[...pd.pending.values()][1]?.callId ?? '(没绑上)'}`,
  );
  // 被拒那一档要排掉：工具正文压根不执行，也就没有卡，入队只会留个没人认领的条目
  pd.preGated.set('call_v', { decision: 'deny', message: '这个库不许读' });
  pd.onToolStart({ tool_name: ASK, tool_input: { statement: 'SELECT v' } }, 'call_v');
  check(
    '被闸门拒掉的那次不入队：它的工具正文不会跑，也就不会有卡来认它',
    !pd.askCalls.some((c) => c.callId === 'call_v') && callStatus('call_v') === 'denied',
    `call_v=${callStatus('call_v')} · 在待认领队列里=${pd.askCalls.some((c) => c.callId === 'call_v')}`,
  );

  // 留痕落不下时，这条 Promise 仍然要落地。**定时器已经清了、卡片也摘了**，
  // resolve 跑不到的话 agent 永远等下去，而屏幕上卡片正常消失，一点异样都看不出来
  const cx = makeRunner('case_declinefail', '留痕失败');
  const px = cx as unknown as Probe;
  px.beginSession();
  px.status = 'live';
  px.onToolStart({ tool_name: ASK, tool_input: { statement: 'SELECT boom' } }, 'call_boom');
  const hanging = px.askOperator({
    engine: 'mysql',
    statement: 'SELECT boom',
    why: '看一眼',
    expect: '预期一条',
  }) as Promise<{ answer: string; declined?: boolean }>;
  const realEnd = px.session!.recordToolEnd.bind(px.session);
  px.session!.recordToolEnd = () => {
    throw new Error('磁盘满了');
  };
  const declineOk = cx.answerOperator({
    id: cx.snapshot().pending[0]!.id,
    action: 'decline',
    reason: '我也没权限',
  });
  px.session!.recordToolEnd = realEnd;
  const landed = await Promise.race([
    hanging.then((r) => r.declined === true),
    new Promise<false>((r) => setTimeout(() => r(false), 300)),
  ]);
  check(
    '留痕落不下时那条回填照样落地，agent 不会永远等下去',
    declineOk === true && landed === true && cx.snapshot().pending.length === 0,
    `回执=${declineOk} · Promise 落地=${landed}（落不了地的话卡片照常消失，而这场调查就此挂死）`,
  );

  // ── ⑥.6 同一条语句同时问出好几次 ────────────────────────────────────────
  //
  // 一个查询问 prod 与 staging 两个环境是常事，语句一模一样、只有 `env` 不同。
  // PreToolUse 与工具正文之间没有全局顺序保证，所以这里**故意让正文按相反的顺序跑**：
  // 只按语句认的话两张卡会各自认到对方那次调用，随后拒其中一张，被记成 denied 的是另一次，
  // 而真正被拒的那次由它自己的 PostToolUse 记成 done —— 轨道上与人的处置正好相反
  const cc = makeRunner('case_concurrent', '同语句并发');
  const pc = cc as unknown as Probe;
  pc.beginSession();
  pc.status = 'live';
  const twoEnv = (env: string) => ({
    engine: 'mysql',
    statement: 'SELECT count(*) FROM t_order',
    why: '两个环境对一下条数',
    expect: '两边各一个数',
    env,
  });
  pc.onToolStart({ tool_name: ASK, tool_input: twoEnv('prod') }, 'call_prod');
  pc.onToolStart({ tool_name: ASK, tool_input: twoEnv('staging') }, 'call_stg');
  void pc.askOperator(twoEnv('staging'));
  void pc.askOperator(twoEnv('prod'));
  const byEnv = (env: string) => cc.snapshot().pending.find((x) => x.env === env);
  check(
    '同语句不同 env 的两条并发，各自认到自己那次调用（正文顺序与记账相反也不错位）',
    [...pc.pending.values()].find((x) => x.ask.statement === twoEnv('staging').statement) !== undefined &&
      byEnv('staging') !== undefined &&
      byEnv('prod') !== undefined &&
      [...pc.pending.values()][0]?.callId === 'call_stg' &&
      [...pc.pending.values()][1]?.callId === 'call_prod',
    `staging→${[...pc.pending.values()][0]?.callId ?? '(没绑上)'} · prod→${[...pc.pending.values()][1]?.callId ?? '(没绑上)'}（只按语句认会绑反）`,
  );
  cc.answerOperator({ id: byEnv('staging')!.id, action: 'decline', reason: '预发这套我连不上' });
  check(
    '拒了 staging 那张卡，被记成被拒的就是 staging 那次调用，prod 那次纹丝不动',
    callStatus('call_stg') === 'denied' && callStatus('call_prod') === 'pending',
    `call_stg=${callStatus('call_stg')} · call_prod=${callStatus('call_prod')}`,
  );

  // 逐字相同的两条同时在飞：谁配谁没有事实可依。**宁可一条都不认**——认错的代价不是
  // 少一条连线，是把另一次调用记成被拒，而真正被拒那次连人贴进去的东西都落不下
  const twin = { engine: 'mysql', statement: 'SELECT 1 FROM dual', why: '探活', expect: '一个 1' };
  pc.onToolStart({ tool_name: ASK, tool_input: twin }, 'call_t1');
  pc.onToolStart({ tool_name: ASK, tool_input: twin }, 'call_t2');
  void pc.askOperator(twin);
  const twinAsk = cc.snapshot().pending.find((x) => x.statement === twin.statement)!;
  check(
    '两条入参逐字相同时一条都不认，不拿队首兜底',
    [...pc.pending.values()].find((x) => x.ask.id === twinAsk.id)?.callId === undefined,
    `绑到了 ${[...pc.pending.values()].find((x) => x.ask.id === twinAsk.id)?.callId ?? '(没绑，对的)'}`,
  );
  cc.answerOperator({ id: twinAsk.id, action: 'decline', reason: '这条不用跑了' });
  check(
    '认不到时拒绝就不留痕，绝不挑一个记成被拒',
    callStatus('call_t1') === 'pending' && callStatus('call_t2') === 'pending',
    `call_t1=${callStatus('call_t1')} · call_t2=${callStatus('call_t2')}（挑一个记的话，另一次调用替它背了这个拒绝）`,
  );

  const askDef = TOOL_DEFS.find((d) => d.name === 'ask_operator')!;
  const declineText = await askDef.run(
    { askOperator: async () => declinedResult } as unknown as InvestigationStore,
    { engine: 'mysql', statement: 'SELECT n', why: '看一眼', expect: '预期一条' },
  );
  check(
    'agent 收到的是「这条没人跑」，不是一份查询结果',
    declinedResult.declined === true && !declineText.includes('结果：') && declineText.includes('生产库我也没权限'),
    `回给 agent 的：${declineText.replace(/\n/g, ' / ')}`,
  );
  // 理由留空是常态（"我也没权限"这句话不值得每次都敲一遍），空理由更不能读成空结果
  const mute = await askDef.run(
    { askOperator: async () => ({ answer: '', statement: 'SELECT n', declined: true }) } as unknown as InvestigationStore,
    { engine: 'mysql', statement: 'SELECT n', why: '看一眼', expect: '预期一条' },
  );
  check(
    '不留理由时说的仍是「没执行」，而不是一份空结果',
    !mute.includes('结果：') && mute.includes('没有执行'),
    `回给 agent 的：${mute.replace(/\n/g, ' / ')}`,
  );

  // ── ⑦ 归档（第三档）：标记放弃，但一条证据都不销毁 ────────────────────────
  const c3 = makeRunner('case_abort', '支付回调丢单');
  const p3 = c3 as unknown as Probe;
  const s3 = p3.beginSession();
  // agent 在这儿声明过形态：归档要能盖掉它（半程报告一律未决型）
  await work(s3, {
    direction: '回调签名校验把重放挡了',
    callId: 'call_x1',
    occurredAt: '09:12:33',
    shape: 'sequence',
  });
  // 正跑着的时候收尾是常态（"不查了"多半就发生在它还在跑的时候）
  p3.busy = true;
  // 一次已经自动放行、还在跑的普通调用：库里只有 started。收尾会 close() 掉查询，
  // 而 SDK 保证 close() 之后不再有任何消息——PostToolUse 永远不会来收它的尾
  p3.onToolStart({ tool_name: 'Read', tool_input: { file_path: '/tmp/app.log' } }, 'call_live');
  const beforeAbort = {
    evidence: (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c,
    incident: c3.snapshot().incident.length,
    steps: c3.snapshot().steps.length,
  };
  c3.archiveCase();
  const afterAbort = {
    evidence: (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c,
    incident: c3.snapshot().incident.length,
    steps: c3.snapshot().steps.length,
  };
  check(
    '归档不销毁任何证据：证据、系统时间线、步骤一条不少',
    readCaseStatus(db, 'case_abort') === 'aborted' &&
      afterAbort.evidence === beforeAbort.evidence &&
      afterAbort.incident === beforeAbort.incident &&
      afterAbort.steps === beforeAbort.steps,
    `status=${readCaseStatus(db, 'case_abort')} · 证据 ${beforeAbort.evidence}→${afterAbort.evidence} · 系统线 ${beforeAbort.incident}→${afterAbort.incident}`,
  );
  // `consume()` 的 finally 认的是 `this.q === q`，而 close() 上一行刚把 q 置空——
  // 收尾这条路上没有别人会来清 busy
  check(
    '忙着的时候归档，正跑着的普通调用也要收掉——不是只收卡在人这儿的那两种',
    callStatus('call_live') === 'abandoned',
    `call_live=${callStatus('call_live')}（留着 pending 的话冻结后的报告里它永远显示「进行中」）`,
  );
  check(
    '正跑着的时候收尾，busy 要跟着清掉',
    c3.isBusy === false && c3.snapshot().busy === false,
    `busy=${c3.isBusy}（留着 true 的话切换栏一直显示「跑动中」，trimIdle 也永远跳过它，载入上限形同虚设）`,
  );
  check(
    '归档不需要走完那两步——它就是"没查完也要收手"的那一档',
    missingClosingSteps(db, 'case_abort').length === 2,
    `仍差 ${missingClosingSteps(db, 'case_abort').join(',')}`,
  );
  check(
    '归档一律落未决型，盖掉 agent 声明过的形态（半程报告没有根因栏）',
    shapeOf('case_abort') === 'open',
    `verdict_shape=${shapeOf('case_abort')}（照 agent 声明的 sequence 装，会得到一份看着完整实则半截的报告）`,
  );
  check(
    '收尾把 updated_at 前移到收尾那一刻，切换栏才排得对',
    (db.prepare(`SELECT updated_at u, created_at c FROM cases WHERE id='case_abort'`).get() as {
      u: number;
      c: number;
    }).u >=
      (db.prepare(`SELECT updated_at u, created_at c FROM cases WHERE id='case_abort'`).get() as {
        u: number;
        c: number;
      }).c,
    'updated_at ≥ created_at',
  );

  // ── ⑦.5 报告形态与应然实然（D25 / overview §6.1.1） ─────────────────────
  //
  // 这一带的错法全是**静默装错块**：形态填了不生效、被推翻的声明照旧算数、
  // 推断值把一条真实结论抹掉——三种在界面上都表现为"定稿了，然后报告某一栏是空的"

  // 声明生效，且人在确认条上的选择优先于它
  const cShape = makeRunner('case_shape', '形态由 agent 声明');
  const sShape = (cShape as unknown as Probe).beginSession();
  const rootShape = await work(sShape, {
    direction: '重试风暴按时间顺序放大',
    callId: 'call_sh1',
    occurredAt: '12:41:07',
    shape: 'sequence',
  });
  check(
    'close_step 的形态落在那一步上，不直接写进 cases',
    (db.prepare(`SELECT shape FROM steps WHERE id=?`).get(rootShape.stepId) as { shape: string | null }).shape ===
      'sequence' && shapeOf('case_shape') === null,
    `steps.shape=${(db.prepare(`SELECT shape FROM steps WHERE id=?`).get(rootShape.stepId) as { shape: string | null }).shape} · cases.verdict_shape=${shapeOf('case_shape')}`,
  );
  check(
    '有声明就用声明，并且说得出这是 agent 声明的（推断值只是兜底，不能混为一谈）',
    suggestVerdictShape(db, 'case_shape').shape === 'sequence' &&
      suggestVerdictShape(db, 'case_shape').source === 'agent',
    JSON.stringify(suggestVerdictShape(db, 'case_shape')),
  );
  // 形态与「状态型填不填得出来」必须同次算出，且说得出是按哪一步算的：
  // 界面按 rootStepId 判断手上冻的那份还说不说得上话，认错步就会拿新根因的形态
  // 配旧根因的结论——预选 state 却一句"这一块会是空的"都没有
  check(
    '建议里带着它是按哪一条根因算的，以及那一步填不填得出应然实然',
    suggestVerdictShape(db, 'case_shape').rootStepId === rootShape.stepId &&
      suggestVerdictShape(db, 'case_shape').stateFillable === false,
    JSON.stringify(suggestVerdictShape(db, 'case_shape')),
  );
  // 形态声明与报告根因必须共用同一条选择规则。另起一条（比如"全案最新那条带声明的"）的话，
  // 一条误填了 shape 的 impact step 就能决定报告装哪几块，而根因与应然实然仍来自根因那一步——
  // 报告的结构与内容自相矛盾，且没有任何报错
  const strayImpact = await sShape.store.openStep({ direction: '量化影响面', kind: 'impact' });
  const strayWarn = await sShape.store.closeStep({
    stepId: strayImpact.stepId,
    status: 'confirmed',
    verdict: '12:40–12:47 共 1832 次请求受影响',
    confidence: 0.99, // 置信度再高也抢不走：它不是根因，形态不归它说
    shape: 'distribution',
    evidence: [],
  });
  check(
    '别的 kind 上的形态声明抢不走根因的形态（两边共用同一条根因选择规则）',
    suggestVerdictShape(db, 'case_shape').shape === 'sequence',
    `建议=${JSON.stringify(suggestVerdictShape(db, 'case_shape'))}（各算各的话这里是 distribution，而根因仍是那条时序结论）`,
  );
  // 抢不走还不够：不生效就得当场说。静默忽略比错误采纳好，但 agent 照样以为自己交代过了
  check(
    '非 normal step 上的形态声明当场回警告，不静默忽略',
    strayWarn.warnings.some((t) => t.includes('impact step 上')),
    `warnings=${JSON.stringify(strayWarn.warnings)}`,
  );
  // 它已经被告知"永远不生效"了，再补一句"现在的根因是谁"只会把 agent 引向
  // 一条它不该走的路——影响面无论如何成不了根因，而那句话读起来像在教它去推翻有效结论
  check(
    '够不着根因资格的 step 不再收到「现在的根因是谁」那句话',
    !strayWarn.warnings.some((t) => t.includes('报告认定的那条根因的声明')),
    `warnings=${JSON.stringify(strayWarn.warnings)}`,
  );
  const lo = await sShape.store.openStep({ direction: '汇总未查清的问题', kind: 'leftover' });
  await sShape.store.closeStep({
    stepId: lo.stepId,
    status: 'inconclusive',
    verdict: '没有遗留',
    confidence: 0.5,
    evidence: [],
  });
  // 确认条冻的是问询这一下带回来的形态，不是界面自己那份快照上的。
  // 两者差着一拍：main 按最新状态放行了弹窗，而界面冻的是点击那一帧的值——
  // agent 刚落定的声明会被一个过期值盖掉，而这一下是不可逆的
  const askShape = cShape.requestClosing();
  check(
    '问询回来的形态与缺口出自同一次库状态',
    askShape.missing.length === 0 &&
      JSON.stringify(askShape.suggestion) === JSON.stringify(suggestVerdictShape(db, 'case_shape')),
    `问询=${JSON.stringify(askShape.suggestion)} · 库里=${JSON.stringify(suggestVerdictShape(db, 'case_shape'))}`,
  );
  // 冻的是**落库那一刻**算出来的形态（D25）：界面不再传形态，人也不再选
  const beforeClose = suggestVerdictShape(db, 'case_shape').shape;
  await cShape.closeCase();
  check(
    '定稿冻的是落库那一刻算出来的形态，不收界面传来的',
    shapeOf('case_shape') === beforeClose && beforeClose === 'sequence',
    `verdict_shape=${shapeOf('case_shape')} · 落库前算出来的=${beforeClose}`,
  );

  // 同一步 close 第二次是**我们自己的 warning 指使的**（"请补 evidence 后重新 close"），
  // 而那一次多半只带 evidence。把"没再填"解释成"清空"的话，第一次填好的形态与
  // 应然实然会被静默抹掉——报告主体随之空掉，重放还会一模一样地复现
  const reState = await sShape.store.openStep({ direction: '连接池上限一直就是错的' });
  // 这一步要收两次证据，**得有一次真的调用**：callRef 认不出来的话整次 close 会被退回
  // （证据是全量，落一半就是删旧留残），下面两次 close 就都不会发生，而这一段验的正是它们
  sShape.recordToolStart({ callId: 'call_restate', toolName: 'mcp__repo__read_file', input: { path: 'pool.ts' } });
  sShape.recordToolEnd({ callId: 'call_restate', output: 'maxConnections = 5\n' });
  await sShape.store.closeStep({
    stepId: reState.stepId,
    status: 'confirmed',
    verdict: '连接池上限从上线起就写成了 5',
    confidence: 0.5,
    shape: 'state',
    expected: '连接池上限 200',
    actual: '实际是 5',
    evidence: [],
  });
  await sShape.store.closeStep({
    stepId: reState.stepId,
    status: 'confirmed',
    verdict: '连接池上限从上线起就写成了 5',
    confidence: 0.5,
    // 这一次只补证据，三项都没再填
    evidence: [{ callRef: '#1', claim: '配置文件里就是 5' }],
  });
  const reClosed = () =>
    db.prepare(`SELECT shape, expected, actual FROM steps WHERE id=?`).get(reState.stepId) as {
      shape: string | null;
      expected: string | null;
      actual: string | null;
    };
  check(
    '同一步再 close 一次，没重填的形态与应然实然保持原样，不被清空',
    reClosed().shape === 'state' && reClosed().expected === '连接池上限 200',
    `${JSON.stringify(reClosed())}（当成"清空"的话报告主体就没了，而这条路正是我们自己让 agent 走的）`,
  );

  // 投影是 patch 语义之后，警告也必须按**合成后的最终值**判，否则两头错：
  // 只补 evidence 那次看不见库里已经躺着的 state，只补一半那次又会被当成"只给了一半"
  const halfAgain = await sShape.store.closeStep({
    stepId: reState.stepId,
    status: 'confirmed',
    verdict: '连接池上限从上线起就写成了 5',
    confidence: 0.5,
    expected: '连接池上限 200（改了个说法）',
    evidence: [{ callRef: '#1', claim: '再看一眼' }],
  });
  check(
    '只重填一半时不误报"只给了一半"——另一半上次就填过了',
    !halfAgain.warnings.some((t) => t.includes('成对给')),
    `warnings=${JSON.stringify(halfAgain.warnings)}`,
  );

  // ── evidence 是全量：再 close 一次带了证据，就整份替换上一批 ─────────────
  //
  // 当成追加的话，agent 按我们自己那句"请补 evidence 后重新 close"重发一遍
  //（逐字重发或改写重发都发生过），库里就躺出两份互相独立的证据行，
  // 报告的系统时间线原样把它们并排印出来。规则在 projector 里，**写入与重放共用**。
  //
  // 这一段必须跑真库真 projector：报告那带的夹具是手搓的 Snapshot，压根不经过投影，
  // 同样的检查加在那儿是空的
  const cRep = makeRunner('case_evrep', '同一步补证据');
  const sRep = (cRep as unknown as Probe).beginSession();
  const evRows = (stepId: string) =>
    db
      .prepare(`SELECT id, claim, seq FROM evidence_refs WHERE step_id=? ORDER BY seq`)
      .all(stepId) as { id: string; claim: string; seq: number | null }[];

  const rep = await sRep.store.openStep({ direction: '设备 A 上挂了多少账号' });
  sRep.recordToolStart({ callId: 'call_rep', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  sRep.recordToolEnd({
    callId: 'call_rep',
    output: '命中 2 条\n12:41:07 users 数组含 12 个\n12:41:08 status=-10\n(end)',
  });
  const batch = [
    { callRef: '#1', anchor: '2', claim: '设备 A 的 users 数组含 12 个账号', occurredAt: '12:41:07', actor: 'device-service' },
    { callRef: '#1', anchor: '3', claim: '该设备 status 为 -10（已封）', occurredAt: '12:41:08', actor: 'device-service' },
  ];
  const closeRep = (evidence: typeof batch, confidence: number) =>
    sRep.store.closeStep({
      stepId: rep.stepId,
      status: 'confirmed' as const,
      verdict: '设备 A 上挂了 12 个账号',
      confidence,
      evidence,
    });
  await closeRep(batch, 0.8);
  const firstBatch = evRows(rep.stepId);
  // 逐字重发同一批：agent 按提示重新 close 时走的正是这条路
  await closeRep(batch, 0.9);
  const secondBatch = evRows(rep.stepId);
  check(
    '再 close 一次带了证据：整批替换上一批，不是并排躺两份',
    firstBatch.length === 2 &&
      secondBatch.length === 2 &&
      secondBatch.every((r) => !firstBatch.some((o) => o.id === r.id)),
    `第一批 ${firstBatch.length} 条 → 第二批 ${secondBatch.length} 条（无条件 append 的话这儿是 4 条，` +
      `而报告的系统时间线原样并排印两遍——用户看到的正是这个）`,
  );

  // 改写重发：同一件事换了口径，只有 2 条里的 1 条还在。丢掉的那条必须当场说
  const rewritten = await closeRep(
    [{ callRef: '#1', anchor: '2', claim: '设备 A 与设备 B 共挂了 12 个账号', occurredAt: '12:41:07', actor: 'device-service' }],
    0.9,
  );
  check(
    '上一批里没再出现的证据当场报出来（替换语义得自纠错，否则丢证据是静默的）',
    rewritten.warnings.some((t) => t.includes('整份替换') && t.includes('该设备 status')),
    `warnings=${JSON.stringify(rewritten.warnings)}`,
  );
  check(
    '被换掉的旧说法从检索里一起消失（漏删 FTS 是静默的：时间线干净了，检索照旧翻得出它）',
    searchNarrative(db, '该设备 status 为 -10').length === 0 &&
      searchNarrative(db, '共挂了 12 个账号').length === 1,
    `旧说法命中 ${searchNarrative(db, '该设备 status 为 -10').length} 条 · 新说法命中 ${searchNarrative(db, '共挂了 12 个账号').length} 条`,
  );

  // 「这个结论没有任何证据」同样得按**合成之后的最终值**判（closeStep 里那条纪律）：
  // 这一步的证据上次就落好了，这一次 `evidence: []` 一条都不删——照本次入参判的话，
  // 我们会对着一个证据齐全的结论说它没有证据，而 agent 唯一的出路是把整批再发一遍，
  // 正好是替换语义想让它别做的事。**两头都验**：库里真没有证据时它还得照常出声
  const evKept = await sRep.store.closeStep({
    stepId: rep.stepId,
    status: 'confirmed',
    verdict: '设备 A 与设备 B 共挂了 12 个账号',
    confidence: 0.95,
    evidence: [],
  });
  const bare = await sRep.store.openStep({ direction: '一条证据都不打算给的结论' });
  const bareClose = await sRep.store.closeStep({
    stepId: bare.stepId,
    status: 'confirmed',
    verdict: '就这么定了',
    confidence: 0.5,
    evidence: [],
  });
  check(
    '「没有任何证据」按库里的最终状态判：已有证据的步以 evidence: [] 再 close 时不报，真没有时照报',
    !evKept.warnings.some((t) => t.includes('没有任何证据')) &&
      evRows(rep.stepId).length === 1 &&
      bareClose.warnings.some((t) => t.includes('没有任何证据')),
    `再 close=${JSON.stringify(evKept.warnings)} · 证据 ${evRows(rep.stepId).length} 条 · ` +
      `真空的那步=${JSON.stringify(bareClose.warnings)}`,
  );

  // 🔴 **坏 callRef 不能只丢它自己那一条。** 全量替换之下，落一半就是把上一批换成
  // "这次恰好验证通过的那个子集"——一个手误抹掉的是旧证据，而 agent 手上没有它，恢复不出来。
  // 所以整批要么全进要么全不进，且坏的一次列全（只报第一条的话，一个五条的批要来回改五次）
  const stepRowOf = (id: string) =>
    db.prepare(`SELECT status, closed_seq, verdict_text FROM steps WHERE id=?`).get(id) as {
      status: string;
      closed_seq: number | null;
      verdict_text: string | null;
    };
  const eventCount = () => (db.prepare(`SELECT COUNT(*) c FROM events`).get() as { c: number }).c;
  const evidenceBeforeBad = evRows(rep.stepId);
  const stepBeforeBad = stepRowOf(rep.stepId);
  const eventsBeforeBad = eventCount();
  const mixed = await sRep.store.closeStep({
    stepId: rep.stepId,
    status: 'confirmed',
    verdict: '再补两条（但 callRef 写错了）',
    confidence: 0.99,
    evidence: [
      { callRef: '#1', anchor: '2', claim: '这一条的 callRef 是好的', occurredAt: '12:41:07', actor: 'device-service' },
      { callRef: '#7', claim: '这一条的 callRef 手误了' },
      { callRef: '#9', claim: '这一条也手误了' },
    ],
  });
  check(
    '一批里混了认不出来的 callRef：整次 close 一条都不落，旧证据、结论与 closed_seq 原样不动',
    mixed.warnings.length === 1 &&
      mixed.warnings[0]!.includes('#7') &&
      mixed.warnings[0]!.includes('#9') &&
      JSON.stringify(evRows(rep.stepId)) === JSON.stringify(evidenceBeforeBad) &&
      JSON.stringify(stepRowOf(rep.stepId)) === JSON.stringify(stepBeforeBad) &&
      eventCount() === eventsBeforeBad,
    `回话=${JSON.stringify(mixed.warnings)} · 证据 ${evidenceBeforeBad.length} → ${evRows(rep.stepId).length} 条 · ` +
      `步 ${JSON.stringify(stepBeforeBad)} → ${JSON.stringify(stepRowOf(rep.stepId))} · ` +
      `events ${eventsBeforeBad} → ${eventCount()}` +
      `（"跳过坏的那条、其余照落"的话，好的那条落进去就把上一批整批顶掉了——一个手误换来一次不可逆的丢证据）`,
  );

  // 第一次 close 就写错的那一档走的是同一条路：**不是"只落好的那半批"**，
  // 否则 agent 会以为这一步收了，而它手上那几条从没进过库
  const firstBad = await sRep.store.openStep({ direction: '第一次 close 就把 callRef 写错' });
  sRep.recordToolStart({ callId: 'call_firstbad', toolName: 'mcp__datasource__query_logs', input: { q: 'z' } });
  sRep.recordToolEnd({ callId: 'call_firstbad', output: '命中 1 条\n12:55:00 重试 3 次\n(end)' });
  const firstBadClose = await sRep.store.closeStep({
    stepId: firstBad.stepId,
    status: 'confirmed',
    verdict: '重试放大了压力',
    confidence: 0.7,
    evidence: [
      { callRef: '#1', anchor: '2', claim: '好的那一条', occurredAt: '12:55:00', actor: 'gateway' },
      { callRef: '#4', claim: '错的那一条' },
    ],
  });
  check(
    '第一次 close 混了坏 callRef 也整批拒：这一步仍是开着的，一条证据都没落',
    firstBadClose.warnings.length === 1 &&
      firstBadClose.warnings[0]!.includes('#4') &&
      evRows(firstBad.stepId).length === 0 &&
      stepRowOf(firstBad.stepId).status === 'open' &&
      stepRowOf(firstBad.stepId).closed_seq === null,
    `回话=${JSON.stringify(firstBadClose.warnings)} · 证据 ${evRows(firstBad.stepId).length} 条 · ` +
      `步=${JSON.stringify(stepRowOf(firstBad.stepId))}`,
  );

  // 🔴 **认不出来一律算坏的，绝不"抽个数字出来"猜。** `#0` 在抽数字的写法下读成 0，
  // 而 SQLite 把负的 OFFSET 当 0 算——它于是指向本步第一次调用；`#-1` 被抽成 1，同样落在第一次上。
  // 两者都不进 badRefs，整批拒那道闸对它们完全不响：证据挂到了 agent 根本没引用的调用上，
  // 上一批还被整批顶掉，而回话里一个字都不会提
  const beforeSneaky = evRows(rep.stepId);
  const eventsBeforeSneaky = eventCount();
  const sneaky = await sRep.store.closeStep({
    stepId: rep.stepId,
    status: 'confirmed',
    verdict: '拿几种糊弄得过去的 callRef 试试',
    confidence: 0.9,
    evidence: [
      { callRef: '#0', anchor: '2', claim: '0 号调用是不存在的', occurredAt: '12:41:07' },
      { callRef: '#-1', claim: '负数更不是编号' },
      { callRef: '#abc', claim: '压根不是数字' },
      { callRef: '#99', claim: '超出本步的调用次数' },
    ],
  });
  check(
    '#0 / #-1 / #abc / 超界的 #99 一律算认不出来：整批退回，旧证据与 events 一行没动',
    sneaky.rejected === true &&
      ['#0', '#-1', '#abc', '#99'].every((r) => sneaky.warnings[0]?.includes(r)) &&
      JSON.stringify(evRows(rep.stepId)) === JSON.stringify(beforeSneaky) &&
      eventCount() === eventsBeforeSneaky,
    `回话=${JSON.stringify(sneaky.warnings)} · 证据 ${beforeSneaky.length} → ${evRows(rep.stepId).length} 条 · ` +
      `events ${eventsBeforeSneaky} → ${eventCount()}` +
      `（抽数字的写法下 #0 与 #-1 都会解析成第一次调用，于是这一批"部分有效"，旧批被顶掉）`,
  );

  // 上面那一批里混着 `#abc`，整批拒因此照样会响——**单独发一个 `#0` 才是真的危险面**：
  // 抽数字的写法下它是"有效的第一次调用"，这一批于是全票通过，上一批被顶掉，一句提示都没有
  const onlyZero = await sRep.store.closeStep({
    stepId: rep.stepId,
    status: 'confirmed',
    verdict: '只用一个 #0 收一次',
    confidence: 0.9,
    evidence: [{ callRef: '#0', anchor: '2', claim: '#0 不该被读成第一次调用', occurredAt: '12:41:07' }],
  });
  check(
    '只带一个 #0 的批次照样整批退回，上一批证据一条不少',
    onlyZero.rejected === true &&
      JSON.stringify(evRows(rep.stepId)) === JSON.stringify(beforeSneaky) &&
      eventCount() === eventsBeforeSneaky,
    `回话=${JSON.stringify(onlyZero.warnings)} · 证据 ${beforeSneaky.length} → ${evRows(rep.stepId).length} 条 · ` +
      `events ${eventsBeforeSneaky} → ${eventCount()}` +
      `（抽数字的写法下这一批全票通过：#0 → OFFSET -1，SQLite 按 0 算，指向第一次调用）`,
  );

  // 提示词让 agent **照抄工具正文开头那个 `[call #2]`**（investigation.md），而正文里印的就是这个格式
  // （case-runner.ts 的 PostToolUse 前缀）。只认 `#2` 的话，一条完全合规的引用会在 zod 那层就被打回去
  /**
   * 收一次，把落下的那条读回来。**要连 claim 一起读**：只读 `tool_call_id` 的话，
   * 一个把 `[call #1]` 判成坏 ref 的实现会让这次 close 整批退回，读到的仍是上一条——
   * 两次"结果相同"，检查照旧全绿，而它其实一个字都没验（这条是探针跑出来的）
   */
  const lastEvidence = () =>
    db
      .prepare(`SELECT tool_call_id, claim FROM evidence_refs WHERE step_id=? ORDER BY seq DESC LIMIT 1`)
      .get(rep.stepId) as { tool_call_id: string; claim: string } | undefined;
  const closeWithRef = async (callRef: string, claim: string) => {
    await sRep.store.closeStep({
      stepId: rep.stepId,
      status: 'confirmed',
      verdict: '设备 A 与设备 B 共挂了 12 个账号',
      confidence: 0.9,
      evidence: [{ callRef, anchor: '2', claim, occurredAt: '12:41:07', actor: 'device-service' }],
    });
    return lastEvidence();
  };
  const viaHash = await closeWithRef('#1', '只写 #1 的那条');
  const viaBracket = await closeWithRef('[call #1]', '照抄 [call #1] 的那条');
  const bracketZero = await sRep.store.closeStep({
    stepId: rep.stepId,
    status: 'confirmed',
    verdict: '照抄了一个不存在的编号',
    confidence: 0.9,
    evidence: [{ callRef: '[call #0]', claim: '正文里不会印出 #0，但抄错了就是它' }],
  });
  check(
    '照抄 [call #1] 与只写 #1 指向同一次调用；[call #0] 照旧整批退回',
    viaHash?.claim === '只写 #1 的那条' &&
      viaBracket?.claim === '照抄 [call #1] 的那条' &&
      viaHash.tool_call_id === viaBracket.tool_call_id &&
      bracketZero.rejected === true &&
      bracketZero.warnings[0]?.includes('[call #0]') === true,
    `#1 → ${JSON.stringify(viaHash)} · [call #1] → ${JSON.stringify(viaBracket)} · ` +
      `[call #0] → ${JSON.stringify(bracketZero.warnings)}` +
      `（正文里印的就是 [call #N]，提示词让它照抄——只认 #N 的话这是我们自己造的回归）`,
  );

  // 超长数字串过得了"整串是数字"这一关，`Number` 之后却是 Infinity：直接绑给 OFFSET 会抛
  // datatype mismatch。**那就成了异常而不是退回**——agent 拿到的是崩溃，不是"改好 callRef 再重发"
  const bigOutcome = await sRep.store
    .closeStep({
      stepId: rep.stepId,
      status: 'confirmed',
      verdict: '拿一串很长的数字当编号',
      confidence: 0.9,
      evidence: [{ callRef: `#${'9'.repeat(400)}`, claim: '长到 Number 之后是 Infinity' }],
    })
    .then((r) => ({ rejected: r.rejected === true, threw: '' }))
    .catch((e: Error) => ({ rejected: false, threw: e.message }));
  check(
    '超长数字串走的是整批退回，不是抛异常',
    bigOutcome.rejected && !bigOutcome.threw,
    `rejected=${bigOutcome.rejected} · 抛出=${bigOutcome.threw || '(没抛，对的)'}` +
      `（少了 isSafeInteger 这一关，SQLite 会为一个 Infinity 的 OFFSET 抛 datatype mismatch）`,
  );

  // 回话的**头一句**也得跟着分派：退回时这一步没关上、证据一条没落，
  // 头却照旧写"已关闭（confirmed），收到 3 条证据"的话，agent 读到的是两句互相矛盾的话——
  // 它多半按前一句往下走，而它手里那批证据再也发不出去了
  const closeDef = TOOL_DEFS.find((d) => d.name === 'close_step')!;
  const rejectedText = await closeDef.run(sRep.store, {
    stepId: rep.stepId,
    status: 'confirmed',
    verdict: '又一次写错了 callRef',
    confidence: 0.9,
    evidence: [{ callRef: '#8', claim: '这条的 callRef 又错了' }],
  });
  const acceptedText = await closeDef.run(sRep.store, {
    stepId: rep.stepId,
    status: 'confirmed',
    verdict: '设备 A 与设备 B 共挂了 12 个账号',
    confidence: 0.9,
    evidence: [],
  });
  check(
    '被退回时回话头说的是「没有关闭」，且带上原因；正常收尾那句原样不变',
    !rejectedText.includes('已关闭') &&
      rejectedText.includes('没有关闭') &&
      rejectedText.includes('#8') &&
      acceptedText.includes('已关闭'),
    `被退回=${rejectedText.replace(/\n/g, ' / ')}\n      正常=${acceptedText.replace(/\n/g, ' / ')}` +
      `（头不分派的话，"已关闭、收到 1 条证据"与"一条都没落下"会并排出现在同一段回话里）`,
  );

  // 🔴 **这一条才是这次改动真正的危险面。** `evidence` 是必填字段，只补 remediation 那次传的是
  // `[]`（prompt/investigation.md 明写着这条路）——少了"本批带没带证据"那个存在性判断，
  // 那一步的证据会被整批抹掉，而上面几条照旧全绿
  const only = await sRep.store.openStep({ direction: '汇总未查清的问题', kind: 'leftover' });
  sRep.recordToolStart({ callId: 'call_keep', toolName: 'mcp__datasource__query_logs', input: { q: 'y' } });
  sRep.recordToolEnd({ callId: 'call_keep', output: '命中 1 条\n12:50:00 队列积压 3 万条\n(end)' });
  await sRep.store.closeStep({
    stepId: only.stepId,
    status: 'inconclusive',
    verdict: '队列那侧还没查清',
    confidence: 0.3,
    evidence: [{ callRef: '#1', anchor: '2', claim: '队列积压 3 万条', occurredAt: '12:50:00', actor: 'queue' }],
  });
  const keptBefore = evRows(only.stepId);
  const onlyRemediation = await sRep.store.closeStep({
    stepId: only.stepId,
    status: 'inconclusive',
    verdict: '队列那侧还没查清',
    confidence: 0.3,
    remediation: '先给队列消费加延迟观测',
    evidence: [],
  });
  const keptAfter = evRows(only.stepId);
  check(
    '只补 remediation 那次（evidence: []）一条都不删',
    keptBefore.length === 1 && keptAfter.length === 1 && keptAfter[0]?.id === keptBefore[0]?.id,
    `${keptBefore.length} 条 → ${keptAfter.length} 条（漏了那个存在性判断的话它归零，` +
      `而"替换生效"那两条照旧全绿——一个会抹掉证据的实现就这么过了）`,
  );
  check(
    '没发生替换就不报「整份替换」那句话',
    !onlyRemediation.warnings.some((t) => t.includes('整份替换')),
    `warnings=${JSON.stringify(onlyRemediation.warnings)}`,
  );

  // 存量脏数据靠的就是这一下（`SCHEMA_VERSION` 8→9 那级空步骤后面跟着的重投）：
  // 规则一旦读了时钟或生成了 id，重放到同一位置就删出另一批，这条当场 FAIL。
  // **逐行比对，不写死期望值**——写死的期望值只会被后来的人抄成新的现状
  const evAll = () =>
    JSON.stringify(
      db.prepare(`SELECT id, step_id, claim, seq FROM evidence_refs ORDER BY id`).all(),
    );
  const beforeReplay = evAll();
  rebuildProjections(db, { blobDir: blobs });
  check(
    '重投一遍逐行相同，且每一行都带回了 seq（存量四份调查变干净靠的正是这一下）',
    evAll() === beforeReplay &&
      (db.prepare(`SELECT COUNT(*) c FROM evidence_refs WHERE seq IS NULL`).get() as { c: number }).c === 0 &&
      evRows(rep.stepId).length === 1 &&
      searchNarrative(db, '该设备 status 为 -10').length === 0,
    `重放前后一致=${evAll() === beforeReplay} · 那一步 ${evRows(rep.stepId).length} 条证据 · ` +
      `旧说法在检索里 ${searchNarrative(db, '该设备 status 为 -10').length} 条`,
  );
  cRep.close();

  // 🔴 **批次边界不能是时间戳。** 两次 close 落进同一毫秒时，`observed_at` 与上次的 `t_end`
  // 全都相等，"上一批"与"这一批"当场分不开——而它不报错，只是安静地不替换。
  // 这一段把时钟钉死在同一个数上：所有事件同毫秒，只有 `events.seq` 还分得清先后
  const FROZEN = 1_777_000_000_000;
  let frozenIds = 0;
  const frozen = createInvestigationSession(
    db,
    {
      caseId: 'case_evsame',
      sessionId: 'sess_frozen',
      backend: 'claude',
      blobDir: blobs,
      isTimestampedSource: () => true,
      now: () => FROZEN,
      newId: (prefix) => `${prefix}_frozen_${++frozenIds}`,
      runOperator: async () => ({ answer: '' }),
    },
    {
      title: '同一毫秒内收两次',
      question: '同一毫秒内收两次',
      projectRoot: null,
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    },
  );
  const same = await frozen.store.openStep({ direction: '同一毫秒内被收两次的那一步' });
  frozen.recordToolStart({ callId: 'call_same', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  frozen.recordToolEnd({ callId: 'call_same', output: '命中 1 条\n12:41:07 502 gateway\n(end)' });
  const closeSame = (claim: string) =>
    frozen.store.closeStep({
      stepId: same.stepId,
      status: 'confirmed' as const,
      verdict: '同一毫秒内收了两次',
      confidence: 0.7,
      evidence: [{ callRef: '#1', anchor: '2', claim, occurredAt: '12:41:07', actor: 'gateway' }],
    });
  await closeSame('第一批的说法');
  await closeSame('第二批的说法');
  const sameRows = evRows(same.stepId);
  check(
    '两次 close 落在同一毫秒里也只剩后一批（边界是 events.seq，不是时间戳）',
    sameRows.length === 1 && sameRows[0]?.claim === '第二批的说法',
    `${sameRows.length} 条：${sameRows.map((r) => r.claim).join(' / ')}` +
      `（拿时间戳当边界的话这儿是 2 条：observed_at 与上次的 t_end 全等，谁都不比谁大）`,
  );
  frozen.endSession();

  // 🔴 **一批证据落到一半失败，留下的是永远删不掉的孤儿。** `replaceEvidenceBatch` 只删
  // `seq < 上次 closed_seq` 的行，而半批的 seq 比它大——重试时完整的一批落进来，那半批还在旁边躺着。
  //
  // 制造失败的手法是**让第二条证据拿到一个已经用过的 id**（`evidence_refs.id` 是主键）：
  // 注入点在会话自己的 id 生成器上，生产路径上一个开关都不用加
  let atomicIds = 0;
  let collide = false;
  const atomic = createInvestigationSession(
    db,
    {
      caseId: 'case_atomic',
      sessionId: 'sess_atomic',
      backend: 'claude',
      blobDir: blobs,
      isTimestampedSource: () => true,
      now: () => Date.now(),
      newId: (prefix) => (collide && prefix === 'ev' ? 'ev_collide' : `${prefix}_atomic_${++atomicIds}`),
      runOperator: async () => ({ answer: '' }),
    },
    {
      title: '一批落到一半失败',
      question: '一批落到一半失败',
      projectRoot: null,
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    },
  );
  const half = await atomic.store.openStep({ direction: '这一步的第二批会在中途炸掉' });
  atomic.recordToolStart({ callId: 'call_atomic', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  atomic.recordToolEnd({ callId: 'call_atomic', output: '命中 2 条\n12:41:07 a\n12:41:08 b\n(end)' });
  await atomic.store.closeStep({
    stepId: half.stepId,
    status: 'confirmed',
    verdict: '第一批，正常落下',
    confidence: 0.8,
    evidence: [{ callRef: '#1', anchor: '2', claim: '第一批那条', occurredAt: '12:41:07', actor: 'app' }],
  });
  const evOfStep = () =>
    JSON.stringify(
      db
        .prepare(`SELECT id, claim, seq FROM evidence_refs WHERE step_id=? ORDER BY seq`)
        .all(half.stepId),
    );
  const beforeHalf = { ev: evOfStep(), events: eventCount(), step: JSON.stringify(stepRowOf(half.stepId)) };
  collide = true;
  const blewUp = await atomic.store
    .closeStep({
      stepId: half.stepId,
      status: 'confirmed',
      verdict: '第二批，第二条会撞主键',
      confidence: 0.9,
      evidence: [
        { callRef: '#1', anchor: '2', claim: '第二批的第一条', occurredAt: '12:41:07', actor: 'app' },
        { callRef: '#1', anchor: '3', claim: '第二批的第二条（撞主键）', occurredAt: '12:41:08', actor: 'app' },
      ],
    })
    .then(() => null)
    .catch((e: Error) => e.message);
  check(
    '一批证据落到一半失败：整批回滚，证据、events 与 closed_seq 与出事前逐字相同',
    blewUp !== null &&
      evOfStep() === beforeHalf.ev &&
      eventCount() === beforeHalf.events &&
      JSON.stringify(stepRowOf(half.stepId)) === beforeHalf.step,
    `抛出=${blewUp ?? '(竟然没抛)'} · 证据 ${beforeHalf.ev} → ${evOfStep()} · ` +
      `events ${beforeHalf.events} → ${eventCount()} · 步 ${beforeHalf.step} → ${JSON.stringify(stepRowOf(half.stepId))}` +
      `（一条一条各提交各的话，第一条已经落库、closed_seq 还停在上一批——那条孤儿的 seq 比它大，往后再也删不掉）`,
  );

  // 🔴 **落一次工具输出也是两条事件（`recordToolEnd`：`blob.stored` → `toolcall.completed`）。**
  // 第二条失败而第一条已提交的话，blob 与 payload_fts 在库里、调用却还是 pending：下次启动
  // `sweepZombies` 把它改判 abandoned 并换成"已放弃"那个 blob，真实输出成了没人引用的 blob
  // 加一条搜得到却指不回去的 FTS 行。
  //
  // 制造失败的手法同上——让会话自己递进来的值撞库里的约束：`tool_calls.status` 有 CHECK，
  // 一个不在集合里的 status 会在第二条事件的投影 UPDATE 上炸掉，事件行已经 INSERT 了、
  // 第一条事件连同它的 blob / FTS 行都已在同一个外层事务里。生产路径上一个开关都不用加。
  //
  // 文件是在事务外写的：回滚只收回库里的行，所以还要看那个文件有没有跟着走——留着的话
  // 库里没有任何一行指得到它，删调查与启动清扫都找不着，每失败一次就多漏一份
  collide = false;
  atomic.recordToolStart({ callId: 'call_atomic2', toolName: 'mcp__datasource__query_logs', input: { q: 'y' } });
  const orphanText = '命中 1 条\n12:41:09 这份输出的第二条事件会炸\n(end)';
  const tableDump = (sql: string) => JSON.stringify(db.prepare(sql).all());
  const endState = () => ({
    blobs: tableDump(`SELECT sha256, size, line_count FROM blobs ORDER BY sha256`),
    fts: tableDump(`SELECT sha256, case_id FROM payload_fts WHERE case_id='case_atomic' ORDER BY sha256`),
    calls: tableDump(`SELECT id, status, output_sha256, ended_at FROM tool_calls WHERE session_id='sess_atomic' ORDER BY id`),
    events: eventCount(),
  });
  const beforeEnd = endState();
  let endBlewUp: string | null = null;
  try {
    atomic.recordToolEnd({
      callId: 'call_atomic2',
      output: orphanText,
      status: 'not_a_status' as unknown as 'done',
    });
  } catch (e) {
    endBlewUp = (e as Error).message;
  }
  const afterEnd = endState();
  const orphanFile = path.join(blobs, createHash('sha256').update(orphanText).digest('hex'));
  const trashLeft = (db.prepare(`SELECT COUNT(*) c FROM blob_trash`).get() as { c: number }).c;
  check(
    '工具输出落到一半失败：整次回滚，blobs、payload_fts、tool_calls 与 events 与出事前逐字相同，文件也不残留',
    endBlewUp !== null &&
      afterEnd.blobs === beforeEnd.blobs &&
      afterEnd.fts === beforeEnd.fts &&
      afterEnd.calls === beforeEnd.calls &&
      afterEnd.events === beforeEnd.events &&
      !existsSync(orphanFile) &&
      trashLeft === 0,
    `抛出=${endBlewUp ?? '(竟然没抛)'} · ` +
      (['blobs', 'fts', 'calls'] as const)
        .map((k) => {
          const rows = (v: string) => (JSON.parse(v) as unknown[]).length;
          return `${k} ${beforeEnd[k] === afterEnd[k] ? '同' : `${rows(beforeEnd[k])} 行 → ${rows(afterEnd[k])} 行`}`;
        })
        .join(' · ') +
      ` · events ${beforeEnd.events} → ${afterEnd.events} · 文件${existsSync(orphanFile) ? '还在' : '已清'} · blob_trash 欠 ${trashLeft}` +
      `（各提交各的话 blob 与 FTS 行已在、调用仍是 pending，下次启动 sweepZombies 就把它判成 abandoned）`,
  );
  atomic.endSession();

  // 🔴 **文件写完、事务提交前进程被掐（SIGKILL / 断电）。**catch 跑不到，库里回滚得干干净净，
  // 文件却留下了——只有"写文件之前就把欠账记进库"才接得住，启动时的 `emptyBlobTrash`
  // 按引用复核一遍再删。这一段真杀进程：子进程里会话自己的 `now()` 看见 blob 文件出现在
  // 磁盘上就 SIGKILL 自己——那一刻正好在文件落盘之后、任何事件提交之前
  const killDir = mkdtempSync(path.join(tmpdir(), 'inquestry-kill-'));
  const killDb = path.join(killDir, 'inquestry.db');
  const killText = '命中 1 条\n12:41:10 写完文件就被掐\n(end)';
  const killFile = path.join(blobDir(killDb), createHash('sha256').update(killText).digest('hex'));
  const childSrc = path.join(killDir, 'child.ts');
  writeFileSync(
    childSrc,
    `
import { existsSync } from 'node:fs';
import { blobDir, openDatabase } from ${JSON.stringify(path.resolve('src/backend/db/database.ts'))};
import { createInvestigationSession } from ${JSON.stringify(path.resolve('src/backend/store/sqlite-store.ts'))};
const db = openDatabase(${JSON.stringify(killDb)});
let armed = false;
let ids = 0;
const s = createInvestigationSession(
  db,
  {
    caseId: 'case_kill', sessionId: 'sess_kill', backend: 'claude', blobDir: blobDir(${JSON.stringify(killDb)}),
    isTimestampedSource: () => true,
    now: () => { if (armed && existsSync(${JSON.stringify(killFile)})) process.kill(process.pid, 'SIGKILL'); return Date.now(); },
    newId: (p) => p + '_kill_' + (++ids),
    runOperator: async () => ({ answer: '' }),
  },
  { title: 'kill', question: 'kill', projectRoot: null, incidentDate: '2026-08-09', tzOffset: '+08:00', clues: null },
);
s.recordToolStart({ callId: 'call_kill', toolName: 'mcp__datasource__query_logs', input: { q: 'z' } });
armed = true;
s.recordToolEnd({ callId: 'call_kill', output: ${JSON.stringify(killText)} });
console.log('NOT KILLED');
`,
  );
  const child = spawnSync(path.resolve('node_modules/.bin/tsx'), [childSrc], { encoding: 'utf8' });
  // tsx 的 bin 外面还套着一层 node：里面那层被 SIGKILL 时，外层以 128+9 退出而不是带 signal
  const childKilled = (child.signal === 'SIGKILL' || child.status === 137) && !child.stdout.includes('NOT KILLED');
  const kdb = openDatabase(killDb);
  const killRows = () => ({
    blob: (kdb.prepare(`SELECT COUNT(*) c FROM blobs WHERE sha256=?`).get(path.basename(killFile)) as { c: number }).c,
    call: (kdb.prepare(`SELECT status FROM tool_calls WHERE id='call_kill'`).get() as { status: string } | undefined)?.status,
    owed: (kdb.prepare(`SELECT COUNT(*) c FROM blob_trash WHERE sha256=?`).get(path.basename(killFile)) as { c: number }).c,
    file: existsSync(killFile),
  });
  const killed = killRows();
  const killSweep = emptyBlobTrash(kdb, { blobDir: blobDir(killDb) });
  const afterSweep = killRows();
  check(
    '文件写完、事务提交前被 SIGKILL：库里干净、欠账在，启动清扫把那份文件删掉',
    childKilled &&
      killed.file &&
      killed.blob === 0 &&
      killed.call === 'pending' &&
      killed.owed === 1 &&
      killSweep.removed === 1 &&
      !afterSweep.file &&
      afterSweep.owed === 0,
    `子进程 ${childKilled ? '被杀' : `没被杀（status=${child.status} signal=${child.signal} ${child.stdout.trim() || child.stderr.trim().slice(0, 120)}）`} · ` +
      `被掐那一刻 文件${killed.file ? '在' : '不在'} blobs=${killed.blob} call=${killed.call} 欠账=${killed.owed} · ` +
      `清扫 removed=${killSweep.removed} 之后 文件${afterSweep.file ? '还在' : '已清'} 欠账=${afterSweep.owed}` +
      `（先写文件再记欠账的话，欠账=0 而文件在：谁也不知道该去删它）`,
  );
  kdb.close();

  // 声明跟着它那一步一起失效：形态说的是"结论属于哪一类"，结论作废了这句话也就不成立
  const cDead = makeRunner('case_shape_dead', '声明被推翻');
  const sDead = (cDead as unknown as Probe).beginSession();
  const wrongRoot = await work(sDead, {
    direction: '只有某一批用户中招',
    callId: 'call_sd1',
    occurredAt: '08:00:00',
    shape: 'distribution',
  });
  check(
    '推翻之前：这条声明算数',
    suggestVerdictShape(db, 'case_shape_dead').shape === 'distribution',
    `建议=${JSON.stringify(suggestVerdictShape(db, 'case_shape_dead'))}`,
  );
  const newRoot = await sDead.store.openStep({ direction: '不是分布问题，是配置一直就错的' });
  await sDead.store.closeStep({
    stepId: newRoot.stepId,
    status: 'confirmed',
    verdict: '连接池上限从上线起就写成了 5',
    confidence: 0.95,
    expected: '连接池上限 200',
    actual: '实际配置里是 5，且从未改过',
    supersedes: [wrongRoot.stepId],
    evidence: [],
  });
  check(
    '被推翻的那一步的形态声明跟着失效，不能拿它去装报告',
    suggestVerdictShape(db, 'case_shape_dead').shape === 'state',
    `建议=${JSON.stringify(suggestVerdictShape(db, 'case_shape_dead'))}（照旧认 distribution 的话，报告会按一份作废的判断装块）`,
  );
  check(
    '应然实然跟着根因那一步走：换了根因，报告里那一对也跟着换',
    cDead.snapshot().report.expected === '连接池上限 200' &&
      cDead.snapshot().report.actual?.startsWith('实际配置里是 5') === true,
    `本该=${cDead.snapshot().report.expected} · 实际=${cDead.snapshot().report.actual}`,
  );
  cDead.close();

  // 填了但不生效的三种，必须当场说——不说的话 agent 以为自己交代过了，
  // 而报告要到定稿那天才发现那一块是空的
  const cWarn = makeRunner('case_shape_warn', '形态的三条当场提醒');
  const sWarn = (cWarn as unknown as Probe).beginSession();
  const halfBaked = await sWarn.store.openStep({ direction: '这个假设不成立' });
  const w1 = await sWarn.store.closeStep({
    stepId: halfBaked.stepId,
    status: 'refuted',
    verdict: '不是这个原因',
    confidence: 0.8,
    shape: 'state',
    evidence: [],
  });
  check(
    '形态声明在非 confirmed 的结论上要当场提醒，且不生效',
    w1.warnings.some((t) => t.includes('不会生效')) &&
      suggestVerdictShape(db, 'case_shape_warn').source === 'inferred',
    `warnings=${w1.warnings.length} 条 · 建议=${JSON.stringify(suggestVerdictShape(db, 'case_shape_warn'))}`,
  );
  // 纯空白能过 z.string()，而所有完整性判断都是 truthiness——不归一的话既不报
  // "缺主体"，stateFillable 也成了 true，报告最后拿到一块视觉上的空白
  const blankStep = await sWarn.store.openStep({ direction: '看起来填了其实没填' });
  const wBlank = await sWarn.store.closeStep({
    stepId: blankStep.stepId,
    status: 'confirmed',
    verdict: '空白当没填',
    confidence: 0.1,
    shape: 'state',
    expected: '   ',
    actual: '\t',
    evidence: [],
  });
  const blankRow = db.prepare(`SELECT expected, actual FROM steps WHERE id=?`).get(blankStep.stepId) as {
    expected: string | null;
    actual: string | null;
  };
  check(
    '纯空白的应然实然按没填算：照样报"这一块装不出来"，也不落进库里',
    // 认那条警告的稳定标识（形态名），不认它的措辞：文案改一次这个检查就会假红
    wBlank.warnings.some((t) => t.includes('状态型（state）')) &&
      blankRow.expected === null &&
      blankRow.actual === null,
    `warnings=${JSON.stringify(wBlank.warnings)} · 库里=${JSON.stringify(blankRow)}`,
  );

  const stateStep = await sWarn.store.openStep({ direction: '索引一直就没建上' });
  const w2 = await sWarn.store.closeStep({
    stepId: stateStep.stepId,
    status: 'confirmed',
    verdict: '缺索引',
    confidence: 0.9,
    shape: 'state',
    expected: '本该有 idx_order_uid',
    evidence: [],
  });
  check(
    '状态型缺了应然实然、或只给一半，都要当场提醒（那一对就是它的报告主体）',
    w2.warnings.filter((t) => t.includes('expected')).length === 2,
    `warnings=${JSON.stringify(w2.warnings)}`,
  );
  // kind 对了也可能不生效：报告的根因取的是置信度最高那条 normal，
  // 声明在一条置信度更低的 normal 上同样会被忽略。这条只有落库之后才判得出来
  const alsoNormal = await sWarn.store.openStep({ direction: '另一条没那么有把握的结论' });
  const w3 = await sWarn.store.closeStep({
    stepId: alsoNormal.stepId,
    status: 'confirmed',
    verdict: '也可能是这个',
    confidence: 0.4,
    shape: 'chain',
    evidence: [],
  });
  check(
    '声明在一条当前不是根因的 normal step 上，也要当场说它不生效',
    w3.warnings.some((t) => t.includes(stateStep.stepId)) &&
      suggestVerdictShape(db, 'case_shape_warn').shape === 'state',
    `warnings=${JSON.stringify(w3.warnings)} · 建议=${JSON.stringify(suggestVerdictShape(db, 'case_shape_warn'))}`,
  );
  // 只陈述事实，不教它怎么让自己那条算数：写"把那条根因推翻"等于诱导它去推翻一条
  // 有效结论、或把置信度往上凑，而该不该推翻只有查过的它自己判得了
  check(
    '这句话只说现状，不给「去推翻它」这类处置',
    !w3.warnings.some((t) => t.includes('推翻')),
    `warnings=${JSON.stringify(w3.warnings)}`,
  );
  cWarn.close();

  // ── ⑦.6 「下一步怎么查」：报告里唯一由 agent 生成的那一块（overview §6.1） ────
  //
  // 只认 leftover 步、只进未决型报告——已决型不留修复建议，方案由动手修的人评估。
  // 这一带的错法有三个形状：
  // ① 别的步上填了不吭声 —— 那段文字安静地消失（收窄成只认 leftover 之前，
  //    根因步上的修复方案反过来顶掉过 leftover 步上的续查方向，case_1baca6bb 真发生过）
  // ② 不跟着结论失效 —— 报告里躺一条基于作废汇总的建议
  // ③ 有了根因还提醒补 —— 已决型压根没有这一节，讨来的字没人看
  const cFix = makeRunner('case_fix', '已决型没有下一步怎么查');
  const sFix = (cFix as unknown as Probe).beginSession();
  const fixRoot = await work(sFix, {
    direction: '扩容时复用了旧连接池配置',
    callId: 'call_fx1',
    occurredAt: '09:10:00',
    remediation: '把 pool_size 改成按实例算，并给扩容流程补一条校验',
  });
  check(
    '根因步上填的 remediation 当场被点破，且不进报告',
    fixRoot.warnings.some((t) => t.includes('不会出现在报告里')) &&
      cFix.snapshot().report.remediation === null,
    `warnings=${JSON.stringify(fixRoot.warnings)} · 快照=${cFix.snapshot().report.remediation}（静默丢弃的话，agent 永远学不到这一栏搬了家）`,
  );
  // 已决型的 leftover 收口不讨「下一步怎么查」：这份报告压根没有那一节
  const fixLeft = await sFix.store.openStep({ direction: '汇总未查清的问题', kind: 'leftover' });
  const fixLeftClosed = await sFix.store.closeStep({
    stepId: fixLeft.stepId,
    status: 'inconclusive',
    verdict: '旧连接池配置为什么没被清理，没查',
    confidence: 0.3,
    evidence: [],
  });
  check(
    '已经有根因时，收 leftover 步不再讨「下一步怎么查」',
    !fixLeftClosed.warnings.some((t) => t.includes('下一步怎么查')),
    `warnings=${JSON.stringify(fixLeftClosed.warnings)}`,
  );
  cFix.close();

  // 未决型才是这一栏的场景：一条已证实的结论都没有时，"下一步该怎么查"是报告里
  // 唯一由 agent 生成的一块，收 leftover 步就是补它的时刻
  const cFixOpen = makeRunner('case_fix_open', '没查出来但有下一步');
  const sFixOpen = (cFixOpen as unknown as Probe).beginSession();
  const openLeft = await sFixOpen.store.openStep({ direction: '汇总未查清的问题', kind: 'leftover' });
  const bareLeft = await sFixOpen.store.closeStep({
    stepId: openLeft.stepId,
    status: 'inconclusive',
    verdict: '网关日志只留了 3 天，查不到事发当天',
    confidence: 0.2,
    evidence: [],
  });
  check(
    '未决型收 leftover 步而那一栏还空着时，close_step 当场提醒',
    bareLeft.warnings.some((t) => t.includes('下一步怎么查')),
    `warnings=${JSON.stringify(bareLeft.warnings)}（不说的话，agent 交代完就走了，那一栏要到定稿那天才发现是空的）`,
  );
  // 提醒里写的正是"重新 close 只补这一项"——那条路必须真走得通
  const filledLeft = await sFixOpen.store.closeStep({
    stepId: openLeft.stepId,
    status: 'inconclusive',
    verdict: '网关日志只留了 3 天，查不到事发当天',
    confidence: 0.2,
    remediation: '先把网关日志留存改成 30 天，下次再出就有原始记录可查',
    evidence: [],
  });
  check(
    '补上之后进报告，且不再提醒（否则每次 close 都要挨一句）',
    !filledLeft.warnings.some((t) => t.includes('下一步怎么查')) &&
      cFixOpen.snapshot().report.rootCause === null &&
      cFixOpen.snapshot().report.remediation?.startsWith('先把网关日志') === true,
    `warnings=${JSON.stringify(filledLeft.warnings)} · 快照=${cFixOpen.snapshot().report.remediation}`,
  );
  // 与形态、应然实然同一个 patch 语义：补一次不带它，不能当成"清空"
  await sFixOpen.store.closeStep({
    stepId: openLeft.stepId,
    status: 'inconclusive',
    verdict: '网关日志只留了 3 天，查不到事发当天（补一句）',
    confidence: 0.2,
    evidence: [],
  });
  check(
    '同一步再 close 一次没重填时，「下一步怎么查」保持原样',
    cFixOpen.snapshot().report.remediation?.startsWith('先把网关日志') === true,
    `快照=${cFixOpen.snapshot().report.remediation}（当成清空的话，补一句结论就把报告那一栏抹了）`,
  );
  // 只补这一项也要能改得掉
  await sFixOpen.store.closeStep({
    stepId: openLeft.stepId,
    status: 'inconclusive',
    verdict: '网关日志只留了 3 天，查不到事发当天',
    confidence: 0.2,
    remediation: '改口：直接找 ops 把当天的原始日志从冷备里捞出来',
    evidence: [],
  });
  check(
    '重新填就覆盖，不是只写得进去一次',
    cFixOpen.snapshot().report.remediation?.startsWith('改口：') === true,
    `快照=${cFixOpen.snapshot().report.remediation}`,
  );
  // 建议基于"还有什么没查清"：leftover 步被重做顶掉时，旧建议跟着失效
  const redoLeft = await sFixOpen.store.openStep({ direction: '汇总未查清的问题（重列）', kind: 'leftover' });
  await sFixOpen.store.closeStep({
    stepId: redoLeft.stepId,
    status: 'inconclusive',
    verdict: '重新汇总：其实卡在没有网关的访问权限',
    confidence: 0.3,
    supersedes: [openLeft.stepId],
    evidence: [],
  });
  check(
    '被顶掉的 leftover 步上的建议跟着失效，报告那一栏回到「无」',
    cFixOpen.snapshot().report.remediation === null,
    `快照=${cFixOpen.snapshot().report.remediation}（照旧印的话，报告里躺的是基于作废汇总的下一步）`,
  );
  // 派回去补的那条消息：**未决型且缺建议时才捎上**。它不是强制 step，不该为它单发一条
  check(
    '缺「下一步怎么查」时，派活的消息里捎上它；不缺就不提',
    closingMessage(['impact'], true).includes('remediation') &&
      !closingMessage(['impact'], false).includes('remediation'),
    closingMessage(['impact'], true),
  );
  cFixOpen.close();

  // ── 产出物：名单与指标（overview.md 的「产出物」）──────────────────────
  //
  // 这一带的错法全是**静默**的，且都落在"口径"上：
  //   1. 抄重的 id 不去掉 —— 报告上那个条数虚高，而它正是人拿去汇报、拿去做处置的数
  //   2. 名单挂在被推翻/没查清的结论上照旧进报告 —— 一份没有出处的名单
  //   3. metrics 填错步（不是影响面那一步）就此消失，而 agent 以为自己交代过了
  //   4. 重新 close 一次不带名单被当成"清空" —— 补一句结论就把整份名单抹了
  const cDeliv = makeRunner('case_deliv', '排查关联小号');
  const sDeliv = (cDeliv as unknown as Probe).beginSession();

  // 抄重的一份：16 条里有 2 条是重的，真实只有 3 个不同的 id
  const dupStep = await sDeliv.store.openStep({ direction: '我怀疑这台设备上还挂着别的账号' });
  sDeliv.recordToolStart({ callId: 'call_dv1', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  sDeliv.recordToolEnd({ callId: 'call_dv1', output: '命中 3 条\nu_a u_b u_c\n(end)' });
  const dup = await sDeliv.store.closeStep({
    stepId: dupStep.stepId,
    status: 'confirmed',
    verdict: '同设备上一共 5 个账号',
    confidence: 0.9,
    roster: {
      label: '关联账号',
      idKind: 'userId',
      complete: false,
      basis: '按设备指纹两跳聚合',
      items: [
        { id: 'u_a' },
        { id: ' u_b ' },
        { id: 'u_a', note: '被举报本号' },
        { id: '' },
        { id: 'u_c' },
        { id: 'u_b' },
      ],
    },
    evidence: [{ callRef: '#1', anchor: '2', claim: '设备文档里列着这几个账号', actor: 'device-service' }],
  });
  const roster1 = cDeliv.snapshot().report.roster;
  check(
    '名单去重、去空白、丢空条目，并把去重后的条数回给 agent',
    roster1?.roster.items.map((i) => i.id).join(',') === 'u_a,u_b,u_c' && dup.rosterCount === 3,
    `items=${JSON.stringify(roster1?.roster.items)} · rosterCount=${dup.rosterCount}（不去重的话报告上那个条数虚高，而它正是人拿去做处置的数）`,
  );
  check(
    '重复条目的备注不丢：手抄时补注多半只写在其中一条上',
    roster1?.roster.items.find((i) => i.id === 'u_a')?.note === '被举报本号',
    JSON.stringify(roster1?.roster.items),
  );
  check(
    '去掉了几条要当场说，且提醒里点名让它回头核对 verdict 里那个数',
    dup.warnings.some((t) => t.includes('重复') && t.includes('核对')),
    `warnings=${JSON.stringify(dup.warnings)}（静默去重的话，报告上的条数与 agent 自己写的对不上，而两个数都印在同一份报告上）`,
  );

  // 名单挂在没查清的结论上：不进报告，且当场说
  const weakStep = await sDeliv.store.openStep({ direction: '我怀疑 IP 段上还能捞出更多' });
  const weak = await sDeliv.store.closeStep({
    stepId: weakStep.stepId,
    status: 'inconclusive',
    verdict: '没跑成',
    confidence: 0.2,
    roster: { label: '疑似账号', idKind: 'userId', complete: false, basis: '猜的', items: [{ id: 'u_z' }] },
    evidence: [],
  });
  check(
    '名单声明在没查清的结论上不进报告，且当场点破',
    cDeliv.snapshot().report.roster?.stepId === dupStep.stepId &&
      weak.warnings.some((t) => t.includes('名单') && t.includes('已证实')),
    `快照出自=${cDeliv.snapshot().report.roster?.stepId} · warnings=${JSON.stringify(weak.warnings)}`,
  );

  // 同一步再 close 一次不带名单：保持原样，不是清空（与形态、应然实然同一个 patch 语义）
  const again = await sDeliv.store.closeStep({
    stepId: dupStep.stepId,
    status: 'confirmed',
    verdict: '同设备上一共 5 个账号（补一句）',
    confidence: 0.9,
    evidence: [],
  });
  check(
    '再 close 一次没重填名单时保持原样，回执也不再报条数',
    cDeliv.snapshot().report.roster?.roster.items.length === 3 && again.rosterCount === undefined,
    `快照=${JSON.stringify(cDeliv.snapshot().report.roster?.roster.items)} · rosterCount=${again.rosterCount}（当成清空的话，补一句结论就把整份名单抹了）`,
  );

  // 后交的那份顶掉先交的，且当场说清现在生效的是哪一条
  const redoRoster = await sDeliv.store.openStep({ direction: '我怀疑还有第三台设备' });
  sDeliv.recordToolStart({ callId: 'call_dv2', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  sDeliv.recordToolEnd({ callId: 'call_dv2', output: '命中 4 条\nu_a u_b u_c u_d\n(end)' });
  await sDeliv.store.closeStep({
    stepId: redoRoster.stepId,
    status: 'confirmed',
    verdict: '第三台设备带出第 4 个账号',
    confidence: 0.85,
    roster: {
      label: '关联账号',
      idKind: 'userId',
      complete: true,
      basis: '三跳后收敛，无新账号',
      items: [{ id: 'u_a' }, { id: 'u_b' }, { id: 'u_c' }, { id: 'u_d' }],
    },
    evidence: [{ callRef: '#1', anchor: '2', claim: '第三台设备的 users 数组', actor: 'device-service' }],
  });
  const stale = await sDeliv.store.closeStep({
    stepId: dupStep.stepId,
    status: 'confirmed',
    verdict: '同设备上一共 5 个账号',
    confidence: 0.9,
    roster: { label: '关联账号', idKind: 'userId', complete: false, basis: '按设备指纹两跳聚合', items: [{ id: 'u_a' }] },
    evidence: [],
  });
  check(
    '报告取最新那份名单，被顶掉的那一份当场收到「目前不生效」',
    cDeliv.snapshot().report.roster?.stepId === redoRoster.stepId &&
      stale.warnings.some((t) => t.includes('目前不生效')),
    `出自=${cDeliv.snapshot().report.roster?.stepId} · warnings=${JSON.stringify(stale.warnings)}`,
  );

  // 指标只认影响面那一步
  const strayMetric = await sDeliv.store.openStep({ direction: '我怀疑注册链路没查设备封禁态' });
  const strayM = await sDeliv.store.closeStep({
    stepId: strayMetric.stepId,
    status: 'confirmed',
    verdict: '三层防线都是空的',
    confidence: 0.82,
    metrics: [{ label: '受害者数', value: '2', bound: 'lower', basis: '近 30 天' }],
    evidence: [],
  });
  check(
    '指标填在非影响面的步上不进报告，且当场点破',
    cDeliv.snapshot().report.metrics.length === 0 &&
      strayM.warnings.some((t) => t.includes('metrics') && t.includes('影响面')),
    `快照=${JSON.stringify(cDeliv.snapshot().report.metrics)} · warnings=${JSON.stringify(strayM.warnings)}`,
  );

  const impactStep = await sDeliv.store.openStep({ direction: '量化影响面', kind: 'impact' });
  await sDeliv.store.closeStep({
    stepId: impactStep.stepId,
    status: 'confirmed',
    verdict: '不是个案',
    confidence: 0.75,
    metrics: [
      { label: '受害者数', value: '2', bound: 'lower', basis: '近 30 天，日志保留期限制' },
      { label: '时间跨度', value: '375 天', bound: 'exact', basis: '首个账号到最后一个' },
      // 缺值的那条：印出来是一行空格，该丢掉并出声
      { label: '存量未封', value: '  ', bound: 'exact', basis: '' },
    ],
    evidence: [],
  });
  const metrics = cDeliv.snapshot().report.metrics;
  check(
    '影响面那一步的指标进报告，缺值的丢掉并出声',
    metrics.length === 2 && metrics[0]?.bound === 'lower' && metrics[1]?.value === '375 天',
    `快照=${JSON.stringify(metrics)}（不丢的话，报告的指标表里会有一行只有名字的空格）`,
  );

  // 口径是这两个类型存在的理由，而 `z.string()` 拦不住一串空格
  const noBasisStep = await sDeliv.store.openStep({ direction: '我怀疑还有第四台设备' });
  sDeliv.recordToolStart({ callId: 'call_dv3', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  sDeliv.recordToolEnd({ callId: 'call_dv3', output: '命中 1 条\nu_e\n(end)' });
  const blank = await sDeliv.store.closeStep({
    stepId: noBasisStep.stepId,
    status: 'confirmed',
    verdict: '第四台设备',
    confidence: 0.9,
    roster: { label: '关联账号', idKind: 'userId', complete: false, basis: '   ', items: [{ id: 'u_e' }] },
    evidence: [{ callRef: '#1', anchor: '1', claim: '第四台设备的 users 数组', actor: 'device-service' }],
  });
  check(
    '只写空格的口径被当场点破，落库时归一成空',
    blank.warnings.some((t) => t.includes('basis') && t.includes('口径')) &&
      cDeliv.snapshot().report.roster?.roster.basis === '',
    `warnings=${JSON.stringify(blank.warnings)} · basis=${JSON.stringify(cDeliv.snapshot().report.roster?.roster.basis)}（"   " 有长度、过得了 z.string()，于是报告上会是一份写着"下界，不是全集"却没有一个字解释为什么不全的名单）`,
  );

  // 长名单：长图那条链路上这是硬边，不是手感——超预算的单块自成一页，
  // 而 Page.captureScreenshot 到万把像素直接失败，表现是导出整个不成
  const longStep = await sDeliv.store.openStep({ direction: '我怀疑受影响的订单不止这些' });
  sDeliv.recordToolStart({ callId: 'call_dv4', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  sDeliv.recordToolEnd({ callId: 'call_dv4', output: '命中很多\n(end)' });
  const long = await sDeliv.store.closeStep({
    stepId: longStep.stepId,
    status: 'confirmed',
    verdict: '受影响订单 600 笔',
    confidence: 0.9,
    roster: {
      label: '受影响订单',
      idKind: 'orderId',
      // **声明成全集**：截断之后它必须被按下界处理，否则纸上印着"全集"而底下少了一百条
      complete: true,
      basis: '按 cart_key 聚合',
      items: Array.from({ length: 600 }, (_, i) => ({ id: `ord_${i}` })),
    },
    evidence: [{ callRef: '#1', anchor: '1', claim: '600 笔', actor: 'ledger' }],
  });
  const cut = cDeliv.snapshot().report.roster?.roster;
  check(
    '超长名单截断、强制按下界处理，并印出截掉了多少',
    cut?.items.length === 500 && cut.truncated === 100 && cut.complete === false &&
      long.warnings.some((t) => t.includes('截')),
    `条数=${cut?.items.length} · truncated=${cut?.truncated} · complete=${cut?.complete} · warnings=${JSON.stringify(long.warnings)}（不截的话长图那一头是直接断的，不是慢；不置成下界的话纸上印着"全集"而底下少了一百条）`,
  );

  // 「缺省=不动」认的是"这个键没给"，不是"给出来是空的"。两个字段的答案不一样，
  // 各验一条：显式 `[]` 要清得掉指标，而空名单不成其为名单，保持原样并当场说清
  const clearStep = await sDeliv.store.openStep({ direction: '重算影响面', kind: 'impact' });
  await sDeliv.store.closeStep({
    stepId: clearStep.stepId,
    status: 'confirmed',
    verdict: '先量一版',
    confidence: 0.8,
    metrics: [{ label: '受害者数', value: '9', bound: 'exact', basis: '第一版' }],
    evidence: [],
  });
  const hadMetrics = cDeliv.snapshot().report.metrics.length;
  await sDeliv.store.closeStep({
    stepId: clearStep.stepId,
    status: 'confirmed',
    verdict: '重算之后一个都不剩',
    confidence: 0.8,
    metrics: [],
    evidence: [],
  });
  const clearedByEmpty = cDeliv.snapshot().report.metrics.length;
  await sDeliv.store.closeStep({
    stepId: clearStep.stepId,
    status: 'confirmed',
    verdict: '只补一句话',
    confidence: 0.8,
    metrics: [{ label: '受害者数', value: '9', bound: 'exact', basis: '第一版' }],
    evidence: [],
  });
  const backAgain = cDeliv.snapshot().report.metrics.length;
  await sDeliv.store.closeStep({
    stepId: clearStep.stepId,
    status: 'confirmed',
    verdict: '再补一句，这次连键都不给',
    confidence: 0.8,
    evidence: [],
  });
  check(
    '显式给 metrics: [] 能把上一次的指标清掉；不给这个键才是"不动"',
    hadMetrics === 1 && clearedByEmpty === 0 && backAgain === 1 && cDeliv.snapshot().report.metrics.length === 1,
    `第一版=${hadMetrics} · 给空数组之后=${clearedByEmpty} · 再填回来=${backAgain} · 不给键=${cDeliv.snapshot().report.metrics.length}（按 value.length 判的话，重算之后写 [] 会被当成没给，旧指标留在报告里且不出声）`,
  );

  const emptyRosterStep = await sDeliv.store.openStep({ direction: '重列名单' });
  const emptyRoster = await sDeliv.store.closeStep({
    stepId: emptyRosterStep.stepId,
    status: 'confirmed',
    verdict: '一个都没剩',
    confidence: 0.9,
    roster: { label: '关联账号', idKind: 'userId', complete: false, basis: '重列', items: [] },
    evidence: [],
  });
  check(
    '空名单不成其为名单：保持原样，并当场说清真要撤掉该怎么做',
    cDeliv.snapshot().report.roster !== null &&
      emptyRoster.warnings.some((t) => t.includes('保持原样') && t.includes('推翻')),
    `名单还在=${cDeliv.snapshot().report.roster !== null} · warnings=${JSON.stringify(emptyRoster.warnings)}（落一个空的进去，读侧会把它判成坏列并喊一声——而那不是坏数据，是 agent 的意图）`,
  );

  // 名单**不认 kind**：「受影响的订单」落在影响面那一步上同样正当（`effectiveRoster` 的契约，
  // 工具描述与 seed 夹具都按这个来）。单开一个 runner，免得搅乱上面那几条对生效名单的断言
  const cKind = makeRunner('case_roster_kind', '名单落在影响面步上');
  const sKind = (cKind as unknown as Probe).beginSession();
  const kindImpact = await sKind.store.openStep({ direction: '量化影响面', kind: 'impact' });
  sKind.recordToolStart({ callId: 'call_k1', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  sKind.recordToolEnd({ callId: 'call_k1', output: '命中 2 条\nord_1 ord_2\n(end)' });
  const onImpact = await sKind.store.closeStep({
    stepId: kindImpact.stepId,
    status: 'confirmed',
    verdict: '波及 2 笔订单',
    confidence: 0.8,
    roster: {
      label: '受影响订单',
      idKind: 'orderId',
      complete: true,
      basis: '按 cart_key 全量扫过',
      items: [{ id: 'ord_1' }, { id: 'ord_2' }],
    },
    metrics: [{ label: '受影响订单', value: '2', bound: 'exact', basis: '全量扫过' }],
    evidence: [{ callRef: '#1', anchor: '1', claim: '两笔', actor: 'ledger' }],
  });
  check(
    '名单落在影响面步上照样生效，且不为此报一句"填错地方了"',
    cKind.snapshot().report.roster?.stepId === kindImpact.stepId &&
      !onImpact.warnings.some((t) => t.includes('名单') && t.includes('不生效')),
    `出自=${cKind.snapshot().report.roster?.stepId}（期望 ${kindImpact.stepId}）· warnings=${JSON.stringify(onImpact.warnings)}（工具描述一度写着"confirmed 的 normal 步"，而选择器不认 kind、seed 夹具也把名单放在影响面上——agent 会照描述另开一个多余的步，或者干脆不填）`,
  );
  cKind.close();

  // 影响面步收成 refuted：定稿闸与报告共用 effectiveStep，所以它就此不算数——
  // 而 agent 只会看到定稿闸重新报缺，不当场说的话它多半会再开一个同 kind 的步
  const cRef = makeRunner('case_refuted_impact', '影响面被否掉');
  const sRef = (cRef as unknown as Probe).beginSession();
  const impRef = await sRef.store.openStep({ direction: '我怀疑不止个案', kind: 'impact' });
  await sRef.store.closeStep({
    stepId: impRef.stepId,
    status: 'confirmed',
    verdict: '波及 37 个租户',
    confidence: 0.8,
    metrics: [{ label: '受影响租户', value: '37', bound: 'exact', basis: '全量扫过' }],
    evidence: [],
  });
  const okGate = missingClosingSteps(db, 'case_refuted_impact').includes('impact');
  const refutedImpact = await sRef.store.closeStep({
    stepId: impRef.stepId,
    status: 'refuted',
    verdict: '其实就是个案',
    confidence: 0.8,
    evidence: [],
  });
  check(
    '被否掉的影响面步不再算数：定稿闸重新报缺，报告也不印它的结论与指标',
    !okGate &&
      missingClosingSteps(db, 'case_refuted_impact').includes('impact') &&
      cRef.snapshot().report.impact === null &&
      cRef.snapshot().report.metrics.length === 0,
    `收好时缺口=${okGate} · 否掉后缺口=${JSON.stringify(missingClosingSteps(db, 'case_refuted_impact'))} · 影响面=${cRef.snapshot().report.impact} · 指标=${JSON.stringify(cRef.snapshot().report.metrics)}（只排 superseded 的话，报告上会是"一段被推翻的话 + 一组仍按旧口径算的数"——metrics 走 COALESCE，重新 close 时它照旧留在库里）`,
  );
  check(
    '否掉强制 step 时当场说清后果，不让 agent 只看到定稿闸报缺',
    refutedImpact.warnings.some((t) => t.includes('影响面') && t.includes('confirmed')),
    `warnings=${JSON.stringify(refutedImpact.warnings)}（不说的话它多半会再开一个同 kind 的步，而不是把这一步重新收成 confirmed）`,
  );
  cRef.close();

  // 坏 JSON：报告那侧已经降级成"没有名单"，写入侧不能反而炸
  // ── 工具边界：必填的展示字段挡不挡得住一串空格 ────────────────────────
  //
  // 这几条是 MCP 在调 `run` 之前跑的那一道，所以直接拿 schema 验。
  // `.min(1)` 对 `"   "` 是放行的（长度是 3）——**看着有、其实没有的检查比没有更糟**
  const CLOSE = z.object(closeStepShape);
  const withRoster = (over: Record<string, unknown>) => ({
    stepId: 'st_x',
    status: 'confirmed' as const,
    verdict: 'v',
    confidence: 0.9,
    evidence: [],
    roster: { label: '关联账号', idKind: 'userId', complete: false, basis: '按设备指纹', items: [{ id: 'u_a' }], ...over },
  });
  check(
    '名单的 label / idKind / basis 只写空格时，整次 close_step 在工具边界就被退回',
    (['label', 'idKind', 'basis'] as const).every((k) => !CLOSE.safeParse(withRoster({ [k]: '   ' })).success),
    (['label', 'idKind', 'basis'] as const)
      .map((k) => `${k}=${CLOSE.safeParse(withRoster({ [k]: '   ' })).success ? '放行' : '退回'}`)
      .join(' · ') + '（`.min(1)` 放行 "   "，于是这个"必填"在最常见的绕过方式上恰好不生效）',
  );
  check(
    '带空格的合法值照旧收，且存进去时已经 trim 过',
    (() => {
      const r = CLOSE.safeParse(withRoster({ basis: '  按设备指纹两跳  ' }));
      return r.success && r.data.roster?.basis === '按设备指纹两跳';
    })(),
    '硬退回不能顺带把正常输入也挡掉；trim 掉之后下游拿到的就是能直接印的那个串',
  );
  check(
    '空白的 verdict 在工具边界就退回：报告那几节印的都是它',
    ['', '   '].every(
      (v) => !CLOSE.safeParse({ stepId: 'st_x', status: 'confirmed' as const, verdict: v, confidence: 0.9, evidence: [] }).success,
    ) &&
      CLOSE.safeParse({ stepId: 'st_x', status: 'confirmed' as const, verdict: ' 成立 ', confidence: 0.9, evidence: [] })
        .success,
    '根因栏、影响面、遗留问题印的都是 verdict——空着的话那几节是视觉上的一片白，而纸上看不出是"没查出来"还是"忘了写"',
  );
  check(
    '指标超过上限时在工具边界退回，不截断',
    (() => {
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ label: `m${i}`, value: '1', bound: 'exact' as const, basis: 'x' }));
      const arg = (n: number) => ({
        stepId: 'st_x',
        status: 'confirmed' as const,
        verdict: 'v',
        confidence: 0.9,
        evidence: [],
        metrics: many(n),
      });
      return CLOSE.safeParse(arg(METRICS_MAX)).success && !CLOSE.safeParse(arg(METRICS_MAX + 1)).success;
    })(),
    `上限=${METRICS_MAX}（与名单相反：这张表是 agent 亲手写的、条数完全由它定，超了说明把明细当成了指标——没有"保住一部分"的意义。不拦的话 5 万条指标走的是正常路径，不需要修库）`,
  );
  check(
    '指标的 label / value / basis 同样挡得住',
    (['label', 'value', 'basis'] as const).every(
      (k) =>
        !CLOSE.safeParse({
          stepId: 'st_x',
          status: 'confirmed' as const,
          verdict: 'v',
          confidence: 0.9,
          evidence: [],
          metrics: [{ label: '受害者数', value: '2', bound: 'lower' as const, basis: '近 30 天', [k]: '  ' }],
        }).success,
    ),
    '一个没有口径的数与一句「近 30 天内至少 N」是两个不同的事实，而读者只会拿前者去汇报',
  );

  // ── 读的这一头：语法合法但形状不对的那一列 ────────────────────────────
  //
  // 手工修库、半截写入、**或者将来改了字段之后重放老事件**都会造出这种值。
  // 它解析得出来、`items` 也非空，于是一路放行到 `reportPlan` 对 undefined 调 `.trim()`
  const cBad = makeRunner('case_badshape', '形状不对的产出物');
  const sBad = (cBad as unknown as Probe).beginSession();
  const badStep = await sBad.store.openStep({ direction: '随便查一下' });
  sBad.recordToolStart({ callId: 'call_bad', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  sBad.recordToolEnd({ callId: 'call_bad', output: '命中 1 条\nx\n(end)' });
  await sBad.store.closeStep({
    stepId: badStep.stepId,
    status: 'confirmed',
    verdict: '成立',
    confidence: 0.9,
    roster: { label: '关联账号', idKind: 'userId', complete: false, basis: '按设备指纹', items: [{ id: 'u_a' }] },
    evidence: [{ callRef: '#1', anchor: '1', claim: 'x', actor: 'app' }],
  });
  const badImpact = await sBad.store.openStep({ direction: '量化影响面', kind: 'impact' });
  await sBad.store.closeStep({
    stepId: badImpact.stepId,
    status: 'confirmed',
    verdict: '波及 37 个租户',
    confidence: 0.8,
    metrics: [{ label: '受影响租户', value: '37', bound: 'exact', basis: '全量扫过' }],
    evidence: [],
  });
  // 缺 label 的名单 / 元素形状不对的指标：两者都是**合法 JSON**
  db.prepare(`UPDATE steps SET roster='{"items":[{"id":"u1"}]}' WHERE id=?`).run(badStep.stepId);
  db.prepare(`UPDATE steps SET metrics='[{}]' WHERE id=?`).run(badImpact.stepId);
  const badSnap = (() => {
    try {
      return { snap: cBad.snapshot(), threw: null as string | null };
    } catch (e) {
      return { snap: null, threw: (e as Error).message };
    }
  })();
  check(
    '形状不对的那一列按没有处理，快照照常出得来',
    badSnap.snap?.report.roster === null && badSnap.snap?.report.metrics.length === 0,
    `抛=${badSnap.threw} · roster=${JSON.stringify(badSnap.snap?.report.roster)} · metrics=${JSON.stringify(badSnap.snap?.report.metrics)}（语法合法不等于形状合法：只 catch SyntaxError 的话这一行一路放行到报告层）`,
  );
  check(
    '报告与 Markdown 在这种库上都出得来，不是白屏',
    (() => {
      try {
        const input = reportInput(cBad.snapshot());
        return !!input && reportMarkdown(input, { generatedAt: 0 }).includes('# ');
      } catch {
        return false;
      }
    })(),
    '报告屏、Markdown 与长图共用 reportPlan，那儿一抛就是三个出口一起死——而库里那一行看着好好的',
  );
  cBad.close();

  // 读侧的上限：**写入侧不是唯一入口**——`seed-cases` 与任何直接发 `step.closed` 的
  // 路径都不经过 `normalizeRoster`，只在那儿拦的话，库里一份无界的名单照旧一路进快照、
  // 进报告、把长图导出撑断（`paginate` 让超预算的单块自成一页）
  const cHuge = makeRunner('case_huge', '库里塞了一份无界名单');
  const sHuge = (cHuge as unknown as Probe).beginSession();
  const hugeStep = await sHuge.store.openStep({ direction: '随便查一下' });
  sHuge.recordToolStart({ callId: 'call_huge', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  sHuge.recordToolEnd({ callId: 'call_huge', output: '命中 1 条\nx\n(end)' });
  await sHuge.store.closeStep({
    stepId: hugeStep.stepId,
    status: 'confirmed',
    verdict: '成立',
    confidence: 0.9,
    roster: { label: '受影响订单', idKind: 'orderId', complete: false, basis: '按 cart_key', items: [{ id: 'o_0' }] },
    evidence: [{ callRef: '#1', anchor: '1', claim: 'x', actor: 'app' }],
  });
  // 绕开写入侧的归一，直接把一份 5000 条的名单塞进库（形状完全合法）
  db.prepare(`UPDATE steps SET roster=? WHERE id=?`).run(
    JSON.stringify({
      label: '受影响订单',
      idKind: 'orderId',
      complete: true,
      basis: '按 cart_key',
      items: Array.from({ length: 5000 }, (_, i) => ({ id: `o_${i}` })),
    }),
    hugeStep.stepId,
  );
  const huge = cHuge.snapshot().report.roster?.roster;
  check(
    '读侧按同一条规则截到上限，并强制成下界',
    huge?.items.length === ROSTER_MAX && huge.truncated === 5000 - ROSTER_MAX && huge.complete === false,
    `条数=${huge?.items.length} · truncated=${huge?.truncated} · complete=${huge?.complete}（只在写入侧拦的话，seed 与重放这两条路上的名单是无界的——快照、报告与长图全跟着走）`,
  );
  // 已经被截过一次、又超上限的那一份：`truncated` 要**累加**。
  // 这个状态只有手工修库造得出来（写入侧截完就只剩 ROSTER_MAX 条了），而读侧这一整套
  // 校验存在的理由正是那类数据——不造一个的话，累加那半个分支没有任何检查走得到
  db.prepare(`UPDATE steps SET roster=? WHERE id=?`).run(
    JSON.stringify({
      label: '受影响订单',
      idKind: 'orderId',
      complete: false,
      basis: '按 cart_key',
      truncated: 100,
      items: Array.from({ length: 700 }, (_, i) => ({ id: `o_${i}` })),
    }),
    hugeStep.stepId,
  );
  const twice = cHuge.snapshot().report.roster?.roster;
  check(
    '截第二次时把先前截掉的条数累加上，不是从头算',
    twice?.truncated === 100 + (700 - ROSTER_MAX),
    `truncated=${twice?.truncated}（期望 ${100 + (700 - ROSTER_MAX)}）——覆盖掉的话，纸上那句「已截掉 N 条」会比真实少报一截，而它正是读者判断该不该回头重来的依据`,
  );

  // 截过的名单不可能是全集——**这条不变量要在每条路径上都成立**，不只是"这次真截了"那条
  db.prepare(`UPDATE steps SET roster=? WHERE id=?`).run(
    JSON.stringify({
      label: '受影响订单',
      idKind: 'orderId',
      complete: true,
      basis: '按 cart_key',
      truncated: 10,
      items: Array.from({ length: 300 }, (_, i) => ({ id: `o_${i}` })),
    }),
    hugeStep.stepId,
  );
  const claimsAll = cHuge.snapshot().report.roster?.roster;
  check(
    '库里一份没超上限、却自称全集又带着 truncated 的名单，读出来是下界',
    claimsAll?.complete === false && claimsAll.truncated === 10 && claimsAll.items.length === 300,
    `complete=${claimsAll?.complete} · truncated=${claimsAll?.truncated} · 条数=${claimsAll?.items.length}（原样放行的话，纸上同时印着「全集」与「已截掉 10 条」——给动手处置的人两个互相矛盾的完整性口径，而两句都出自这一份数据）`,
  );
  check(
    'truncated 为 0 时不留这个键，纸上不会多出一句「已截掉 0 条」',
    (() => {
      db.prepare(`UPDATE steps SET roster=? WHERE id=?`).run(
        JSON.stringify({
          label: '受影响订单',
          idKind: 'orderId',
          complete: true,
          basis: '按 cart_key',
          truncated: 0,
          items: [{ id: 'o_1' }],
        }),
        hugeStep.stepId,
      );
      const r = cHuge.snapshot().report.roster?.roster;
      return !!r && r.truncated === undefined && r.complete === true;
    })(),
    '0 是"没截过"，不该顺带把 complete 也翻成 false——那样一份真的全集会被说成下界',
  );
  check(
    '负数或小数的 truncated 是结构上不可能的值，整列按坏的降级',
    (() => {
      const bad = (t: number) => {
        db.prepare(`UPDATE steps SET roster=? WHERE id=?`).run(
          JSON.stringify({ label: 'x', idKind: 'y', complete: false, basis: 'z', truncated: t, items: [{ id: 'o_1' }] }),
          hugeStep.stepId,
        );
        return cHuge.snapshot().report.roster;
      };
      return bad(-1) === null && bad(1.5) === null;
    })(),
    '这两种值没有任何写入路径造得出来，出现就说明这一行不可信——而"截掉了 -1 条"印在纸上比少一节糟得多',
  );

  // 读侧的指标上限：同样绕开工具边界直接塞库
  const hugeImpact = await sHuge.store.openStep({ direction: '量化影响面', kind: 'impact' });
  await sHuge.store.closeStep({
    stepId: hugeImpact.stepId,
    status: 'confirmed',
    verdict: '波及很多',
    confidence: 0.8,
    metrics: [{ label: '受影响租户', value: '37', bound: 'exact', basis: '全量扫过' }],
    evidence: [],
  });
  db.prepare(`UPDATE steps SET metrics=? WHERE id=?`).run(
    JSON.stringify(
      Array.from({ length: METRICS_MAX + 1 }, (_, i) => ({
        label: `m${i}`,
        value: '1',
        bound: 'exact',
        basis: 'x',
      })),
    ),
    hugeImpact.stepId,
  );
  check(
    '库里那份超上限的指标整列不要，不是照单全收',
    cHuge.snapshot().report.metrics.length === 0,
    `条数=${cHuge.snapshot().report.metrics.length}（读侧不拦的话，工具边界那道 .max() 只挡得住 agent，挡不住 seed 与重放——而报告那一节照样是不可拆分的一整块）`,
  );
  cHuge.close();

  db.prepare(`UPDATE steps SET roster='{' WHERE id=?`).run(redoRoster.stepId);
  // 🔴 **必须自己接住异常。** 让它往上抛的话整个脚本当场死掉，打出的是 0 PASS / 0 FAIL——
  // 与"ABI 没切、脚本在 import 阶段就崩了"是同一个签名，而那两件事的下一步动作完全不同
  const afterBad = await sDeliv.store
    .closeStep({
      stepId: redoRoster.stepId,
      status: 'confirmed',
      verdict: '第三台设备带出第 4 个账号（补一句）',
      confidence: 0.85,
      evidence: [],
    })
    .catch((e: Error) => ({ warnings: null, threw: e.message }));
  check(
    '库里那一列坏掉时 close_step 照常走完，不抛异常',
    Array.isArray(afterBad.warnings),
    `结果=${JSON.stringify(afterBad)}（写入侧压根不读这一列——一度为一个从没被读过的 final.roster 解析它一次，于是 agent 在同一步上补一次证据就撞 SyntaxError，拿不到 warning、也补不进结论）`,
  );

  // 重放：这两列都是投影，`events` 才是真相。
  // **逐字比对重放前后，不写死期望值**：写死的话，这一段前面每加一步都要回来改它一次，
  // 而改的人多半会顺手把期望值抄成新的现状——那时它就不再验"重放一致"，只是在复述结果
  const before = JSON.stringify(cDeliv.snapshot().report);
  rebuildProjections(db, { blobDir: blobs });
  const rebuilt = cDeliv.snapshot().report;
  check(
    '重放后名单与指标一字不差地重建出来',
    JSON.stringify(rebuilt) === before && !!rebuilt.roster && rebuilt.metrics.length > 0,
    `名单 ${rebuilt.roster?.roster.items.length} 条（截掉 ${rebuilt.roster?.roster.truncated ?? 0}）· 指标 ${rebuilt.metrics.length} 条 · 与重放前一致=${JSON.stringify(rebuilt) === before}（对不上就说明有算法跑在投影侧，而它哪天一改，老调查的报告就跟着变）`,
  );
  cDeliv.close();

  // 没有已证实的根因就是未决型。这不是猜：没查出来就是没查出来，报告本就不该有根因栏
  const cOpen = makeRunner('case_shape_open', '什么都没查出来');
  const sOpen = (cOpen as unknown as Probe).beginSession();
  const nothing = await sOpen.store.openStep({ direction: '怀疑是下游超时' });
  await sOpen.store.closeStep({
    stepId: nothing.stepId,
    status: 'inconclusive',
    verdict: '日志不全，查不下去',
    confidence: 0.2,
    evidence: [],
  });
  check(
    '一条已证实的结论都没有 → 未决型，不硬凑一个有根因栏的形态',
    suggestVerdictShape(db, 'case_shape_open').shape === 'open',
    `建议=${JSON.stringify(suggestVerdictShape(db, 'case_shape_open'))}`,
  );
  const gaps = missingClosingSteps(db, 'case_shape_open');
  for (const kind of gaps) {
    const st = await sOpen.store.openStep({ direction: `补 ${kind}`, kind });
    await sOpen.store.closeStep({
      stepId: st.stepId,
      status: 'inconclusive',
      verdict: `${kind} 收口`,
      confidence: 0.2,
      evidence: [],
    });
  }
  await cOpen.closeCase();
  check(
    '一条根因都没有时定稿落的是 open，绝不落一个 NULL 进去',
    shapeOf('case_shape_open') === 'open',
    `verdict_shape=${shapeOf('case_shape_open')}（落 NULL 的话报告没有装法，而那是定稿之后才发现的）`,
  );

  // 🔴 **确认块挂在屏幕上的这段时间里 agent 改了声明**：形态是它的判断，冻的必须是
  // 它最后说的那个。一度由界面把弹出那一刻屏上显示的形态传进来，于是冻进库的
  // 是一个已经被 agent 自己推翻的形态，而两个屏各自看都自洽
  const cLate = makeRunner('case_shape_late', 'agent 中途改了声明');
  const sLate = (cLate as unknown as Probe).beginSession();
  const lateRoot = await sLate.store.openStep({ direction: '扩容那一下把池配置带歪了' });
  sLate.recordToolStart({ callId: 'call_late', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  sLate.recordToolEnd({ callId: 'call_late', output: '命中 1 条\n10:02:11 502 gateway\n(end)' });
  await sLate.store.closeStep({
    stepId: lateRoot.stepId,
    status: 'confirmed',
    verdict: '扩容复用了旧配置',
    confidence: 0.9,
    shape: 'chain',
    evidence: [{ callRef: '#1', anchor: '2', claim: '10:02:11 观察到 502', occurredAt: '10:02:11', actor: 'gateway' }],
  });
  for (const kind of missingClosingSteps(db, 'case_shape_late')) {
    const st = await sLate.store.openStep({ direction: `补 ${kind}`, kind });
    await sLate.store.closeStep({
      stepId: st.stepId,
      status: 'inconclusive',
      verdict: `${kind} 收口`,
      confidence: 0.2,
      evidence: [],
    });
  }
  const seenOnScreen = suggestVerdictShape(db, 'case_shape_late').shape;
  // 人正在读确认块，agent 这时改了主意：同一步再 close 一次，只换形态（patch 语义）
  await sLate.store.closeStep({
    stepId: lateRoot.stepId,
    status: 'confirmed',
    verdict: '扩容复用了旧配置',
    confidence: 0.9,
    shape: 'state',
    expected: '扩容后每个实例各自建池',
    actual: '扩容后仍共用扩容前那一个',
    evidence: [],
  });
  await cLate.closeCase();
  check(
    '确认块挂着时 agent 改了声明：冻的是它最后说的那个，不是屏上那个',
    seenOnScreen === 'chain' && shapeOf('case_shape_late') === 'state',
    `屏上那一刻=${seenOnScreen} · 冻进库的=${shapeOf('case_shape_late')}`,
  );
  cLate.close();

  // ── ⑧ 启动清扫上一进程的僵尸行 ─────────────────────────────────────────
  //
  // 造一个真僵尸：记了账就没有下文，且**没人来收尾**——进程被杀就是这个样子
  // （上面那些走过停止/归档的都已经收干净了，正因如此这里必须另造一个）
  const zc = makeRunner('case_zombie', '进程被杀');
  const zs = (zc as unknown as Probe).beginSession();
  zs.recordToolStart({ callId: 'call_z1', toolName: ASK, input: { statement: 'SELECT z' } });
  // 会话那侧同理：没人来 endSession，库里就留下一排永远 live 的 session
  const zombieSessions = (db.prepare(`SELECT COUNT(*) c FROM sessions WHERE status='live'`).get() as { c: number }).c;
  const swept = sweepZombies(db, { blobDir: blobs, now: () => Date.now() });
  check(
    '启动清扫把遗留的 pending 调用一律改判 abandoned',
    callStatus('call_z1') === 'abandoned' && swept.calls >= 1,
    `call_z1=${callStatus('call_z1')} · 扫掉 ${swept.calls} 次调用`,
  );
  check(
    '遗留的 live 会话一并收成 crashed —— 它确实是被中途掐断的',
    (db.prepare(`SELECT COUNT(*) c FROM sessions WHERE status='live'`).get() as { c: number }).c === 0 &&
      swept.sessions === zombieSessions,
    `live ${zombieSessions} → 0`,
  );
  check(
    '扫过一遍之后没有可扫的了：重启不会反复改判同一批',
    sweepZombies(db, { blobDir: blobs, now: () => Date.now() }).calls === 0,
    '第二次清扫 0 条',
  );

  // ── ⑨ 全部状态变更都经得起重放 ────────────────────────────────────────
  //
  // 这条是本 spike 的地基：直接 `UPDATE cases` / `UPDATE tool_calls` 的值
  // 在这里会被静默抹掉，而症状要到换 schema 重建投影那天才出现
  const evidenceBeforeReplay = (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c;
  const replayed = rebuildProjections(db, { blobDir: blobs });
  check(
    '重放之后收尾状态逐字还原（直接 UPDATE 的话这里会被抹回 open）',
    readCaseStatus(db, 'case_close') === 'closed' &&
      readCaseStatus(db, 'case_abort') === 'aborted' &&
      readCaseStatus(db, 'case_stop') === 'open',
    `close=${readCaseStatus(db, 'case_close')} · abort=${readCaseStatus(db, 'case_abort')} · stop=${readCaseStatus(db, 'case_stop')}（重放 ${replayed} 条事件）`,
  );
  check(
    '重放之后形态也逐字还原：它和状态一样只能走事件，直接 UPDATE 会被 case.opened 抹回 NULL',
    shapeOf('case_shape') === 'sequence' && shapeOf('case_abort') === 'open' && shapeOf('case_close') === 'chain',
    `shape=${shapeOf('case_shape')} · abort=${shapeOf('case_abort')} · close=${shapeOf('case_close')}`,
  );
  check(
    '重放之后 close_step 带的形态与应然实然也还在（步一级的三个新字段）',
    (db.prepare(`SELECT shape FROM steps WHERE id=?`).get(rootShape.stepId) as { shape: string | null }).shape ===
      'sequence' && cDead.snapshot().report.expected === '连接池上限 200',
    `steps.shape=${(db.prepare(`SELECT shape FROM steps WHERE id=?`).get(rootShape.stepId) as { shape: string | null }).shape} · 应然=${cDead.snapshot().report.expected}`,
  );
  // 重放走的是同一个投影函数，所以"缺省=不动"的语义在这里也必须成立：
  // 两条 step.closed 依序重放，第二条同样不该把第一条填好的三项抹掉
  check(
    '重放之后重新 close 过的那一步也没被抹平（缺省=不动，写路径与重放共用同一条语义）',
    reClosed().shape === 'state' && reClosed().actual === '实际是 5',
    JSON.stringify(reClosed()),
  );
  check(
    '重放之后放弃的调用也还是放弃：清扫与散场都走了事件',
    callStatus('call_z1') === 'abandoned' && callStatus('call_b') === 'abandoned' && callStatus('call_g') === 'abandoned',
    `call_z1=${callStatus('call_z1')} · call_b=${callStatus('call_b')} · call_g=${callStatus('call_g')}`,
  );
  // 比的是重放前后而不是一个写死的条数：后者每加一次调查就要跟着改，
  // 而它真正要验的是「收尾没有销毁事实，重放也没有」
  check(
    '重放之后证据仍在：收尾从来不销毁事实',
    (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c === evidenceBeforeReplay &&
      evidenceBeforeReplay > evidenceBefore,
    `证据 ${evidenceBefore}（定稿时）→ ${evidenceBeforeReplay}（重放前）→ ${(db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c}`,
  );

    // ── ⑥ 断流 / 崩溃：收尾的漏斗只有一个 ─────────────────────────────────────
  //
  // `close()` 盖得住的只有"人主动收"那一条路。断流与崩溃走 `consume()` 的 try/catch，
  // 之后 finally 立刻把 `q` 置空、`lanes.reset()`，再没有人收得了——**这两条路上漏掉的账
  // 会一直挂到下次启动的 `sweepZombies()`**：轨道上一次永远「进行中」的调用，
  // 报告里"跑过多少次"多几笔。所以这儿喂一个真会断的流，从外面验四样东西一起收干净。
  for (const [kind, caseId, makeStream] of [
    ['崩溃', 'case_crash', () => (async function* () {
      throw new Error('消息流断了');
    })()],
    ['断流', 'case_eos', () => (async function* () {})()],
  ] as const) {
    const cr = makeRunner(caseId, `${kind}时还挂着东西`);
    const pr = cr as unknown as Probe;
    pr.beginSession();
    pr.status = 'live';
    pr.busy = true;
    // 一次已经自动放行、正跑着的普通调用：库里只有 started，PostToolUse 再也不会来
    pr.onToolStart({ tool_name: 'Bash', tool_input: { command: 'sleep 600' } }, `${caseId}_run`);
    // 一张挂起的回填卡：它与那次调用是一对，**必须一起收**——只收调用的话，
    // 卡片还钉在视口上等人答，而它对应的那次调用已经作废
    pr.onToolStart({ tool_name: ASK, tool_input: { statement: 'SELECT 1' } }, `${caseId}_ask`);
    void pr.askOperator({ engine: 'mysql', statement: 'SELECT 1', why: '看一眼', expect: '一条' });
    // 一道挂起的闸门
    pr.onToolStart({ tool_name: 'mcp__logs__query', tool_input: { q: 'x' } }, `${caseId}_gate`);
    void pr.gate('mcp__logs__query', { q: 'x' }, {
      toolUseID: `${caseId}_gate`,
      signal: new AbortController().signal,
    });

    const before = {
      run: callStatus(`${caseId}_run`),
      ask: callStatus(`${caseId}_ask`),
      gate: callStatus(`${caseId}_gate`),
      cards: cr.snapshot().pending.length + cr.snapshot().gates.length,
    };
    const stream = makeStream();
    pr.q = stream;
    await pr.consume(stream);

    const after = {
      run: callStatus(`${caseId}_run`),
      ask: callStatus(`${caseId}_ask`),
      gate: callStatus(`${caseId}_gate`),
      cards: cr.snapshot().pending.length + cr.snapshot().gates.length,
    };
    check(
      `${kind}时那次还在跑的调用当场记成放弃，不等下次启动清扫`,
      before.run === 'pending' && after.run === 'abandoned',
      `${before.run} → ${after.run} —— 只挂在 close() 上的话它到这儿仍是 pending`,
    );
    check(
      `${kind}时回填与闸门跟着一起散，卡片不留在视口上`,
      after.ask === 'abandoned' && after.gate === 'abandoned' && before.cards === 2 && after.cards === 0,
      `回填=${after.ask} · 闸门=${after.gate} · 卡片 ${before.cards} → ${after.cards}` +
        ' —— 只收调用不收卡片的话，人还在答一个没有任何人在听的问题',
    );
    check(
      `${kind}之后库里没有留下任何 pending 的调用`,
      (db.prepare(`SELECT COUNT(*) c FROM tool_calls tc JOIN sessions se ON se.id=tc.session_id
                   WHERE se.case_id=? AND tc.status='pending'`).get(caseId) as { c: number }).c === 0,
      '这一条按库扫，不认具体是哪几次调用 —— 能挂住的不止上面列的那三种',
    );
  }

console.log('\n===== Spike Close 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }
  console.log(`\n临时库：${file}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

void main();
