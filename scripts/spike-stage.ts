/**
 * Spike Stage —— 验舞台画布的几何这一带（D23 / ui.md §3）。
 *
 * 舞台从"一条纵向文档流"改成了"一整幅可缩放拖拽的画布"，位置因此是**算出来的**而不再
 * 交给文档流。算错不会报错，只会让人读丢东西，而且全是安静的错法：
 *
 *   1. **追加会挪动已经落笔的卡。** 节点每几秒钻出来一个，任何"回头看一眼全局再排"
 *      都会让正读着的那一张跑掉。这一条是整块画布唯一不可让步的约束
 *   2. **一条支线的第二步另开一列。** 列是语义轴（"这一列是谁在查"），同一条子 agent
 *      的两步分到两列之后，那个轴就什么也说不出了
 *   3. **列号被回收。** 一条线收口之后把它的列让给下一条，同一列上下两张卡就分属
 *      两条互不相干的推理，而"顺着一列往下读"正是这个轴唯一的读法
 *   4. **卡片高度与裁行数对不上。** 高度是按估出来的行数算的，渲染那侧用同一个数去裁；
 *      两处不一致的表现是安静地裁掉半行字，而那半行多半正是那一步的假设句
 *   5. **旁白推进主干的游标。** agent 每说一句话就把接下来的每一步整体下移一截，
 *      而那句话与那一步无关
 *
 * 纯函数，不碰库、不起会话。跑：npm run spike:stage
 */

import {
  CASE_BOX_ID,
  STAGE,
  TAIL_BOX_ID,
  TAIL_VERDICT_LINES,
  TITLE_LINES,
  TRUNK,
  VERDICT_LINES,
  directionText,
  estLines,
  heightOf,
  refuteEdges,
  stageLayout,
  trackLayout,
  weaveChat,
} from '../src/renderer/track.js';
import type { ChatLine, StepNode } from '../src/shared/ipc.js';

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

