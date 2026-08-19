/**
 * Spike Live —— 验舞台心跳层的判断（`src/renderer/live.ts` 与 `clock.ts`）。
 *
 * 这一层回答的是"此刻在干什么"，错法全是安静的：
 *
 *   1. **把没在动的说成在动。** 停掉的支线在库里留着一条 `pending` 的调用，卡在闸门上的
 *      那一步一次调用都跑不了——两种都会让一张定死的卡挂上一个永远走下去的秒表，
 *      而人正是靠这个秒表判断"它还活着"
 *   2. **主干与支线串味。** 同时在跑的可以有好几步（`ensureStep(lane)` 按泳道各算各的），
 *      认成"最新那一张"的话，屏幕上会有一张卡替另一条线报秒数
 *   3. **计数把还没回来的那次也数进去。** 那等于说它已经有结果了
 *   4. **「最后更新」漏掉某一类活动。** 它答的是"这段时间里有没有新东西"，
 *      漏一类就是把还在跑的调查说成停住了
 *   5. **秒钟没人订了还在跑。** 空闲时每秒唤醒一次，没有任何报错
 *
 * 纯函数，不碰库、不起会话。跑：npm run spike:live
 */

import { readFileSync } from 'node:fs';

import { clockRunning, subscribeSecond } from '../src/renderer/clock.js';
import { elapsedText, lastUpdate, laneActivity, stepActivity, thinkingStep } from '../src/renderer/live.js';
import type { CallNode, ChatLine, StepNode } from '../src/shared/ipc.js';

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

const T0 = 1_000_000;

function call(p: Partial<CallNode> & { id: string; startedAt: number }): CallNode {
  return {
    callNumber: 1,
    toolName: 'Bash',
    origin: 'agent',
    status: p.endedAt === undefined || p.endedAt === null ? 'pending' : 'done',
    input: '{}',
    gate: null,
    outputPreview: '',
    outputLines: 0,
    endedAt: null,
    ...p,
  };
}

let seq = 0;
function step(p: Partial<StepNode> & { id: string }): StepNode {
  return {
    startedAt: T0 + ++seq * 1000,
    endedAt: null,
    ordinal: seq,
    sessionId: 'se1',
    sessionIndex: 1,
    parentStepId: null,
    lane: null,
    kind: 'normal',
    status: 'open',
    direction: p.id,
    verdict: null,
    confidence: null,
    supersededBy: null,
    calls: [],
    evidence: [],
    ...p,
  };
}

const ev = (id: string) => ({ id, claim: id, anchor: null, occurredAtRaw: null, actor: null, callId: 'x' });

/** 一个人都没在等的时候。 */
const NOBODY: ReadonlySet<string> = new Set();
/** 一条泳道都没在跑的时候。 */
const NO_LANES: ReadonlySet<string> = new Set();
/** 夹具里那些步都挂在 `se1` 上（见 `step()`）。 */
const NOW_SESSION = 'se1';
const IDLE = {
  waiting: false,
  busy: false,
  liveLanes: NO_LANES,
  sessionId: NOW_SESSION,
  thinkingStepId: null,
};

