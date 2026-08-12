/**
 * Spike Close —— 验三种收尾这一带（D29 / ui.md §8.4）。
 *
 * 不起真会话：要验的都是 harness 侧的记账、状态与投影，与模型无关，而这几处的错法都是**静默**的——
 *
 *   1. **状态变更必须走领域事件。** 直接 `UPDATE cases` 的值一重放就被 `case.opened`
 *      抹回 `open`，而重放正是换 schema 时重建投影的唯一手段——结过的案子悄悄又开着了
 *   2. **终止要把挂起的回填也收掉。** 闸门那侧一直有，回填这侧原先没有：
 *      那次 `ask_operator` 调用会永远挂在 `pending` 上，轨道上是一次"发起了但没有结果"的调用
 *   3. **散场的收尾不能被迟到的 PostToolUse 盖掉。** 散场靠的就是给工具那侧一个结果，
 *      它随后照样走完 PostToolUse——不挡这一下，`abandoned` 会被改写成 `done`
 *   4. **结案前置只认已收尾的强制 step。** 拿一个还开着的 impact step 放行，
 *      等于让报告的影响面栏空着结案
 *   5. **启动清扫必须赶在任何 runner 之前。** 那一刻库里的 pending 与 live 必然是上次残留的；
 *      建完 runner 再扫会把这一轮自己的活计一起判成放弃（这条是调用点顺序，见 main/index.ts）
 *
 * 跑：npm run rebuild:node && npm run spike:close
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { blobDir, openDatabase, type Db } from '../src/backend/db/database.js';
import { rebuildProjections } from '../src/backend/db/projector.js';
import {
  missingClosingSteps,
  readCaseStatus,
  readIntake,
  suggestVerdictShape,
  sweepZombies,
  type InvestigationSession,
} from '../src/backend/store/sqlite-store.js';
import { CaseRunner } from '../src/main/case-runner.js';
import type { Snapshot, VerdictShape } from '../src/shared/ipc.js';

const ASK = 'mcp__inquestry__ask_operator';

/** 收尾要验的正是 runner 的私有面（hook 入口、回填、会话准备），只好从旁边够进去。 */
type Probe = {
  beginSession(): InvestigationSession;
  onToolStart(input: unknown, toolUseID: string | undefined): unknown;
  onToolEnd(input: unknown, toolUseID: string | undefined): unknown;
  onToolFailed(input: unknown, toolUseID: string | undefined): unknown;
  onPermissionDenied(input: unknown, toolUseID: string | undefined): unknown;
  askOperator(args: { engine: string; statement: string; why: string; expect: string }): Promise<unknown>;
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
  askCalls: { callId: string; statement: string }[];
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

/** 跑一步带证据的排查，用来喂结案前置与"证据不该被销毁"两条。 */
async function work(
  session: InvestigationSession,
  opts: {
    direction: string;
    kind?: 'normal' | 'impact' | 'leftover';
    callId: string;
    occurredAt: string;
    /** 形态与应然实然只有下根因那一步才给（D25）。 */
    shape?: VerdictShape;
    expected?: string;
    actual?: string;
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

  // ── ① 结案前置：两个强制 step 走完之前结不了案 ─────────────────────────
  const c1 = makeRunner('case_close', '订单 502');
  const p1 = c1 as unknown as Probe;
  const s1 = p1.beginSession();
  await work(s1, { direction: '网关重试放大了下游压力', callId: 'call_c1', occurredAt: '12:41:07' });

  const gapsAtStart = c1.closingGaps;
  const refused = await c1.closeCase();
  check(
    '缺影响面与遗留疑点时结不了案（§6.2）',
    !refused.ok && refused.missing.join(',') === 'impact,leftover' && readCaseStatus(db, 'case_close') === 'open',
    `missing=${refused.ok ? '(竟然结了)' : refused.missing.join(',')} · status=${readCaseStatus(db, 'case_close')}`,
  );
  check(
    '缺的那几步在快照里就看得见，不用点了结案才知道',
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
  // 只看"有没有这一 kind"的话，一个刚开还没结论的影响面 step 就能放行结案，
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
    evidence: [{ callRef: '#1', claim: '同期总量与失败量', occurredAt: '12:47:00' }],
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
    '执行入口缺步时只回绝，不冻案子也不派活',
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
  // 结案校验与报告章节必须共用同一条"哪一步算数"的规则
  const cRedo = makeRunner('case_redo', '影响面重做到一半');
  const sRedo = (cRedo as unknown as Probe).beginSession();
  await work(sRedo, { direction: '先查一步', callId: 'call_r1', occurredAt: '10:00:00' });
  const firstImpact = await sRedo.store.openStep({ direction: '先估一版影响面', kind: 'impact' });
  await sRedo.store.closeStep({
    stepId: firstImpact.stepId,
    status: 'confirmed',
    verdict: '约 300 次请求受影响',
    confidence: 0.6,
    evidence: [{ callRef: '#1', claim: '第一版口径', occurredAt: '10:05:00' }],
  });
  const lo2 = await sRedo.store.openStep({ direction: '遗留', kind: 'leftover' });
  await sRedo.store.closeStep({ stepId: lo2.stepId, status: 'inconclusive', verdict: '无', confidence: 0.2, evidence: [] });
  check(
    '重做之前：两步都齐，可以结案',
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
  // 单独一个案子：case_close 里已经有一个收好的 impact step 了，在那儿验会被它顶掉
  const cs = makeRunner('case_super', '影响面被推翻');
  const ss = (cs as unknown as Probe).beginSession();
  await work(ss, { direction: '重试放大', callId: 'call_s1', occurredAt: '12:41:07' });
  const wrongImpact = await ss.store.openStep({ direction: '先按网关日志估个影响面', kind: 'impact' });
  await ss.store.closeStep({
    stepId: wrongImpact.stepId,
    status: 'confirmed',
    verdict: '大约 300 次请求受影响',
    confidence: 0.5,
    evidence: [{ callRef: '#1', claim: '网关侧计数', occurredAt: '12:45:00' }],
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
    evidence: [{ callRef: '#1', claim: '下游账本口径', occurredAt: '12:46:00' }],
  });
  check(
    '强制 step 被别的 kind 推翻之后，缺口重新出现（不能拿作废的结论结案）',
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

  // ── ③ 补齐之后结案成立，且状态走的是事件 ────────────────────────────────
  check(
    '结案之前不写形态：排查中途的形态还会变，定死一个只会让报告按过期判断装',
    shapeOf('case_close') === null,
    `verdict_shape=${shapeOf('case_close')}`,
  );
  const closed = await c1.closeCase();
  const evidenceBefore = (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c;
  check(
    '两步走完就能结案，case 落到 closed',
    closed.ok && readCaseStatus(db, 'case_close') === 'closed',
    `status=${readCaseStatus(db, 'case_close')}`,
  );
  // 这个案子 agent 一次形态都没声明过，走的是推断那条：有已证实的根因，没有应然实然，
  // 事故时间线上只有一条证据（影响面那一步的 callRef 落空了，所以排不出"顺序"）→ chain。
  // 换成 open 会把一条真实结论从报告里抹掉，换成 sequence 是装一块空的
  check(
    '没人声明形态时结案也得落一个装得出来的：chain，不是 open 也不是 sequence',
    shapeOf('case_close') === 'chain',
    `verdict_shape=${shapeOf('case_close')}（带时间的证据 ${(db.prepare(`SELECT COUNT(*) c FROM evidence_refs e JOIN steps s ON s.id=e.step_id JOIN sessions se ON se.id=s.session_id WHERE se.case_id='case_close' AND e.occurred_at_ms IS NOT NULL`).get() as { c: number }).c} 条）`,
  );
  check(
    '结案顺手把会话收了，库里不留永远 live 的 session',
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
    '结案后 start() 不再新起会话，send() 也回 false',
    sent === false &&
      (db.prepare(`SELECT COUNT(*) c FROM sessions WHERE case_id='case_close'`).get() as { c: number }).c ===
        sessionsBefore,
    `sessions=${sessionsBefore} → ${(db.prepare(`SELECT COUNT(*) c FROM sessions WHERE case_id='case_close'`).get() as { c: number }).c} · send=${sent}`,
  );
  check(
    '重开 app 不会自动回到已结案的案子',
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
    '停止不改案子状态：随时能接着查',
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
  p2.onToolEnd({ tool_name: ASK, tool_response: '(案子已关闭，这条回填作废)' }, 'call_b');
  check(
    '散场之后迟到的成功收尾不算数，abandoned 保持原样',
    callStatus('call_b') === 'abandoned',
    `call_b=${callStatus('call_b')}（不挡这一下会变成 done，轨道上多出一次没人回答过的"跑完了"）`,
  );

  // ── ⑦ 归档（第三档）：标记放弃，但一条证据都不销毁 ────────────────────────
  const c3 = makeRunner('case_abort', '支付回调丢单');
  const p3 = c3 as unknown as Probe;
  const s3 = p3.beginSession();
  // agent 在这儿声明过形态：归档要能盖掉它（残报告一律未决型）
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
    '归档不销毁任何证据：证据、事故时间线、步骤一条不少',
    readCaseStatus(db, 'case_abort') === 'aborted' &&
      afterAbort.evidence === beforeAbort.evidence &&
      afterAbort.incident === beforeAbort.incident &&
      afterAbort.steps === beforeAbort.steps,
    `status=${readCaseStatus(db, 'case_abort')} · 证据 ${beforeAbort.evidence}→${afterAbort.evidence} · 事故线 ${beforeAbort.incident}→${afterAbort.incident}`,
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
    '归档一律落未决型，盖掉 agent 声明过的形态（残报告没有根因栏）',
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
  // 推断值把一条真实结论抹掉——三种在界面上都表现为"结案了，然后报告某一栏是空的"

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
    '有声明就用声明，并且说得出这是 agent 判定的（推断值只是兜底，不能混为一谈）',
    suggestVerdictShape(db, 'case_shape').shape === 'sequence' &&
      suggestVerdictShape(db, 'case_shape').source === 'agent',
    JSON.stringify(suggestVerdictShape(db, 'case_shape')),
  );
  // 形态与「状态型填不填得出来」必须同次算出，且说得出是按哪一步算的：
  // 界面按 rootStepId 判断手上冻的那份还说不说得上话，认错步就会拿新根因的形态
  // 配旧根因的判定——预选 state 却一句"这一块会是空的"都没有
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
  const lo = await sShape.store.openStep({ direction: '汇总未查清的疑点', kind: 'leftover' });
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
  // 人在确认条上改了形态：报告怎么装是人看着后果按下去的那个选择
  await cShape.closeCase('state');
  check(
    '人在确认条上选的形态优先于建议值',
    shapeOf('case_shape') === 'state',
    `verdict_shape=${shapeOf('case_shape')}（回落到建议值的话这里是 sequence，人那一下等于白点）`,
  );

  // 同一步 close 第二次是**我们自己的 warning 指使的**（"请补 evidence 后重新 close"），
  // 而那一次多半只带 evidence。把"没再填"解释成"清空"的话，第一次填好的形态与
  // 应然实然会被静默抹掉——报告主体随之空掉，重放还会一模一样地复现
  const reState = await sShape.store.openStep({ direction: '连接池上限一直就是错的' });
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
  // 而报告要到结案那天才发现那一块是空的
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
    '纯空白的应然实然按没填算：照样报"缺主体"，也不落进库里',
    wBlank.warnings.some((t) => t.includes('主体')) && blankRow.expected === null && blankRow.actual === null,
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
  // 界面版本对不上、或从别处调进来时会带一个不认识的值。落 NULL 的话报告没有装法，
  // 而那是结案之后才发现的——必须当场退回建议值
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
  await cOpen.closeCase('时序型' as VerdictShape);
  check(
    '认不出来的形态退回建议值，绝不落一个 NULL 进去',
    shapeOf('case_shape_open') === 'open',
    `verdict_shape=${shapeOf('case_shape_open')}`,
  );

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
    shapeOf('case_shape') === 'state' && shapeOf('case_abort') === 'open' && shapeOf('case_close') === 'chain',
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
  // 比的是重放前后而不是一个写死的条数：后者每加一个案子就要跟着改，
  // 而它真正要验的是「收尾没有销毁事实，重放也没有」
  check(
    '重放之后证据仍在：收尾从来不销毁事实',
    (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c === evidenceBeforeReplay &&
      evidenceBeforeReplay > evidenceBefore,
    `证据 ${evidenceBefore}（结案时）→ ${evidenceBeforeReplay}（重放前）→ ${(db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c}`,
  );

  console.log('\n===== Spike Close 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }
  console.log(`\n临时库：${file}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

void main();
