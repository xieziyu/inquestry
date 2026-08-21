/**
 * Spike Branch —— 验子 agent 泳道**接进轨道**这一段（overview §4.5 / ui.md §3.2 / D23）。
 *
 * `spike:lane` 验的是「数据拿不拿得到」，要起真会话；这一条验的是「拿到之后记在哪」，
 * 全程离线。三处最容易错的地方，错了都不会报错：
 *
 *   1. **归属靠内层 `tool_use_id` 这座桥，不靠到达顺序。** 并发时支线的到达顺序会与
 *      发起顺序反过来（A.1 实测），按顺序配对或按"最近一次 Task 调用"算，答案会把
 *      甲的证据记到乙的泳道上——所以这里的夹具**特意让两种错法各自算出一个不同的答案**，
 *      并把"它们确实不同"本身写成一条检查：错法与正解重合的那一轮什么都没排除掉
 *   2. **每条泳道各有一个「当前 open 的 step」。** 共用一个的话，一条后台支线查到的东西
 *      会记进主线正开着的那一步，报告里于是有一步的证据来自它从没发起过的查询
 *   3. **支线不记账。** MCP 那侧拿不到 `agent_id`，支线开的步只会落在主干上；
 *      close_step 更糟，一条支线收得掉另一条根本不认识的步。所以 PreToolUse 当场回绝
 *
 * 跑：npm run rebuild:node && npm run spike:branch
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { blobDir, openDatabase } from '../src/backend/db/database.js';
import { applyEvent } from '../src/backend/db/projector.js';
import { reportSections } from '../src/backend/db/queries.js';
import { sweepZombies, type InvestigationSession } from '../src/backend/store/sqlite-store.js';
import { CaseRunner } from '../src/main/case-runner.js';
import { LaneBridge } from '../src/main/lane-bridge.js';
import { trackLayout } from '../src/renderer/track.js';

/** 泳道那几个方法是 CaseRunner 的私有面：要验的正是它们，只好从旁边够进去。 */
type Probe = {
  openSession(): InvestigationSession;
  /** 断流那条路要真的从 `consume()` 走一遍，光调 `endOnce` 验不到"崩溃会不会绕过收口"。 */
  consume(q: unknown): Promise<void>;
  q: unknown;
  onToolStart(input: unknown, toolUseID: string): { hookSpecificOutput?: { permissionDecision?: string } };
  convergeLane(finished: { lane: string; agentId: string; status: string; summary: string }): void;
  lanes: LaneBridge;
};

/** 一条支线跑完的通知。收口只认它——被人停掉的那条不发 `SubagentStop`（A.1）。 */
const notify = (agentId: string, status: string, summary: string, lane?: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: agentId,
  tool_use_id: lane,
  status,
  summary,
});

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

/** 一条转发上来的子 agent 消息：桥的左半边。 */
const forwarded = (lane: string, ...callIds: string[]) => ({
  type: 'assistant',
  parent_tool_use_id: lane,
  message: { content: callIds.map((id) => ({ type: 'tool_use', id })) },
});

