/**
 * Spike Branch —— 验子 agent 泳道**接进轨道**这一段（overview §9.15 / §4.5 / D23）。
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
import { CaseRunner } from '../src/main/case-runner.js';
import { LaneBridge } from '../src/main/lane-bridge.js';
import { trackLayout } from '../src/renderer/track.js';

/** 泳道那几个方法是 CaseRunner 的私有面：要验的正是它们，只好从旁边够进去。 */
type Probe = {
  openSession(): unknown;
  onToolStart(input: unknown, toolUseID: string): { hookSpecificOutput?: { permissionDecision?: string } };
  lanes: LaneBridge;
};

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

/** 一条转发上来的子 agent 消息：桥的左半边。 */
const forwarded = (lane: string, ...callIds: string[]) => ({
  type: 'assistant',
  parent_tool_use_id: lane,
  message: { content: callIds.map((id) => ({ type: 'tool_use', id })) },
});

function main() {
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
  probe.openSession();

  const start = (callId: string, agentId?: string, tool = 'mcp__datasource__query_logs') =>
    probe.onToolStart({ tool_name: tool, tool_input: { q: callId }, agent_id: agentId }, callId);
  const stepOf = (callId: string) =>
    (db.prepare(`SELECT step_id FROM tool_calls WHERE id=?`).get(callId) as { step_id: string } | undefined)
      ?.step_id;
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

  // ── ③ 轨道：泳道就是一次分叉，trackLayout 不必认识 lane ──────────────────
  const rows = trackLayout(runner.snapshot().steps).rows;
  const depthOf = (stepId?: string) => rows.find((r) => r.step.id === stepId)?.depth;
  check(
    '8. 主干深度 0、两条支线深度 1，且行序仍是到达顺序',
    depthOf(stepOf('main_first')) === 0 &&
      depthOf(stepOf('inner_a1')) === 1 &&
      depthOf(stepOf('inner_b1')) === 1 &&
      rows.map((r) => r.step.ordinal).join(',') === rows.map((_, i) => i + 1).join(','),
    `深度 ${rows.map((r) => r.depth).join(',')} / 序号 ${rows.map((r) => r.step.ordinal).join(',')}`,
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

  // ── ⑤ 后台电平：主线不忙了不等于这个案子闲下来了 ──────────────────────────
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
    '15. 只剩支线在后台时这个案子仍算「在跑」，收尾之后归零',
    busyWithLane && !runner.isBusy,
    `支线在跑时 ${busyWithLane}，close 之后 ${runner.isBusy}`,
  );

  const bad = checks.filter(([, ok]) => !ok);
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
  if (bad.length) process.exit(1);
}

main();