// ── ① 主干与支线各有一步在跑，两步各算各的 ────────────────────────────────
{
  const trunk = step({
    id: 'st1',
    calls: [
      call({ id: 'c1', toolName: 'Grep', startedAt: T0, endedAt: T0 + 500 }),
      call({ id: 'c2', toolName: 'Read', startedAt: T0 + 600, endedAt: T0 + 900 }),
      call({ id: 'c3', toolName: 'Bash', startedAt: T0 + 4000 }),
    ],
    evidence: [ev('e1'), ev('e2')],
  });
  const branch = step({
    id: 'st2',
    lane: 'toolu_aa',
    calls: [call({ id: 'c4', toolName: 'WebFetch', startedAt: T0 + 2000 })],
  });
  const steps = [trunk, branch];
  const ctx = {
    ...IDLE,
    busy: true,
    liveLanes: new Set(['toolu_aa']),
    thinkingStepId: thinkingStep(steps, NOW_SESSION),
  };

  const a = stepActivity(trunk, ctx);
  const b = stepActivity(branch, ctx);
  check(
    '同一份 steps 里主干与支线各报各的工具，不串',
    a?.kind === 'call' && a.toolName === 'Bash' && b?.kind === 'call' && b.toolName === 'WebFetch',
    `主干=${a?.kind === 'call' ? a.toolName : a?.kind}，支线=${b?.kind === 'call' ? b.toolName : b?.kind}`,
  );
  check(
    '计数只数收回来了的调用',
    a?.calls === 2 && a.evidence === 2,
    `实得 ${a?.calls} 调用 / ${a?.evidence} 证据 —— 三次调用里 c3 还在跑，数进去等于说它已经有结果了`,
  );
  check(
    '秒表从那次调用起跑的时刻算，不是从这一步开出来算',
    a?.since === T0 + 4000 && a.since !== trunk.startedAt,
    `实得 ${a?.since}，那次调用 startedAt=${T0 + 4000}、这一步 startedAt=${trunk.startedAt}（两个数必须不同，否则这条检查是空的）`,
  );
  check(
    '「在想」只认主干那一步',
    thinkingStep(steps, NOW_SESSION) === 'st1',
    `实得 ${thinkingStep(steps, NOW_SESSION)} —— 支线在想还是在等，harness 这侧分不出来`,
  );

  const laneA = laneActivity(steps, 'toolu_aa', NOBODY, NOW_SESSION);
  check(
    '列头芯片报的是那条泳道自己在跑的工具',
    laneA.kind === 'call' && laneA.toolName === 'WebFetch' && laneA.since === T0 + 2000,
    `实得 ${JSON.stringify(laneA)}`,
  );
  check(
    '别的泳道问不出工具名，但那是「在跑」不是「在等」',
    laneActivity(steps, 'toolu_zz', NOBODY, NOW_SESSION).kind === 'live',
    '两次调用之间也走这一档 —— 与"挂在人身上"混成一档的话，列头会替卡在闸门上的支线喊在跑',
  );
}

// ── ② 并发那一批取最早起的那次 ────────────────────────────────────────────
{
  const s = step({
    id: 'st_par',
    calls: [
      call({ id: 'p2', toolName: 'Read', startedAt: T0 + 5000 }),
      call({ id: 'p1', toolName: 'Grep', startedAt: T0 + 1000 }),
    ],
  });
  const a = stepActivity(s, { ...IDLE, busy: true, thinkingStepId: 's_other' });
  check(
    '一步里几次调用并发时，秒表报最久那个',
    a?.kind === 'call' && a.toolName === 'Grep' && a.since === T0 + 1000,
    `实得 ${a?.kind === 'call' ? a.toolName : a?.kind} —— 报最新那个的话，「未回」永远落不到真的慢的那次上`,
  );
}

