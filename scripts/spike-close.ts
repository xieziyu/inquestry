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
  sweepZombies,
  type InvestigationSession,
} from '../src/backend/store/sqlite-store.js';
import { CaseRunner } from '../src/main/case-runner.js';
import type { Snapshot } from '../src/shared/ipc.js';

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
  opts: { direction: string; kind?: 'normal' | 'impact' | 'leftover'; callId: string; occurredAt: string },
) {
  const { stepId } = await session.store.openStep({ direction: opts.direction, kind: opts.kind });
  session.recordToolStart({ callId: opts.callId, toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  session.recordToolEnd({ callId: opts.callId, output: `命中 1 条\n${opts.occurredAt} 502 gateway\n(end)` });
  await session.store.closeStep({
    stepId,
    status: 'confirmed',
    verdict: `${opts.direction} —— 成立`,
    confidence: 0.8,
    evidence: [
      { callRef: '#1', anchor: '2', claim: `${opts.occurredAt} 观察到 502`, occurredAt: opts.occurredAt, actor: 'gateway' },
    ],
  });
  return stepId;
}

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
  const closed = await c1.closeCase();
  const evidenceBefore = (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c;
  check(
    '两步走完就能结案，case 落到 closed',
    closed.ok && readCaseStatus(db, 'case_close') === 'closed',
    `status=${readCaseStatus(db, 'case_close')}`,
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
  await work(s3, { direction: '回调签名校验把重放挡了', callId: 'call_x1', occurredAt: '09:12:33' });
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
  const replayed = rebuildProjections(db, { blobDir: blobs });
  check(
    '重放之后收尾状态逐字还原（直接 UPDATE 的话这里会被抹回 open）',
    readCaseStatus(db, 'case_close') === 'closed' &&
      readCaseStatus(db, 'case_abort') === 'aborted' &&
      readCaseStatus(db, 'case_stop') === 'open',
    `close=${readCaseStatus(db, 'case_close')} · abort=${readCaseStatus(db, 'case_abort')} · stop=${readCaseStatus(db, 'case_stop')}（重放 ${replayed} 条事件）`,
  );
  check(
    '重放之后放弃的调用也还是放弃：清扫与散场都走了事件',
    callStatus('call_z1') === 'abandoned' && callStatus('call_b') === 'abandoned' && callStatus('call_g') === 'abandoned',
    `call_z1=${callStatus('call_z1')} · call_b=${callStatus('call_b')} · call_g=${callStatus('call_g')}`,
  );
  check(
    '重放之后证据仍在：收尾从来不销毁事实',
    (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c === evidenceBefore + 1,
    `证据 ${(db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c} 条`,
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
