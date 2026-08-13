/**
 * Spike Track —— 验轨道布局这一带（D23 / ui.md §3）。
 *
 * 不起真会话：要验的那条约束**错了不会报错，只会让人读丢东西**——
 *
 *   1. **行序逐字是到达顺序。** 按树分组渲染看着更"整齐"，代价是一个晚到的分叉子节点
 *      会被挪到父的下面，把它和中间那几步已读的主干节点一起推走
 *   2. **追加不动已有的行。** 位置、缩进、序号、断点，一个都不许回头改：
 *      深度改成在整份列表里找父，一个"父在后面才到"的分叉就会在父到达那一刻让缩进跳一格；
 *      序号改成"多会话才带 S1# 前缀"，第二次会话一开就会把每一行都重写一遍，
 *      顶上那个断点块还会把所有已读的卡整体下推
 *   3. **推翻者不在轨道上时那一行照样划掉。** 曲线画不出来只是少个指向，
 *      划线没了则是把一个已经作废的结论显示成仍然成立的
 *
 * 大头是纯函数，末尾另有一条要碰库的：轨道认"父不在本次排查就当主干"，
 * 而 `steps.parent_step_id` 上有开着的外键——写入侧不先归一，那条契约在库那一层就先炸了。
 *
 * 跑：npm run rebuild:node && npm run spike:track
 */

import { blobDir, openDatabase } from '../src/backend/db/database.js';
import { createInvestigationSession } from '../src/backend/store/sqlite-store.js';
import { MAX_DEPTH, trackLayout } from '../src/renderer/track.js';
import type { StepNode } from '../src/shared/ipc.js';

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