// ── ③ 三种"没在动" ────────────────────────────────────────────────────────
{
  const waiting = step({ id: 'st_w', calls: [call({ id: 'w1', toolName: 'Bash', startedAt: T0 })] });
  check(
    '卡在①/②档上的一步整条底带不出现',
    stepActivity(waiting, { ...IDLE, waiting: true, busy: true, thinkingStepId: 'st_w' }) === null,
    '此刻它确实没在动，装成在动是骗人；那一档由「等你处理」与待办卡说',
  );

  const shut = step({
    id: 'st_c',
    status: 'converged',
    calls: [call({ id: 's1', toolName: 'Bash', startedAt: T0 })],
  });
  check(
    '已收口的一步里留着的 pending 调用不当成在跑',
    stepActivity(shut, { ...IDLE, busy: true, thinkingStepId: 'st_c' }) === null,
    '停一条支线正是这么留下来的 —— 认它的话那张定稿的卡会挂上一个永远走下去的秒表',
  );
  check(
    '收口的那一步也不算进列头芯片',
    laneActivity([{ ...shut, lane: 'toolu_bb' }], 'toolu_bb', NOBODY, NOW_SESSION).kind === 'live',
    '理由同上，两处必须一致：只有一处认，另一处会给出相反的说法',
  );

  // 支线的调用照样过闸门（`onToolStart` 不看 agent_id），挂上去之后它在库里仍是 pending、
  // 那条泳道也仍在 liveLanes 里——列头要是照数，同一次调用会被卡片说成「等你处理」、
  // 被列头说成「跑了 22 秒」，而人信的是那个走字的秒表
  const gated = step({
    id: 'st_g',
    lane: 'toolu_dd',
    calls: [call({ id: 'g1', toolName: 'Bash', startedAt: T0 })],
  });
  const heldOnly = laneActivity([gated], 'toolu_dd', new Set(['g1']), NOW_SESSION);
  check(
    '整条支线挂在人身上时，列头给的是「在等」而不是「在跑」',
    heldOnly.kind === 'waiting' &&
      (laneActivity([gated], 'toolu_dd', NOBODY, NOW_SESSION) as { toolName?: string }).toolName === 'Bash',
    `实得 ${JSON.stringify(heldOnly)} —— 退成 'live' 的话列头照旧喊「在跑」，` +
      '而人扫列头找活口时会正好跳过那一列。两个方向都验，否则这条可以靠"永远返回 waiting"通过',
  );
  check(
    '卡片与列头对同一次调用给的说法一致',
    stepActivity(gated, { ...IDLE, waiting: true, busy: true, liveLanes: new Set(['toolu_dd']) }) === null &&
      heldOnly.kind === 'waiting',
    '两处必须同时闭嘴 —— 只有一处认的话，一屏上会出现两句相反的话',
  );

  /**
   * 崩溃之后那一档。`consume()` 的 finally 把 `busy` 与 `liveLanes` 一起归零，却**不会**
   * 把主干那几条没收的调用改掉（`endOnce` 只收支线），它们要等下次启动的 `sweepZombies()`
   * 才变成 `abandoned`。只认库里那个 `pending` 的话，崩溃横幅已经挂出来了，
   * 卡上那枚秒表还在替一次早就没人管的调用一秒一秒往上加。
   */
  const zombieTrunk = step({ id: 'st_z', calls: [call({ id: 'z1', toolName: 'Bash', startedAt: T0 })] });
  check(
    '会话崩掉之后，主干那条没收的调用不再算在跑',
    stepActivity(zombieTrunk, { ...IDLE, busy: false }) === null &&
      (stepActivity(zombieTrunk, { ...IDLE, busy: true }) as { toolName?: string } | null)?.toolName === 'Bash',
    'busy 假就该闭嘴、真才报工具名 —— 两个方向都验，否则这条可以靠"永远返回 null"通过',
  );
  const zombieLane = step({
    id: 'st_zl',
    lane: 'toolu_ee',
    calls: [call({ id: 'z2', toolName: 'Grep', startedAt: T0 })],
  });
  check(
    '支线那一头看的是它自己那条泳道，不是 busy',
    stepActivity(zombieLane, { ...IDLE, busy: true }) === null &&
      (
        stepActivity(zombieLane, { ...IDLE, busy: false, liveLanes: new Set(['toolu_ee']) }) as {
          toolName?: string;
        } | null
      )?.toolName === 'Grep',
    '主线交回来了支线照样在后台查，所以支线不能看 busy；反过来泳道没了它也不该还在报秒数',
  );

  /**
   * 崩溃之后**接着发一句话**那一档。`App.submit` 在会话不 live 时走的是 `start()`：
   * `beginSession()` 换一个新 session 并把 `busy` 推回真，而上一次会话那条没收的调用
   * 仍旧是 `pending`（`endOnce('crashed')` 只收支线，那些行要等下次启动的
   * `sweepZombies()`）。只看 `busy` 的话，刚安静下去的僵尸卡会在新一轮一开就活过来。
   */
  const oldTurn = step({
    id: 'st_old',
    sessionId: 'se0',
    sessionIndex: 1,
    calls: [call({ id: 'o1', toolName: 'Bash', startedAt: T0 })],
  });
  check(
    '新一轮开起来之后，上一次会话那条没收的调用照旧不算在跑',
    stepActivity(oldTurn, { ...IDLE, busy: true }) === null &&
      (stepActivity({ ...oldTurn, sessionId: NOW_SESSION }, { ...IDLE, busy: true }) as {
        toolName?: string;
      } | null)?.toolName === 'Bash',
    '同一份数据只差 sessionId：旧会话的该闭嘴、这一轮的才报工具名 —— 两个方向都验',
  );
  const oldLane = { ...oldTurn, id: 'st_oldlane', lane: 'toolu_ff' };
  check(
    '列头与卡片在会话这道闸上说的是同一句话',
    laneActivity([oldLane], 'toolu_ff', NOBODY, NOW_SESSION).kind === 'live' &&
      stepActivity(oldLane, { ...IDLE, busy: true, liveLanes: new Set(['toolu_ff']) }) === null &&
      (laneActivity([{ ...oldLane, sessionId: NOW_SESSION }], 'toolu_ff', NOBODY, NOW_SESSION) as {
        toolName?: string;
      }).toolName === 'Bash',
    '旧会话那一步两处都不认（列头退回说不出在跑什么）、这一轮的两处都认 —— ' +
      '只有一处筛会话的话，卡上什么都没有而列头还在报秒数',
  );
  check(
    '「agent 在想」不会落到上一次会话最后那张开着的卡上',
    thinkingStep([oldTurn, step({ id: 'st_new' })], NOW_SESSION) === 'st_new' &&
      thinkingStep([oldTurn], NOW_SESSION) === null,
    '旧那张排在前面也排得到后面 —— 不筛会话的话，新一轮刚开的那几十秒里它会顶着一个从几小时前算起的秒数',
  );

  const idle = step({ id: 'st_i' });
  check(
    '这一轮已经交回来了（busy 假）就没有「在想」这一档',
    stepActivity(idle, { ...IDLE, thinkingStepId: 'st_i' }) === null,
    '主干那一步照旧开着，但没人在跑 —— 那时它确实什么也没干',
  );

  // startedAt 写死，不吃 step() 那个自增序号：序号会随夹具增删漂移，
  // 漂过那次调用的收回时刻之后这条验的就不再是"从最后一次收回来那刻算"了
  const thinking = step({
    id: 'st_t',
    startedAt: T0,
    calls: [call({ id: 't1', toolName: 'Bash', startedAt: T0, endedAt: T0 + 7000 })],
  });
  const ta = stepActivity(thinking, { ...IDLE, busy: true, thinkingStepId: 'st_t' });
  check(
    '没有调用在跑但这一轮没交回来 → 「在想」，从最后一次收回来那刻算',
    ta?.kind === 'thinking' && ta.since === T0 + 7000,
    `实得 ${ta?.kind} / ${ta?.since} —— 从这一步开出来算的话，一步跑久了这个数就永远在涨`,
  );
  check(
    '支线不给「在想」这一档',
    stepActivity(step({ id: 'st_bt', lane: 'toolu_cc' }), {
      ...IDLE,
      busy: true,
      liveLanes: new Set(['toolu_cc']),
      thinkingStepId: 'st_t',
    }) === null,
    'thinkingStepId 只认主干那一步，支线对不上就是 null',
  );
}