async function main() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-branch-')), 'inquestry.db');
  const db = openDatabase(file);

  const runner = new CaseRunner({
    db,
    blobDir: blobDir(file),
    promptText: '',
    caseId: 'case_branch',
    intake: {
      title: '泳道自检',
      question: '泳道自检',
      projectRoot: null,
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    },
    agent: { backend: 'claude', model: null, effort: null },
    onChange: () => {},
  });
  const probe = runner as unknown as Probe;
  const session = probe.openSession();

  const start = (callId: string, agentId?: string, tool = 'mcp__datasource__query_logs') =>
    probe.onToolStart({ tool_name: tool, tool_input: { q: callId }, agent_id: agentId }, callId);
  const stepOf = (callId: string) =>
    (db.prepare(`SELECT step_id FROM tool_calls WHERE id=?`).get(callId) as { step_id: string } | undefined)
      ?.step_id;
  const stepRow = (stepId?: string) =>
    db.prepare(`SELECT status, verdict_text, t_end FROM steps WHERE id=?`).get(stepId) as
      | { status: string; verdict_text: string | null; t_end: number | null }
      | undefined;
  const narrativeRows = (stepId?: string) =>
    (db.prepare(`SELECT COUNT(*) c FROM narrative_fts WHERE ref_id=? AND ref_kind='lane'`).get(stepId) as {
      c: number;
    }).c;
  const laneOfStep = (stepId?: string) =>
    (db.prepare(`SELECT lane FROM steps WHERE id=?`).get(stepId) as { lane: string | null } | undefined)?.lane;
  const parentOfStep = (stepId?: string) =>
    (db.prepare(`SELECT parent_step_id FROM steps WHERE id=?`).get(stepId) as
      | { parent_step_id: string | null }
      | undefined)?.parent_step_id;

  // ── ① 桥：并发两条支线，到达顺序与发起顺序拧着来 ──────────────────────────
  //
  // 主线先发 alpha 再发 beta；转发回来的却是 beta 那条先到，内层调用也是 beta 先打。
  // 不这么拧，两种错法算出来的答案与正解一模一样，下面的检查就什么都没排除掉。
  start('main_first');
  start('task_alpha');
  start('task_beta');

  probe.lanes.absorb(forwarded('task_beta', 'inner_b1') as never);
  probe.lanes.absorb(forwarded('task_alpha', 'inner_a1') as never);

  start('inner_b1', 'ag_beta');
  start('inner_a1', 'ag_alpha');
  // 第二次调用没有转发消息垫着（`forwardSubagentText` 关着时正文不转发），只能靠 agent_id 认
  start('inner_a2', 'ag_alpha');
  // 支线跑着的时候主线照样在动：它得留在主干上
  start('main_second');

  const laneB = laneOfStep(stepOf('inner_b1'));
  const laneA = laneOfStep(stepOf('inner_a1'));

  check(
    '1. 桥闭合且不串台：agent_id ↔ lane 一一对上',
    laneB === 'task_beta' && laneA === 'task_alpha',
    `inner_b1 → ${laneB} / inner_a1 → ${laneA}`,
  );

  // 两种一望即知的错法都不用内层 tool_use_id。它们**必须**与正解不同，否则上面那条白验
  const byArrival = ['task_alpha', 'task_beta']; // 按到达顺序配对：第 1 个内层调用配第 1 次 Task
  const byRecent = ['task_beta', 'task_beta']; // 一律算给最近那次 Task 调用
  const real = [laneB, laneA];
  check(
    '1b. 这份夹具真的排除得掉两种错法（错法与正解必须算出不同答案）',
    JSON.stringify(real) !== JSON.stringify(byArrival) && JSON.stringify(real) !== JSON.stringify(byRecent),
    `正解 ${JSON.stringify(real)} / 按到达顺序 ${JSON.stringify(byArrival)} / 按最近一次 ${JSON.stringify(byRecent)}`,
  );

  check(
    '2. 没有转发消息垫着时靠 agent_id 认回同一条泳道',
    stepOf('inner_a2') === stepOf('inner_a1'),
    `inner_a2 落在 ${stepOf('inner_a2')}，inner_a1 在 ${stepOf('inner_a1')}`,
  );

  // ── ② 每条泳道各有一个 open step，主干不受影响 ──────────────────────────
  check(
    '3. 两条支线各占一步，都不与主干共用',
    new Set([stepOf('inner_a1'), stepOf('inner_b1'), stepOf('main_first')]).size === 3,
    `alpha ${stepOf('inner_a1')} / beta ${stepOf('inner_b1')} / 主干 ${stepOf('main_first')}`,
  );

  check(
    '4. 起支线那次调用本身留在主干上（hook 侧没有 agent_id）',
    laneOfStep(stepOf('task_alpha')) === null && stepOf('task_alpha') === stepOf('main_first'),
    `task_alpha 落在 ${stepOf('task_alpha')}（lane=${laneOfStep(stepOf('task_alpha'))}）`,
  );

  check(
    '5. 支线开着的时候主线的调用照旧回主干，不被吸进泳道',
    stepOf('main_second') === stepOf('main_first'),
    `main_second 落在 ${stepOf('main_second')}，主干是 ${stepOf('main_first')}`,
  );

  check(
    '6. 泳道的兜底步挂在起它那次调用所在的步下面',
    parentOfStep(stepOf('inner_a1')) === stepOf('task_alpha') &&
      parentOfStep(stepOf('inner_b1')) === stepOf('task_beta'),
    `alpha 的父 ${parentOfStep(stepOf('inner_a1'))} / beta 的父 ${parentOfStep(stepOf('inner_b1'))}`,
  );

  // 起支线那次调用没记上账（被规则拦下、或抢在 PreToolUse 之前短路）时不能连累这一步：
  // `parent_step_id` 上有开着的外键，编一个 id 出去就是整个事务回滚
  probe.lanes.absorb(forwarded('task_ghost', 'inner_g1') as never);
  start('inner_g1', 'ag_ghost');
  check(
    '7. 起支线那次调用查不到时，泳道落回主干层而不是炸外键',
    !!stepOf('inner_g1') && parentOfStep(stepOf('inner_g1')) === null && laneOfStep(stepOf('inner_g1')) === 'task_ghost',
    `inner_g1 落在 ${stepOf('inner_g1')}，父 ${parentOfStep(stepOf('inner_g1'))}`,
  );

  // 转发消息与 hook 谁先到不保证。桥还没合拢时**决不能回主干**：
  // 那次支线查询会记进主线正开着的那一步，而这条错账没有任何报错
  start('inner_r1', 'ag_race');
  const raceStep = stepOf('inner_r1');
  check(
    '7b. 桥还没合拢时支线也不掉回主干（宁可认不出父，也不串进主线那一步）',
    raceStep !== stepOf('main_first') && laneOfStep(raceStep) === 'agent:ag_race',
    `inner_r1 落在 ${raceStep}（lane=${laneOfStep(raceStep)}），主干是 ${stepOf('main_first')}`,
  );
  // 桥晚一步合拢也不改口：升级 key 换来的是同一条支线裂成两步，
  // 已经记上账的那几次留在旧 key 上——正是 D23 禁的那种回头改
  probe.lanes.absorb(forwarded('task_race', 'inner_r2') as never);
  start('inner_r2', 'ag_race');
  check(
    '7c. 一个 agent_id 认过的泳道不再改口，后到的调用仍归同一步',
    stepOf('inner_r2') === raceStep,
    `inner_r2 落在 ${stepOf('inner_r2')}，先前那步是 ${raceStep}`,
  );

  // ── ③ 轨道：一条泳道就是一列，trackLayout 按 lane 键分列 ──────────────────
  const rows = trackLayout(runner.snapshot().steps).rows;
  const colOf = (stepId?: string) => rows.find((r) => r.step.id === stepId)?.col;
  check(
    '8. 主干在 0 列、并发的两条支线各占一列，且行序仍是到达顺序',
    colOf(stepOf('main_first')) === 0 &&
      colOf(stepOf('inner_a1'))! > 0 &&
      colOf(stepOf('inner_b1'))! > 0 &&
      colOf(stepOf('inner_a1')) !== colOf(stepOf('inner_b1')) &&
      rows.map((r) => r.step.ordinal).join(',') === rows.map((_, i) => i + 1).join(','),
    `列号 ${rows.map((r) => r.col).join(',')} / 序号 ${rows.map((r) => r.step.ordinal).join(',')} —— ` +
      '两条并发支线合到同一列的话，"顺着一列往下读"读到的是两个 agent 交替的调用',
  );

  check(
    '9. 支线那几行标得出「支线」，主干不标',
    rows.filter((r) => r.step.lane).length === rows.length - 1 &&
      !rows.find((r) => r.step.id === stepOf('main_first'))!.step.lane,
    `带 lane 的行 ${rows.filter((r) => r.step.lane).map((r) => r.step.lane).join(',')}`,
  );

  // ── ④ 支线不记账 ────────────────────────────────────────────────────────
  const laneOpen = probe.onToolStart(
    { tool_name: 'mcp__inquestry__open_step', tool_input: { direction: 'x' }, agent_id: 'ag_alpha' },
    'call_open_lane',
  );
  const mainOpen = probe.onToolStart(
    { tool_name: 'mcp__inquestry__open_step', tool_input: { direction: 'x' } },
    'call_open_main',
  );
  check(
    '10. 支线的 open_step / close_step 当场被拒，主线的照旧放行',
    laneOpen?.hookSpecificOutput?.permissionDecision === 'deny' &&
      mainOpen?.hookSpecificOutput === undefined,
    `支线 ${JSON.stringify(laneOpen)} / 主线 ${JSON.stringify(mainOpen)}`,
  );
  check(
    '11. 被拒的结构调用不留账（结构工具本来就不记账，别顺手记一笔）',
    stepOf('call_open_lane') === undefined,
    `call_open_lane 的 step_id = ${stepOf('call_open_lane')}`,
  );

  // ── ⑤ 收口：跑完的支线不能永远停在「进行中」（ui.md §3.2） ────────────────────
  //
  // 收口只认 `task_notification`（被人停掉的那条不发 `SubagentStop`），内容一律是**支线自己的话**：
  // harness 替它编一句结论的话，报告里会多出一条没有人下过的结论。

  probe.lanes.noteSubagentStop('ag_alpha', '  三次日志都指向同一个实例，alpha 这条查完了  ');
  const finA = probe.lanes.absorb(notify('ag_alpha', 'completed', '（通知自带的摘要）', 'task_alpha') as never);
  if (finA) probe.convergeLane(finA);
  const aRow = stepRow(stepOf('inner_a1'));
  check(
    '16. 支线跑完，它那一步收成 converged（不是 open，也不是任何一种结论）',
    aRow?.status === 'converged' && !!aRow?.t_end,
    `alpha 那一步 status=${aRow?.status} t_end=${aRow?.t_end}`,
  );
  check(
    '16b. 收口写的是支线自己的话，且 SubagentStop 的最后一句压过通知里的摘要',
    !!aRow?.verdict_text?.includes('同一个实例') && !aRow?.verdict_text?.includes('通知自带'),
    `verdict = ${JSON.stringify(aRow?.verdict_text)}`,
  );
  check(
    '17. 收一条支线不动主干那一步（主线还在查，它凭什么被收）',
    stepRow(stepOf('main_first'))?.status === 'open',
    `主干那一步 status=${stepRow(stepOf('main_first'))?.status}`,
  );

  // 没有 SubagentStop 的那条（被停下的就是这样）只能用通知里的摘要
  const finB = probe.lanes.absorb(notify('ag_beta', 'stopped', 'beta 被停下之前只跑了一次查询', 'task_beta') as never);
  if (finB) probe.convergeLane(finB);
  check(
    '18. 没有 SubagentStop 时退回通知里的摘要，且说得出它是被停下的',
    stepRow(stepOf('inner_b1'))?.status === 'converged' &&
      !!stepRow(stepOf('inner_b1'))?.verdict_text?.includes('被停下') &&
      !!stepRow(stepOf('inner_b1'))?.verdict_text?.includes('只跑了一次查询'),
    `verdict = ${JSON.stringify(stepRow(stepOf('inner_b1'))?.verdict_text)}`,
  );

  // 同一条泳道可能再来一条通知（转后台那一手就会）。**收口时刻不能被它往后挪**：
  // 轨道上一条早就结束的支线于是显示成刚刚才停，而没有任何报错
  const beforeAgain = stepRow(stepOf('inner_a1'));
  const againStep = session.convergeLane({ lane: 'task_alpha', outcome: 'completed', summary: '迟到的第二条通知' });
  const afterAgain = stepRow(stepOf('inner_a1'));
  check(
    '19. 第二条通知收不到已经收口的那一步（不改口、不挪收口时刻）',
    againStep === null &&
      afterAgain?.t_end === beforeAgain?.t_end &&
      afterAgain?.verdict_text === beforeAgain?.verdict_text,
    `返回 ${againStep} / t_end ${beforeAgain?.t_end} → ${afterAgain?.t_end}`,
  );

  // 守卫写在 projector 里（同一条事件应用两次也不改口）。上面那条验的是**发事件的人**不发，
  // 这条验的是**应用事件的人**不听——两处各管一段，只验一处的话另一处怎么改都不会变红
  const twiceStep = stepOf('inner_a1')!;
  const before2 = stepRow(twiceStep);
  applyEvent(
    db,
    {
      type: 'lane.converged',
      payload: { stepId: twiceStep, lane: 'task_alpha', outcome: 'completed', summary: '重放里迟到的第二条', at: (before2?.t_end ?? 0) + 5000 },
    },
    // 这条事件不进 `events`（模拟的是重放里迟到的那一条），seq 给一个排在最后的数就行：
    // 收口幂等与 seq 无关，它只被证据分批用到
    {
      blobDir: blobDir(file),
      caseId: 'case_branch',
      seq: ((db.prepare(`SELECT MAX(seq) m FROM events`).get() as { m: number | null }).m ?? 0) + 1,
    },
  );
  const after2 = stepRow(twiceStep);
  check(
    '19b. 同一条收口事件应用两次也不改口（投影侧的幂等）',
    after2?.t_end === before2?.t_end && after2?.verdict_text === before2?.verdict_text,
    `t_end ${before2?.t_end} → ${after2?.t_end} / verdict ${JSON.stringify(after2?.verdict_text)}`,
  );
  // **幂等要连检索索引一起算**：步没变而索引多一条的话，跨案检索会把同一条支线翻出来两次，
  // 而 `steps` 上一切正常——只查步的那种检查看不见这一半
  check(
    '19c. 第二次应用不往检索索引里再塞一条摘要',
    narrativeRows(twiceStep) === 1,
    `narrative_fts 里 ${narrativeRows(twiceStep)} 条`,
  );

  // 通知里缺 `tool_use_id` 时不能就此撒手：`agent_id` 是桥的另一头，反查得到泳道。
  // 撒手的后果正是这次要修的那个形状——那条支线再没有人收得了
  const finG = probe.lanes.absorb(notify('ag_ghost', 'completed', 'ghost 查完了') as never);
  if (finG) probe.convergeLane(finG);
  check(
    '20. 通知缺 tool_use_id 时按 agent_id 反查泳道，照样收得掉',
    finG?.lane === 'task_ghost' && stepRow(stepOf('inner_g1'))?.status === 'converged',
    `反查到 ${finG?.lane}，那一步 status=${stepRow(stepOf('inner_g1'))?.status}`,
  );

  // 一次工具调用都没打的支线没有兜底步。**别为了"收口"凭空造一个空步**：
  // 轨道上会多出一个从没查过任何东西的节点，报告里也多一行
  const nothing = session.convergeLane({ lane: 'task_never', outcome: 'completed', summary: 'x' });
  check(
    '21. 没打过任何调用的支线没有步可收，不凭空造一个',
    nothing === null && !db.prepare(`SELECT 1 FROM steps WHERE lane='task_never'`).get(),
    `返回 ${nothing}`,
  );

  // 旁白只说轨道上看不见的事。收得到步的那条，支线自己的话已经是那张卡的结论；
  // 收不到步的那条一次调用都没打，轨道上根本没有它——那句话不落到旁白上就此丢掉
  // （起它的那次 Task 调用在库里只有"已经起来了"的回执，支线的结论走的是 task_notification）
  const chatCount = () =>
    (db.prepare(`SELECT COUNT(*) c FROM chat_lines WHERE case_id='case_branch'`).get() as { c: number }).c;
  const lastChat = () =>
    (db
      .prepare(`SELECT text FROM chat_lines WHERE case_id='case_branch' ORDER BY at DESC, rowid DESC`)
      .get() as { text: string } | undefined)?.text ?? '';

  probe.lanes.absorb(forwarded('task_said', 'inner_s1') as never);
  start('inner_s1', 'ag_said');
  const beforeSaid = chatCount();
  probe.convergeLane({ lane: 'task_said', agentId: 'ag_said', status: 'completed', summary: '从库延迟 4s' });
  check(
    '21b. 收得到步的支线不在旁白上再说一遍（那句话已经是卡面上的结论）',
    chatCount() === beforeSaid && !!stepRow(stepOf('inner_s1'))?.verdict_text?.includes('从库延迟 4s'),
    `旁白 ${beforeSaid} → ${chatCount()} 句 / verdict = ${JSON.stringify(stepRow(stepOf('inner_s1'))?.verdict_text)}`,
  );

  const beforeMute = chatCount();
  probe.convergeLane({
    lane: 'task_mute',
    agentId: 'ag_mute',
    status: 'completed',
    summary: '没查库，只读了代码：入口在 gateway',
  });
  check(
    '21c. 一次调用都没打的支线，它自己那句话落到旁白上（不然它没有任何地方能落）',
    chatCount() === beforeMute + 1 && lastChat().includes('入口在 gateway'),
    `旁白 ${beforeMute} → ${chatCount()} 句，末句 ${JSON.stringify(lastChat())}`,
  );

  const beforeEmpty = chatCount();
  probe.convergeLane({ lane: 'task_empty', agentId: 'ag_empty', status: 'completed', summary: '' });
  check(
    '21d. 既没调用也没留话、又是正常跑完的那条一个字都不说（说了也只是一句废话）',
    chatCount() === beforeEmpty,
    `旁白 ${beforeEmpty} → ${chatCount()} 句，末句 ${JSON.stringify(lastChat())}`,
  );

  probe.convergeLane({ lane: 'task_gone', agentId: 'ag_gone', status: 'stopped', summary: '' });
  check(
    '21e. 但被停下 / 失败收场的那条要说：人按过「停」得有回音，而它什么都没留下',
    chatCount() === beforeEmpty + 1 && lastChat().includes('被停下'),
    `旁白 ${beforeEmpty} → ${chatCount()} 句，末句 ${JSON.stringify(lastChat())}`,
  );

  // 认不出的 status 一律当跑完（`laneOutcome` / `laneEndLabel` 都这样）。**这一句也得按归一化后的
  // 判**：照原始值判的话，SDK 哪天多一个成功态，界面会一边说「跑完」一边插一句异常旁白
  const beforeNew = chatCount();
  probe.convergeLane({ lane: 'task_new', agentId: 'ag_new', status: 'succeeded', summary: '' });
  check(
    '21f. SDK 新增的成功态按跑完处理，不被当成异常收场多说一句',
    chatCount() === beforeNew,
    `旁白 ${beforeNew} → ${chatCount()} 句，末句 ${JSON.stringify(lastChat())}`,
  );

  // converged 是"这条支线到此为止"，不是一种结论。**借 inconclusive 的话每条跑完的支线
  // 都会变成报告里的一条「遗留问题」**（queries.ts 只看 status 不看 kind），而它谁都没落下
  const sections = reportSections(db, 'case_branch');
  check(
    '22. 收口的支线哪一栏报告都不进（尤其不是「遗留问题」）',
    sections.leftovers.length === 0 && sections.refuted.length === 0 && !sections.rootCause,
    `遗留问题 ${sections.leftovers.length} 条 / 被推翻 ${sections.refuted.length} 条 / 根因 ${sections.rootCause?.step_id ?? '无'}`,
  );

  // 停一条支线认的是 `agent_id`（A.1：`task_id` 就是它）。认不出来就不该发 stopTask——
  // 拿别的键去停，停不掉还是停错了都不会有任何报错
  check(
    '23. 还在跑的支线报得出 agent_id，收过尾的不再算「在跑」',
    probe.lanes.agentOf('agent:ag_race') === 'ag_race' &&
      probe.lanes.liveLanes.includes('agent:ag_race') &&
      !probe.lanes.liveLanes.includes('task_alpha'),
    `在跑的 ${JSON.stringify(probe.lanes.liveLanes)} / race 的 agent ${probe.lanes.agentOf('agent:ag_race')}`,
  );

  // 桥没合拢时这条支线是按 `agent:<agent_id>` 记的账，而通知带的是真 key。
  // **以已经记上账的那个为准**：信通知的话，收口去查一个库里从来没有过的 lane，
  // 那一步收不到、「停」也撤不掉，一条早就跑完的支线挂到会话结束才被当成 orphan
  const finR = probe.lanes.absorb(notify('ag_race', 'completed', 'race 查完了', 'task_race') as never);
  if (finR) probe.convergeLane(finR);
  check(
    '23b. 库里记的是临时 key 时，通知带着真 tool_use_id 也要收得掉那一步',
    finR?.lane === 'agent:ag_race' &&
      stepRow(raceStep)?.status === 'converged' &&
      !probe.lanes.liveLanes.includes('agent:ag_race'),
    `通知认到 ${finR?.lane}，那一步 status=${stepRow(raceStep)?.status}，在跑的 ${JSON.stringify(probe.lanes.liveLanes)}`,
  );

  // 一条泳道只收一次尾。再来一条照旧返回 LaneFinish 的话，收口那侧查不到开着的步，
  // 会把它解释成"这条支线没有留下任何调用"并再说一遍——而它明明查了一堆东西
  check(
    '23c. 同一条泳道的第二条通知直接被桥吃掉（不再惊动收口那侧）',
    probe.lanes.absorb(notify('ag_race', 'completed', '迟到的第二条', 'task_race') as never) === null,
    '第二条通知返回 null',
  );

  // 收尾那一段要有一条**还开着**的支线才验得到，上面几条已经把先前那些都收掉了
  probe.lanes.absorb(forwarded('task_orph', 'inner_o1') as never);
  start('inner_o1', 'ag_orph');

  // ── ⑤ 后台电平：主线不忙了不等于这次调查闲下来了 ──────────────────────────
  const bridge = new LaneBridge();
  check('12. 没有支线时电平是 0', bridge.backgroundLanes === 0, `实得 ${bridge.backgroundLanes}`);
  bridge.absorb({ type: 'system', subtype: 'background_tasks_changed', tasks: [{}, {}] });
  const up = bridge.backgroundLanes;
  const finish = bridge.absorb({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'ag_alpha',
    tool_use_id: 'task_alpha',
    status: 'stopped',
  });
  bridge.absorb({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  check(
    '13. 电平跟着 background_tasks_changed 上下（2 → 0）',
    up === 2 && bridge.backgroundLanes === 0,
    `升到 ${up}，落回 ${bridge.backgroundLanes}`,
  );
  check(
    '14. task_notification 认得出是哪条泳道收的尾（被停掉的支线不发 SubagentStop）',
    finish?.lane === 'task_alpha' && finish?.agentId === 'ag_alpha' && finish?.status === 'stopped',
    JSON.stringify(finish),
  );

  probe.lanes.absorb({ type: 'system', subtype: 'background_tasks_changed', tasks: [{}] } as never);
  const busyWithLane = runner.isBusy;
  runner.close('自检收尾。');
  check(
    '15. 只剩支线在后台时这次调查仍算「在跑」，收尾之后归零',
    busyWithLane && !runner.isBusy,
    `支线在跑时 ${busyWithLane}，close 之后 ${runner.isBusy}`,
  );

  // ── ⑥ 没人收得了的那些支线 ───────────────────────────────────────────────
  //
  // 收口只在通知到达时发生，而**关掉查询之后 SDK 保证不再有任何消息**——
  // 会话收尾时还开着的支线于是永远没有下一条通知。两处兜底各管一段：
  // 这个进程里的归 `close()`，上一个进程留下的归启动清扫。
  const orphan = stepRow(stepOf('inner_o1'));
  check(
    '24. 会话收尾时还开着的支线一并收口，并说清是没收尾的那种',
    orphan?.status === 'converged' && !!orphan?.verdict_text?.includes('没有收尾'),
    `那一步 status=${orphan?.status} verdict=${JSON.stringify(orphan?.verdict_text)}`,
  );

  // 上一个进程留下的：库里还开着的支线步，而它的会话早就没了。
  // 不扫的话轨道上永远有一条「进行中」的支线，等的是一条再也不会来的通知
  const zombie = new CaseRunner({
    db,
    blobDir: blobDir(file),
    promptText: '',
    caseId: 'case_zombie',
    intake: {
      title: '上一个进程',
      question: '上一个进程',
      projectRoot: null,
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    },
    agent: { backend: 'claude', model: null, effort: null },
    onChange: () => {},
  });
  const zprobe = zombie as unknown as Probe;
  zprobe.openSession();
  zprobe.lanes.absorb(forwarded('task_zzz', 'inner_z1') as never);
  zprobe.onToolStart({ tool_name: 'mcp__datasource__query_logs', tool_input: {}, agent_id: 'ag_zzz' }, 'inner_z1');
  const zStep = stepOf('inner_z1');
  const swept = sweepZombies(db, { blobDir: blobDir(file), now: () => Date.now() });
  check(
    '25. 启动清扫收得掉上一个进程留下的支线（它等的那条通知永远不会来）',
    swept.lanes === 1 && stepRow(zStep)?.status === 'converged',
    `扫到 ${swept.lanes} 条，那一步 status=${stepRow(zStep)?.status}`,
  );
  check(
    '25b. 已经收口的不会被再扫一遍（第二次扫是 0，不然每次启动都改一遍收口时刻）',
    sweepZombies(db, { blobDir: blobDir(file), now: () => Date.now() }).lanes === 0,
    '第二次清扫 0 条',
  );

  // ── ⑦ 断流与崩溃：没有人再按下「关闭」的那两条路 ──────────────────────────
  //
  // backend 崩了 / 消息流自己结束时**只走 `endOnce`**，而它之后 `consume()` 的 finally
  // 立刻 `lanes.reset()`——收口只挂在 `close()` 上的话，那几步就再没有人收得了：
  // 界面上一条永远"还在查"的支线，一直挂到下次启动清扫。这条要从 `consume()` 真的走一遍，
  // 光调 `endOnce` 验不到"崩溃那条路会不会绕过收口"
  const crashed = new CaseRunner({
    db,
    blobDir: blobDir(file),
    promptText: '',
    caseId: 'case_crash',
    intake: {
      title: '断流',
      question: '断流',
      projectRoot: null,
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    },
    agent: { backend: 'claude', model: null, effort: null },
    onChange: () => {},
  });
  const cprobe = crashed as unknown as Probe;
  cprobe.openSession();
  cprobe.lanes.absorb(forwarded('task_ccc', 'inner_c1') as never);
  cprobe.onToolStart({ tool_name: 'mcp__datasource__query_logs', tool_input: {}, agent_id: 'ag_ccc' }, 'inner_c1');
  const cStep = stepOf('inner_c1');
  const boom = (async function* () {
    throw new Error('模拟断流');
  })();
  cprobe.q = boom;
  await cprobe.consume(boom);
  check(
    '26. 消息流崩了也收口（那条路不经过 close，之后泳道映射就被清了）',
    stepRow(cStep)?.status === 'converged' && !!stepRow(cStep)?.verdict_text?.includes('出错'),
    `那一步 status=${stepRow(cStep)?.status} verdict=${JSON.stringify(stepRow(cStep)?.verdict_text)}`,
  );

  const bad = checks.filter(([, ok]) => !ok);
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
  if (bad.length) process.exit(1);
}

void main();