let seq = 0;
function step(p: Partial<StepNode> & { id: string }): StepNode {
  return {
    ordinal: ++seq,
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

/**
 * 到达顺序：分叉 c1 在两条主干之后才到，c2 是分叉的分叉。
 *
 * **`fwd` 的父 `tail` 在整份列表的最后**——前缀稳定性那条检查全靠它：没有这么一行，
 * "在整份列表里找父"这个错法在每个前缀里算出来的都一样，检查照样全绿。
 */
const arrival = [
  step({ id: 'a' }),
  step({ id: 'b' }),
  step({ id: 'c1', parentStepId: 'a' }),
  step({ id: 'fwd', parentStepId: 'tail' }),
  step({ id: 'd' }),
  step({ id: 'c2', parentStepId: 'c1' }),
  step({ id: 'ghost', parentStepId: 'nope' }),
  // 末尾两行属于第二次会话：不跨会话的话，"第二次会话一开就回头改写已有行"这个错法
  // 在这份夹具里根本触发不到，前缀稳定性那条会照样全绿
  step({ id: 'self', parentStepId: 'self', sessionId: 'se2', sessionIndex: 2, ordinal: 1 }),
  step({ id: 'tail', sessionId: 'se2', sessionIndex: 2, ordinal: 2 }),
];

const L = trackLayout(arrival);

check(
  '行序逐字是到达顺序，晚到的分叉不上移',
  L.rows.map((r) => r.step.id).join(',') === 'a,b,c1,fwd,d,c2,ghost,self,tail',
  `实得 ${L.rows.map((r) => r.step.id).join(',')} —— 按树分组的话 c1 会插到 a 后面，把 b 推走`,
);

check(
  '分叉只向右生长，主干不受影响',
  L.rows.map((r) => r.depth).join(',') === '0,0,1,0,0,2,0,0,0',
  `实得深度 ${L.rows.map((r) => r.depth).join(',')} —— d 在 c1 之后仍回到主干`,
);

const ghost = L.rows[6]!;
const self = L.rows[7]!;
check(
  '父不存在 / 自引用一律落回主干（写入侧之外的第二道）',
  ghost.depth === 0 && ghost.parentLabel === null && self.depth === 0,
  'agent 手写的 id 打错一个字符不该让整条轨道空掉',
);

// 追加一行不动已有的任何一行：逐个前缀与全量比
let stable = true;
let firstDrift = '';
for (let n = 1; n <= arrival.length; n++) {
  const pre = trackLayout(arrival.slice(0, n)).rows;
  for (let i = 0; i < n; i++) {
    const a = pre[i]!;
    const b = L.rows[i]!;
    // **序号与断点也要比，不只是位置。** 只比 id/depth 的话，"第二次会话一开就把所有
    // 已有行改成 S1#N 并在顶上插一个断点块"这种回头改写整条溜过去
    if (a.step.id !== b.step.id || a.depth !== b.depth || a.label !== b.label || a.sessionBreak !== b.sessionBreak) {
      stable = false;
      firstDrift ||= `前缀 ${n} 的第 ${i} 行是 ${a.step.id}/深度${a.depth}/${a.label}/断点${a.sessionBreak}，全量里是 ${b.step.id}/深度${b.depth}/${b.label}/断点${b.sessionBreak}`;
    }
  }
}
check('追加一行不动已有行的位置与缩进', stable, firstDrift || '每个前缀都是全量的前缀');

// 父在后面才到：只认已出现过的父，所以它一直是主干——否则父到达那一刻它会跳一格
const forward = [step({ id: 'early', parentStepId: 'late' }), step({ id: 'late' })];
check(
  '父在后面才到的，一直当主干',
  trackLayout(forward).rows[0]!.depth === 0 && trackLayout(forward.slice(0, 1)).rows[0]!.depth === 0,
  '在整份列表里找父的话，late 一到 early 就从主干跳成分叉',
);

// 缩进封顶：链条比 MAX_DEPTH 深时不再右移，但父子关系仍标出来
const deep: StepNode[] = [];
for (let i = 0; i <= MAX_DEPTH + 2; i++) {
  deep.push(step({ id: `n${i}`, parentStepId: i ? `n${i - 1}` : null }));
}
const D = trackLayout(deep);
check(
  `缩进封顶在 ${MAX_DEPTH}，父子关系仍在`,
  D.rows.every((r) => r.depth <= MAX_DEPTH) &&
    D.rows[MAX_DEPTH + 1]!.depthCapped &&
    D.rows[MAX_DEPTH + 1]!.parentLabel !== null &&
    !D.rows[MAX_DEPTH]!.depthCapped,
  `实得深度 ${D.rows.map((r) => r.depth).join(',')} —— 不封顶的话深链会把卡片挤出画布`,
);

// 推翻：两头都在轨道上时给一条回指线，方向是推翻者 → 被推翻者
const refute = [
  step({ id: 'old', supersededBy: 'new', status: 'superseded' }),
  step({ id: 'new' }),
];
const R = trackLayout(refute);
check(
  '推翻回指线从推翻者指向被推翻者',
  R.edges.length === 1 && R.edges[0]!.fromId === 'new' && R.edges[0]!.toId === 'old',
  JSON.stringify(R.edges),
);
check(
  '被推翻的那一行写出推翻它的是谁，推翻者那一行写出它推翻了谁',
  R.rows[0]!.refutedBy === `#${refute[1]!.ordinal}` &&
    R.rows[1]!.refutes.join() === `#${refute[0]!.ordinal}`,
  `被推翻行标 ${R.rows[0]!.refutedBy}，推翻行标 ${R.rows[1]!.refutes.join()} —— 不标的话得顺着曲线找另一头`,
);

// 推翻者不在这条轨道上（跨案 / 还没到）：曲线画不出来，划线照旧
const orphan = trackLayout([step({ id: 'lonely', supersededBy: 'elsewhere', status: 'superseded' })]);
check(
  '推翻者不在轨道上时，曲线没有但划线仍在',
  orphan.edges.length === 0 && orphan.rows[0]!.refutedBy === '',
  `refutedBy=${JSON.stringify(orphan.rows[0]!.refutedBy)} —— 给 null 的话这一步会显示成仍然成立`,
);

// 第二次会话开起来时，已经渲染出去的那几行一个字都不该变
const s1only = [
  step({ id: 'y1', ordinal: 1, sessionId: 'se1', sessionIndex: 1 }),
  step({ id: 'y2', ordinal: 2, sessionId: 'se1', sessionIndex: 1, supersededBy: 'y3', status: 'superseded' }),
];
const withS2 = [...s1only, step({ id: 'y3', ordinal: 1, sessionId: 'se2', sessionIndex: 2 })];
const A = trackLayout(s1only);
const B = trackLayout(withS2);
check(
  '第二次会话开起来，已有行的序号与断点一个都不变',
  A.rows.every((r, i) => r.label === B.rows[i]!.label && r.sessionBreak === B.rows[i]!.sessionBreak),
  `之前 ${A.rows.map((r) => r.label + (r.sessionBreak ? '(断)' : '')).join(',')}，` +
    `之后 ${B.rows.slice(0, 2).map((r) => r.label + (r.sessionBreak ? '(断)' : '')).join(',')}` +
    ' —— 改成 S1#N 是回头改写，顶上插断点块更是把每张已读的卡整体下推',
);
check(
  '断点标在新会话那一行，第一行永远不标',
  !B.rows[0]!.sessionBreak && !B.rows[1]!.sessionBreak && B.rows[2]!.sessionBreak,
  `断点落在第 ${B.rows.findIndex((r) => r.sessionBreak)} 行`,
);
check(
  '跨会话的引用才带会话号，同会话内不带',
  B.rows[1]!.refutedBy === 'S2#1' &&
    B.rows[2]!.refutes.join() === 'S1#2' &&
    R.rows[0]!.refutedBy === `#${refute[1]!.ordinal}`,
  `跨会话被推翻标 ${B.rows[1]!.refutedBy}、推翻标 ${B.rows[2]!.refutes.join()}；同会话标 ${R.rows[0]!.refutedBy}`,
);

// ── 写入侧：父 id 不认得时必须归一成主干，并且当场说 ──────────────────────────
async function storeChecks() {
  const db = openDatabase(':memory:');
  let n = 0;
  const ctx = {
    caseId: 'c1',
    sessionId: 'se_1',
    blobDir: blobDir(':memory:'),
    newId: (p: string) => `${p}_${++n}`,
    now: () => 1_754_900_000_000,
    isTimestampedSource: () => false,
    backend: 'claude' as const,
    model: null,
    effort: null,
    runOperator: async () => ({}) as never,
  };
  const intake = {
    title: 't',
    question: 'q',
    projectRoot: null,
    incidentDate: '2026-08-09',
    tzOffset: '+08:00',
    clues: null,
  };
  const s1 = createInvestigationSession(db, ctx as never, intake);
  const root = await s1.store.openStep({ direction: '真父' });

  // **接住这一下**：退回旧写法时它抛的是 SqliteError，不接的话整个 spike 当场死在这里，
  // 后面几条一条都跑不到，而计数看着像"全过"（0 PASS / 0 FAIL）
  const bogus = await s1.store
    .openStep({ direction: '父 id 打错了', parentStepId: 'st_typo' })
    .catch((e: Error) => e);
  check(
    '父 id 不认得时归一成主干，而不是让外键把这一步整个炸掉',
    !(bogus instanceof Error) &&
      (db.prepare(`SELECT parent_step_id p FROM steps WHERE id=?`).get(bogus.stepId) as { p: string | null }).p ===
        null,
    bogus instanceof Error
      ? `抛了：${bogus.message} —— 原样发出去时事务回滚，step 压根开不出来`
      : '归一成了主干',
  );
  check(
    '归一了要当场说，不能静默丢掉',
    !(bogus instanceof Error) && bogus.warnings.some((w) => w.includes('st_typo')),
    bogus instanceof Error
      ? '上一条就没过'
      : `warnings=${JSON.stringify(bogus.warnings)} —— 不说的话 agent 以为分叉已经记下了`,
  );

  // 别的排查的 step 过得了外键，却不在这条轨道上——落库也只能当主干显示
  const other = createInvestigationSession(
    db,
    { ...ctx, caseId: 'c2', sessionId: 'se_2' } as never,
    intake,
  );
  const foreign = await other.store.openStep({ direction: '别的排查里的一步' });
  const crossCase = await s1.store.openStep({ direction: '认了别案的父', parentStepId: foreign.stepId });
  check(
    '父在别的排查里同样按主干记（外键放行，但轨道上看不见它）',
    (db.prepare(`SELECT parent_step_id p FROM steps WHERE id=?`).get(crossCase.stepId) as { p: string | null })
      .p === null && crossCase.warnings.length > 0,
    '只校验"这个 id 存在吗"就会放它过去，agent 以为分叉了，轨道上却是一条主干',
  );

  const good = await s1.store.openStep({ direction: '正常分叉', parentStepId: root.stepId });
  check(
    '认得的父照旧落库，不误伤',
    (db.prepare(`SELECT parent_step_id p FROM steps WHERE id=?`).get(good.stepId) as { p: string | null }).p ===
      root.stepId && good.warnings.length === 0,
    '校验写紧了会把真分叉也打成主干',
  );
}

await storeChecks();

console.log('\n===== Spike Track 结果 =====');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