// ── ④ 最后更新 ────────────────────────────────────────────────────────────
{
  const s1 = step({ id: 'u1', startedAt: T0, calls: [call({ id: 'x1', startedAt: T0 + 100, endedAt: T0 + 9000 })] });
  const s2 = step({ id: 'u2', startedAt: T0 + 500 });

  const onlyChat = lastUpdate([s2], [{ id: 'ch1', role: 'assistant', text: 'x', at: T0 + 20_000 }]);
  check(
    '只有对话没有调用时，最后更新取那句话，且没有落点',
    onlyChat.at === T0 + 20_000 && onlyChat.stepId === null,
    `实得 ${onlyChat.at} / ${onlyChat.stepId} —— 对话不属于任何一步，「跳过去」由调用方退回图上最后一张`,
  );

  const callLater = lastUpdate([s1, s2], [{ id: 'ch1', role: 'assistant', text: 'x', at: T0 + 200 }]);
  check(
    '调用晚于对话时，最后更新取那次调用并落在它那一步上',
    callLater.at === T0 + 9000 && callLater.stepId === 'u1',
    `实得 ${callLater.at} / ${callLater.stepId} —— 只看对话的话，一次几十分钟的批查会被说成"停了"`,
  );

  const running = lastUpdate(
    [step({ id: 'u3', startedAt: T0, calls: [call({ id: 'x2', startedAt: T0 + 30_000 })] })],
    [],
  );
  check(
    '还没回来的调用按它起跑那刻算',
    running.at === T0 + 30_000 && running.stepId === 'u3',
    `实得 ${running.at} —— 起跑本身就是"发生了一件事"`,
  );

  // close_step 是结构工具，被三条 hook 挡在 tool_calls 之外；证据也只在 close 里落。
  // 所以"刚收了一步、刚挂上证据"这件事只有 step.endedAt 说得出
  const closed = lastUpdate(
    [
      step({
        id: 'u4',
        startedAt: T0,
        status: 'confirmed',
        endedAt: T0 + 90_000,
        calls: [call({ id: 'x3', startedAt: T0 + 100, endedAt: T0 + 5_000 })],
      }),
    ],
    [{ id: 'ch2', role: 'assistant', text: 'x', at: T0 + 300 }],
  );
  check(
    '刚收口的那一步算一次更新（收口不进 tool_calls，只有 step.endedAt 说得出）',
    closed.at === T0 + 90_000 && closed.stepId === 'u4',
    `实得 ${closed.at} / ${closed.stepId} —— 只看调用与对话的话，最有进展的那一下会被说成"3 分钟没动静"`,
  );

  check('什么都没有时给 0，界面据此闭嘴', lastUpdate([], []).at === 0, '编一个"刚刚"出来与真的刚刚长得一样');
}