let seq = 0;
function step(p: Partial<StepNode> & { id: string }): StepNode {
  return {
    ordinal: ++seq,
    startedAt: seq * 1000,
    endedAt: null,
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

const QUESTION = '订单出现了两条重复记录';
const CASE_CARD = { title: '订单提交产生了两条重复记录', question: QUESTION };

/**
 * 一次"什么都有"的到达序列：主干、同一条支线的两步、显式分叉、跨会话、推翻。
 *
 * **`a2` 与 `a1` 同泳道但父都指向 `s2`**——这正是记账那一侧的真实形状（支线的每一步都把
 * `parent_step_id` 指回起它那次调用所在的那一步）。按父画列的话它们会各占一列。
 */
const STEPS: StepNode[] = [
  step({ id: 's1', verdict: '第一步的结论' }),
  step({ id: 's2', status: 'confirmed', verdict: '网关重试了一次，两条订单出自同一次点击，retry_of 指向同一个 req_id' }),
  step({ id: 'a1', lane: 'tool_use_aaa', parentStepId: 's2', direction: null }),
  step({ id: 's3', status: 'superseded', supersededBy: 'f1' }),
  step({ id: 'a2', lane: 'tool_use_aaa', parentStepId: 's2', direction: null }),
  step({ id: 'f1', parentStepId: 's3', verdict: '显式分叉的结论' }),
  step({ id: 's4', sessionId: 'se2', sessionIndex: 2, ordinal: 1 }),
];

const CHAT: ChatLine[] = [
  // 开场白由 main 标出来（每次会话最早那条 user 行），舞台不织它
  { id: 'c0', opening: true, role: 'user', at: 500, text: `${QUESTION}\n基准日期：2026-08-15。` },
  { id: 'c1', role: 'assistant', at: 1500, text: '先看这两条是不是同一个请求写进去的。' },
  // **正文以问题开头的一句真话**：一度按前缀过滤，它会连人带话一起从舞台上消失
  { id: 'c2', role: 'user', at: 3500, text: `${QUESTION}——另外刚发现同一个 cart_key 昨天也重过一次。` },
];

const build = (steps: StepNode[], chat: ChatLine[], tail = false) => {
  const track = trackLayout(steps);
  const layout = stageLayout(weaveChat(track.rows, chat), track.lanes, CASE_CARD, tail);
  return { track, layout };
};

const { track: TRACK, layout: FULL } = build(STEPS, CHAT);

// ── ① 追加不动已落笔的任何一张 ───────────────────────────────────────────────
{
  const times = [...STEPS.map((s) => s.startedAt), ...CHAT.map((c) => c.at)].sort((a, b) => a - b);
  let stable = true;
  let drift = '';
  for (const t of times) {
    const { layout } = build(
      STEPS.filter((s) => s.startedAt <= t),
      CHAT.filter((c) => c.at <= t),
    );
    for (const b of layout.boxes) {
      const full = FULL.byId.get(b.id);
      if (!full) {
        stable = false;
        drift ||= `${b.id} 在前缀里有、在全量里没了`;
        continue;
      }
      if (full.x !== b.x || full.y !== b.y || full.h !== b.h) {
        stable = false;
        drift ||= `到 t=${t} 时 ${b.id} 在 (${b.x},${b.y},h${b.h})，全量里是 (${full.x},${full.y},h${full.h})`;
      }
    }
  }
  check(
    '追加一步 / 一句话，已经落笔的卡片一张都不动',
    stable,
    drift || '每个前缀里每张卡的 x/y/h 都与全量一致',
  );
}

// ── ② 列是语义轴 ────────────────────────────────────────────────────────────
{
  const col = (id: string) => TRACK.rows.find((r) => r.step.id === id)!.col;
  check(
    '同一条子 agent 支线的第二步接着往下长，不另开一列',
    col('a1') === col('a2') && col('a1') !== 0,
    `a1 在第 ${col('a1')} 列、a2 在第 ${col('a2')} 列 —— 按 parent_step_id 分列的话它们会各占一列，` +
      '而"这一列是谁在查"从此说不出口',
  );
  check(
    '显式分叉自开一列，主干照旧留在 0 列',
    col('f1') !== 0 && col('f1') !== col('a1') && col('s1') === 0 && col('s4') === 0,
    `f1 在第 ${col('f1')} 列，主干 s1/s4 在第 ${col('s1')}/${col('s4')} 列`,
  );
  check(
    '列号只往右发，不回收',
    TRACK.lanes.every((l, i) => l.col === i) && new Set(TRACK.lanes.map((l) => l.col)).size === TRACK.lanes.length,
    `列号 ${TRACK.lanes.map((l) => `${l.id}=${l.col}`).join(' ')} —— ` +
      '回收的话，同一列上下两张卡会分属两条互不相干的推理',
  );
  check(
    '主干恒占 0 列（哪怕第一步就来自支线）',
    trackLayout([step({ id: 'lonelane', lane: 'tool_use_zzz' })]).lanes.find((l) => l.id === TRUNK)?.col === 0,
    '不预留的话，支线会抢到 0 列，而信息卡与随后的主干都住在那一列',
  );
  check(
    '每条线只有一个列头，主干那个压在信息卡上',
    FULL.laneHeads.length === TRACK.lanes.length &&
      new Set(FULL.laneHeads.map((l) => l.id)).size === FULL.laneHeads.length &&
      FULL.laneHeads.find((l) => l.id === TRUNK)!.y < FULL.byId.get(CASE_BOX_ID)!.y,
    `列头 ${FULL.laneHeads.map((l) => l.id).join(',')} —— 主干的列头落在第一步上方的话，信息卡看着不属于任何一列`,
  );
}

// ── ③ 卡片不重叠 ────────────────────────────────────────────────────────────
{
  const hit: string[] = [];
  for (let i = 0; i < FULL.boxes.length; i++) {
    for (let j = i + 1; j < FULL.boxes.length; j++) {
      const a = FULL.boxes[i]!;
      const b = FULL.boxes[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hit.push(`${a.id}/${b.id}`);
    }
  }
  check('两张卡不叠在一起', hit.length === 0, hit.join(' ') || `${FULL.boxes.length} 张卡两两不相交`);
}

// ── ④ 高度与裁行数对得上 ────────────────────────────────────────────────────
{
  /**
   * 结论那一格是**定额**，不按内容算——`verdict` 是 `close_step` 后补的，
   * 按它算高度的话每一次收口都把下面整条推走一截（见下面第⑧组）。
   * 代价写在这儿：还没出结论的卡下面空着两行，读起来正是"结论还没出来"。
   */
  const slots = FULL.boxes.filter((b) => b.kind === 'step').map((b) => (b.kind === 'step' ? b.vdLines : -1));
  check(
    '每张卡给结论留的都是同样两行，与它这会儿有没有结论无关',
    slots.every((v) => v === VERDICT_LINES),
    `实得 ${slots.join(',')} —— 按内容算的话，一步收口就是一次整列位移`,
  );
  check(
    '标题同理是定额一行（改名不改高度）',
    FULL.byId.get(CASE_BOX_ID)!.kind === 'case' &&
      (FULL.byId.get(CASE_BOX_ID) as { titleLines: number }).titleLines === TITLE_LINES,
    'agent 读完问题几秒后必然改一次标题——按内容算的话那一下把整条主干推走一行',
  );
  check(
    '假设句照旧按内容估：它只在 open_step 写一次，不会再变',
    (() => {
      const a1 = FULL.byId.get('a1')!;
      const s1 = FULL.byId.get('s1')!;
      return a1.kind === 'step' && s1.kind === 'step' && a1.dirLines === 2 && s1.dirLines === 1 && a1.h > s1.h;
    })(),
    '不可变的字段才敢按内容算——省下的那一行在一屏几十张卡上是实打实的',
  );
  /**
   * 🔴 **这一条才是那对"改一处必须改另一处"的守卫**：高度按行数算、渲染按同一个行数裁。
   * 两处对不上时一个字的报错都没有，只是安静地把末行裁掉半截。
   */
  const bad = FULL.boxes.filter((b) => heightOf(b) !== b.h).map((b) => `${b.id}(${b.h}≠${heightOf(b)})`);
  check('每张卡的高度与它自己报的裁行数严格对得上', bad.length === 0, bad.join(' ') || `${FULL.boxes.length} 张卡都对得上`);

  // 两句兜底说的是两件事（ui.md §3.2）：估行数与渲染都走 `directionText`，所以只要这两句
  // 不同，估出来的行数就一定是渲染那句的行数
  const laneStep = STEPS.find((s) => s.id === 'a1')!;
  check(
    '支线与主干的兜底文案各说各的，且都由 directionText 一处给出',
    directionText(laneStep) !== directionText({ direction: null, lane: null }) &&
      directionText(laneStep).includes('主线') &&
      estLines(directionText(laneStep), 22, 2) >= 1,
    `支线那句「${directionText(laneStep)}」—— 照抄主干那句的话，读的人会以为主线漏了一次 open_step`,
  );
  check(
    '中英混排不按纯中文估（估短了就会裁掉末行）',
    estLines('retry_of=a91f_b7c2 upstream timeout 2140ms on POST /v1/order', 22, 3) >= 2,
    `实得 ${estLines('retry_of=a91f_b7c2 upstream timeout 2140ms on POST /v1/order', 22, 3)} 行`,
  );
}

// ── ⑤ 旁白不推进主干 ────────────────────────────────────────────────────────
{
  const { layout: noTalk } = build(STEPS, [CHAT[0]!]);
  const moved = FULL.boxes
    .filter((b) => b.kind !== 'say')
    .filter((b) => noTalk.byId.get(b.id)?.y !== b.y)
    .map((b) => b.id);
  check(
    '插进旁白不把任何一步下移',
    moved.length === 0,
    moved.join(',') || 'agent 每说一句就把后面的步整体下推的话，正读着的那一步会跑',
  );
  const say = FULL.boxes.find((b) => b.kind === 'say')!;
  check(
    '旁白落在主干左侧，不占主干的行宽',
    say.x + say.w < FULL.byId.get(CASE_BOX_ID)!.x,
    `旁白右沿 ${say.x + say.w}，主干左沿 ${FULL.byId.get(CASE_BOX_ID)!.x}`,
  );
}

// ── ⑥ 连线：一条线内部实线，只有列头才画"开出去" ─────────────────────────────
{
  const edge = (to: string) => FULL.edges.find((e) => e.toId === to);
  check(
    '支线第二步接的是支线第一步，不是主干那一步',
    edge('a2')?.kind === 'flow' && edge('a2')?.fromId === 'a1',
    `实得 ${JSON.stringify(edge('a2'))} —— 按父画的话会有两条虚线从主干扎向同一条支线，而它们说的是同一件事`,
  );
  check(
    '列头画一条"开出去"的虚线，从它父亲那儿起',
    edge('a1')?.kind === 'open' && edge('a1')?.fromId === 's2' && edge('f1')?.fromId === 's3',
    `a1 ← ${JSON.stringify(edge('a1'))}，f1 ← ${JSON.stringify(edge('f1'))}`,
  );
  check(
    '主干第一步接的是信息卡',
    edge('s1')?.kind === 'flow' && edge('s1')?.fromId === CASE_BOX_ID,
    `实得 ${JSON.stringify(edge('s1'))} —— 不接的话信息卡看着是块飘在旁边的东西`,
  );
  const refutes = refuteEdges(FULL, TRACK.edges);
  check(
    '推翻回指线从推翻者指向被推翻者，两头都在舞台上才画',
    refutes.length === 1 && refutes[0]!.fromId === 'f1' && refutes[0]!.toId === 's3',
    JSON.stringify(refutes),
  );
  const orphanTrack = trackLayout([step({ id: 'lonely', supersededBy: 'elsewhere', status: 'superseded' })]);
  const orphan = stageLayout(weaveChat(orphanTrack.rows, []), orphanTrack.lanes, CASE_CARD);
  check(
    '推翻者不在舞台上时不画线（划线由卡片自己兜着）',
    refuteEdges(orphan, orphanTrack.edges).length === 0,
    '两头都在才画得出来；画不出来那一头由「← 被 X 推翻」用文字说',
  );
}

// ── ⑦ 会话断点条自己占高度 ──────────────────────────────────────────────────
{
  const s4 = FULL.byId.get('s4')!;
  const prevBottom = Math.max(
    ...FULL.boxes.filter((b) => b.kind === 'step' && b.x === s4.x && b.y < s4.y).map((b) => b.y + b.h),
  );
  check(
    '断点条的高度加在那一行头上，不盖住上一张卡',
    s4.y - prevBottom >= STAGE.vGap + STAGE.sessionGap,
    `间距 ${s4.y - prevBottom} —— 不留的话「第 2 次会话」那条压在上一张卡的下沿上`,
  );
}

// ── ⑧ 可变字段后补，坐标一律不动 ────────────────────────────────────────────
/**
 * 🔴 **这一组补的是上面①那条盖不住的空洞**：那条走的是"前缀 → 全量"，而每个前缀里的步
 * 都已经带着最终的 verdict。真实的时间线不是这样——一步先以 `open` 无结论落笔，
 * 几十秒后 `close_step` 才把结论补上；标题更是 agent 读完问题几秒后**必然**改一次。
 * 高度但凡跟着这两样变，它下面每一张已经落笔的卡就整体下移，而且一声不吭。
 */
{
  const before = STEPS.map((x) => (x.id === 's2' ? { ...x, status: 'open' as const, verdict: null } : x));
  const a = build(before, CHAT).layout;
  const b = FULL; // s2 已经带上一条两行的结论
  const moved = a.boxes.filter((x) => {
    const now = b.byId.get(x.id);
    return !now || now.x !== x.x || now.y !== x.y || now.h !== x.h;
  });
  check(
    '一步从"没有结论"补成"有结论"，它自己与它下面的卡一张都不动',
    moved.length === 0,
    moved.map((m) => m.id).join(',') ||
      '结论那一格是恒占两行的定额——按内容算高度的话，close_step 一落地整条主干就往下掉一截',
  );

  const renamed = { title: '订单提交在网关重试之后产生了两条完全重复的记录，幂等键没有拦住', question: QUESTION };
  const r = stageLayout(weaveChat(TRACK.rows, CHAT), TRACK.lanes, renamed);
  const shifted = r.boxes.filter((x) => {
    const now = FULL.byId.get(x.id);
    return !now || now.y !== x.y || now.h !== x.h;
  });
  check(
    '标题改成长得能换行的一句之后，主干上的卡一张都不动',
    shifted.length === 0,
    shifted.map((m) => m.id).join(',') ||
      '标题恒占一行——按内容算的话，agent 几秒后改一次标题就把整条主干推走一行',
  );
}

// ── ⑨ 对话：开场白按标记认，id 不随截断漂 ──────────────────────────────────
{
  const opening = CHAT.find((c) => c.opening)!;
  const echo = CHAT.find((c) => c.id === 'c2')!;
  const woven = weaveChat(TRACK.rows, CHAT);
  const ids = woven.filter((i) => i.kind === 'chat').map((i) => i.id);
  check(
    '开场白不织进舞台（信息卡上已经逐字有了）',
    !ids.includes(opening.id),
    `实得 ${ids.join(',')}`,
  );
  check(
    '正文以问题开头的那句真补充照旧留在舞台上',
    ids.includes(echo.id),
    `实得 ${ids.join(',')} —— 按"以问题正文开头"过滤的话，` +
      '问题一短，人后来引用原问题再补充的那句就跟着一起消失了',
  );
  // 快照只带最近一段（`CHAT_TAIL`），队首被截掉时余下那几句的 id 不许跟着变
  const cut = weaveChat(TRACK.rows, CHAT.slice(1));
  const cutIds = cut.filter((i) => i.kind === 'chat').map((i) => i.id);
  check(
    '截掉队首之后，留下那几句的 id 一个都没变',
    cutIds.every((id) => ids.includes(id)) && cutIds.join(',') === ids.join(','),
    `截断前 ${ids.join(',')}，截断后 ${cutIds.join(',')} —— ` +
      '按数组下标编 id 的话，这里整体错位一格，React 把它们当成一批新节点重挂一遍',
  );
}

// ── ⑩ 空态：一步都没有时也算得出东西来 ──────────────────────────────────────
{
  const t = trackLayout([]);
  const empty = stageLayout(weaveChat(t.rows, []), t.lanes, CASE_CARD);
  check(
    '一步都没跑时舞台上只有信息卡，边界仍然算得出来',
    empty.boxes.length === 1 && empty.bounds.w > 0 && empty.bounds.h > 0 && empty.lastId === CASE_BOX_ID,
    `boxes=${empty.boxes.length} bounds=${empty.bounds.w}x${empty.bounds.h} —— 算不出边界的话"适应"会把画布缩到 NaN`,
  );
}

// ── ⑪ 收束卡：主干的尾（ui.md §3.3）────────────────────────────────────────
/**
 * 🔴 这一组守的是**那条例外**：尾卡的坐标每帧重算，而 D23 说坐标只算一次。
 * 例外成立的全部依据是"位移只发生在它自己身上"——所以下面两句必须同时为真：
 * 尾卡在全图最低（它下面没有东西可推），加一步之后其余每张卡逐字不动。
 *
 * 只验第一句是不够的：一张最低的卡照样可以把旁白那一栏顶上去（旁白与它同列邻位）。
 * 只验第二句更不够——那正是把尾卡钉死在某个 y 上也能过的检查。
 */
{
  const bottom = (b: { y: number; h: number }) => b.y + b.h;
  const { layout: TAILED } = build(STEPS, CHAT, true);
  const tailBox = TAILED.byId.get(TAIL_BOX_ID);

  check(
    '尾卡的下沿是全图最低的一条，旁白也压在它上面',
    !!tailBox && TAILED.boxes.every((b) => b.id === TAIL_BOX_ID || bottom(b) <= bottom(tailBox)),
    tailBox
      ? `尾卡下沿 ${bottom(tailBox)}，其余最低 ${Math.max(
          ...TAILED.boxes.filter((b) => b.id !== TAIL_BOX_ID).map(bottom),
        )} —— 低不过旁白的话，"终点不许是一句话"就等于没做`
      : '尾卡压根没排出来',
  );

  /**
   * **收尾时人和 agent 还在你一句我一句**：这是尾卡最容易失效的一处——旁白有自己一条游标，
   * 只按主干算 y 的话，这几句会重新落到尾卡下面去，而画布最低点又变回一句话。
   *
   * ⚠️ 这里**必须堆够几句**：只补两句的话，旁白那一栏还没长过尾卡自己的高度，
   * 于是"只按主干算"照样能过——那是一条恒真的检查，退回旧写法都发现不了。
   */
  const late: ChatLine[] = [
    ...CHAT,
    { id: 'c8', role: 'assistant', at: 9000, text: '影响面和遗留问题都收了，定稿闸是通的。形态我按分布型声明了——这次故障的主体就是那一刀切出来的分组。' },
    { id: 'c9', role: 'user', at: 9500, text: '先别定稿，等运维把 edge-sh-03 摘了确认成功率回来再说。' },
    { id: 'c10', role: 'assistant', at: 10_000, text: '好。摘完之后我再看一次同机房另外两台的成功率，确认那条链路是不是唯一的差异项。' },
    { id: 'c11', role: 'user', at: 10_500, text: '摘了，成功率回到 99.4%。' },
    { id: 'c12', role: 'assistant', at: 11_000, text: '那就对上了。我把这一条补进影响面那一步的证据里，剩下的等你定稿。' },
  ];
  const { layout: LATE } = build(STEPS, late, true);
  const lateTail = LATE.byId.get(TAIL_BOX_ID)!;
  check(
    '收尾之后还在一来一回地说，最低的仍旧是尾卡而不是那几句',
    LATE.boxes.every((b) => b.id === TAIL_BOX_ID || bottom(b) <= bottom(lateTail)),
    `尾卡下沿 ${bottom(lateTail)}，旁白最低 ${Math.max(
      ...LATE.boxes.filter((b) => b.kind === 'say').map(bottom),
    )} —— 只按主干游标算 y 的话，这一条就是失败的`,
  );

  check(
    '挂上尾卡不动任何一张已经落笔的卡',
    FULL.boxes.every((b) => {
      const now = TAILED.byId.get(b.id);
      return !!now && now.x === b.x && now.y === b.y && now.h === b.h;
    }),
    '尾卡是追加在最下面的一张，它出生不该让别人让位',
  );

  /**
   * 例外的正身：主干再长一步，**尾卡跟着下去，其余一张都不许动**。
   * 反过来（尾卡不动）意味着新的一步会盖到它身上，那才是真的重叠。
   */
  {
    const more = [...STEPS, step({ id: 's5' })];
    const { layout: GROWN } = build(more, CHAT, true);
    const moved = TAILED.boxes
      .filter((b) => b.id !== TAIL_BOX_ID)
      .filter((b) => {
        const now = GROWN.byId.get(b.id);
        return !now || now.x !== b.x || now.y !== b.y || now.h !== b.h;
      });
    const grownTail = GROWN.byId.get(TAIL_BOX_ID)!;
    check(
      '主干再长一步：尾卡跟着下去，别的卡一张都不动',
      moved.length === 0 && grownTail.y > tailBox!.y,
      moved.length
        ? `这几张跟着挪了：${moved.map((m) => m.id).join(',')} —— 那就不是"位移只发生在它自己身上"了`
        : `尾卡从 y=${tailBox!.y} 落到 y=${grownTail.y}，其余 ${TAILED.boxes.length - 1} 张逐字未动`,
    );
  }

  check(
    '尾卡的结论槽是定额，高度与它自己报的行数严格对得上',
    tailBox!.kind === 'tail' &&
      tailBox!.vdLines === TAIL_VERDICT_LINES &&
      heightOf(tailBox!) === tailBox!.h,
    `vdLines=${tailBox!.kind === 'tail' ? tailBox!.vdLines : -1} h=${tailBox!.h}/${heightOf(tailBox!)} —— ` +
      '根因会换人、归档时整条不印，按内容算高度的话它每变一次就把旁白那一栏往上挤',
  );

  check(
    '主干最后一步接到尾卡上',
    TAILED.edges.some((e) => e.toId === TAIL_BOX_ID && e.kind === 'flow' && e.fromId === 's4'),
    `实得 ${JSON.stringify(TAILED.edges.filter((e) => e.toId === TAIL_BOX_ID))} —— ` +
      '不接的话它看着是块飘在最下面的东西，而它恰恰是这条线的收束',
  );

  check(
    '「跟随最新」认的仍旧是最后一步，不是尾卡',
    TAILED.lastId === 's4',
    `实得 ${TAILED.lastId} —— 认尾卡的话，每加一步都把人拽到画布最下面那张不动的卡上`,
  );

  check(
    '尾卡算进边界里（"适应"不会把它切掉）',
    TAILED.bounds.y2 >= bottom(tailBox!),
    `bounds.y2=${TAILED.bounds.y2}，尾卡下沿 ${bottom(tailBox!)}`,
  );

  const { layout: noTail } = build(STEPS, CHAT, false);
  check(
    '还没到该有终点的时候，舞台上压根没有这张卡',
    !noTail.byId.has(TAIL_BOX_ID),
    '出没出生由 tailSummary() 判（认的是开过 impact/leftover 没有），几何这侧只收一个开关',
  );
}

console.log('\n===== Spike Stage 结果 =====');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