// ── ⑤ 时长文案 ────────────────────────────────────────────────────────────
{
  const cases: [number, boolean, string][] = [
    [0, false, '0s'],
    [40_000, false, '40s'],
    [59_000, false, '59s'],
    [60_000, false, '1m0s'],
    [200_000, false, '3m20s'],
    [3_600_000, false, '1h0m'],
    [3_725_000, false, '1h2m'],
    [-5_000, false, '0s'],
  ];
  for (const [ms, stale, want] of cases) {
    check(`时长 ${ms}ms → ${want}`, elapsedText(ms, stale) === want, `实得 ${elapsedText(ms, stale)}`);
  }
  check(
    '不到 60s 不缀「未回」，到了就缀',
    elapsedText(59_999, true) === '59s' && elapsedText(60_000, true) === '1m0s 未回',
    `实得 ${elapsedText(59_999, true)} / ${elapsedText(60_000, true)}`,
  );
  check(
    '「在想」那一档不缀「未回」',
    elapsedText(200_000) === '3m20s',
    '「未回」说的是一次调用没回来，agent 想久一点不是同一回事',
  );
}

// ── ⑥ 秒钟：没人订了定时器要真的停 ────────────────────────────────────────
{
  check('一个人都没订时定时器本来就不该在跑', !clockRunning(), `实得 ${clockRunning()}`);
  const off1 = subscribeSecond(() => {});
  const off2 = subscribeSecond(() => {});
  const runningWithSubs = clockRunning();
  off1();
  const stillRunning = clockRunning();
  off2();
  check(
    '有人订就起、订阅数回到 0 就停',
    runningWithSubs && stillRunning && !clockRunning(),
    `订两个=${runningWithSubs}、退一个=${stillRunning}、都退掉=${clockRunning()} —— 留着的话调查空闲时它照旧每秒唤醒`,
  );
}

// ── ⑦ 会动的东西都要有人关得掉 ────────────────────────────────────────────
/**
 * 心跳层是**给会变的量、不给动画**：关掉 `prefers-reduced-motion` 之后工具名、秒数、
 * 计数照旧在变，功能一点不少。但这句话只有在动效真的关得掉时才算数。
 *
 * 这一条验的不是"我写了那个 media query"，而是**每一条 `animation:` 都在某处被关掉过**。
 * 它防的是一种没有任何报错的失手：往选择器列表中间插一条声明，会把它前面那几个选择器
 * 一起切给新声明，`animation: none` 于是只剩最后一个选择器还带着——正好发生过一次。
 */
{
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const animates = new Set<string>();
  const silenced = new Set<string>();
  const walk = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, j - 1);
      // @keyframes 的内容是关键帧不是选择器，整块跳过；其余 at-rule 往里走一层
      if (prelude.startsWith('@')) {
        if (!prelude.startsWith('@keyframes')) walk(body);
      } else if (prelude) {
        const m = /(?:^|[;\s])animation(?:-name)?\s*:\s*([^;]+)/.exec(body);
        if (m) {
          const target = /\bnone\b/.test(m[1]!) ? silenced : animates;
          for (const sel of prelude.split(',').map((x) => x.trim()).filter(Boolean)) target.add(sel);
        }
      }
      i = j;
    }
  };
  walk(css);
  const uncovered = [...animates].filter((sel) => !silenced.has(sel));
  check(
    '每一条会动的规则都在 prefers-reduced-motion 里被关掉',
    animates.size > 0 && uncovered.length === 0,
    `会动的 ${animates.size} 条、关掉的 ${silenced.size} 条；没人关的：${uncovered.join(' | ') || '（无）'}`,
  );
}

console.log('\n===== Spike Live 结果 =====');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
