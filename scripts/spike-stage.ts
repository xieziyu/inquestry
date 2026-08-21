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
 *   5. **旁白与它所属的那一步对不上。** 旁白缩进排在所属主干卡下面，归属全靠"就在它下面"——
 *      挂错一张卡（比如认领到支线上）时画面看着一样正常，读的人却把第 2 步说的话当成第 5 步说的
 *   6. **组头行随内容变高、或没有旁白的那一步也留出组的位置。** 前者是 D23 那一类位移，
 *      后者让主干凭空多出一截空白
 *
 * 纯函数，不碰库、不起会话。跑：npm run spike:stage
 */

import {
  CASE_BOX_ID,
  GROUP_BOX_PREFIX,
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
import { PREVIEW_STEPS } from '../src/renderer/preview/fixtures.js';
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
  // 🔴 **同一步名下必须不止一句**：一组只有一句的话，"组头行随句数变位置 / 变高"这种改法
  // 在逐帧那条检查下一次都触发不到——它要的正是"这一组又长了一句"的那一帧
  { id: 'c3', role: 'assistant', at: 3600, text: '那再往前翻一天的重试记录，看是不是同一条链路。' },
];

const build = (steps: StepNode[], chat: ChatLine[], tail = false, expanded?: ReadonlySet<string>) => {
  const track = trackLayout(steps);
  const layout = stageLayout(weaveChat(track.rows, chat), track.lanes, CASE_CARD, tail, expanded);
  return { track, layout };
};

/** 默认全折叠，所以"每一组都展开着"是人一下一下点出来的那个极端态，得单独排一份。 */
const ALL_OPEN: ReadonlySet<string> = new Set([CASE_BOX_ID, ...STEPS.map((s) => s.id)]);

const { track: TRACK, layout: FULL } = build(STEPS, CHAT);
const { layout: OPENED } = build(STEPS, CHAT, false, ALL_OPEN);

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
/** 展开态也要验：组内的间距（`groupGap` / `sayV`）算窄一档的表现就是两句叠在一起。 */
{
  const overlaps = (boxes: typeof FULL.boxes) => {
    const hit: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hit.push(`${a.id}/${b.id}`);
      }
    }
    return hit;
  };
  const hit = [...overlaps(FULL.boxes), ...overlaps(OPENED.boxes)];
  check(
    '两张卡不叠在一起（折叠态与全展开态各排一遍）',
    hit.length === 0,
    hit.join(' ') || `折叠 ${FULL.boxes.length} 个盒子、全展开 ${OPENED.boxes.length} 个，两两不相交`,
  );
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
  const bad = [...FULL.boxes, ...OPENED.boxes]
    .filter((b) => heightOf(b) !== b.h)
    .map((b) => `${b.id}(${b.h}≠${heightOf(b)})`);
  check(
    '每个盒子的高度与它自己报的裁行数严格对得上（旁白与组头行一起验）',
    bad.length === 0,
    bad.join(' ') || `折叠 ${FULL.boxes.length} 个、全展开 ${OPENED.boxes.length} 个都对得上`,
  );

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

// ── ⑤ 旁白挂在所属的那一步下面 ──────────────────────────────────────────────
/**
 * 归属是**算出来的**（`weaveChat` 按"说出口时最后一张主干卡"定），库里没有这个字段。
 * 算错时画面照样排得整整齐齐，只是第 2 步说的话排到了第 5 步旁边——所以这几条钉的是位置本身。
 */
{
  // 组头行与每一句都缩进在主干列内。`colX(0)` 就是 padX（主干恒占 0 列）
  const asideX = STAGE.padX + STAGE.sayIndent;
  const stray = OPENED.boxes
    .filter((b) => b.kind === 'say' || b.kind === 'group')
    .filter((b) => b.x !== asideX || b.w !== STAGE.cardW - STAGE.sayIndent)
    .map((b) => `${b.id}@${b.x}w${b.w}`);
  check(
    '旁白与组头行一律缩进在主干列内，一个都不落在别的列上',
    stray.length === 0,
    stray.join(' ') ||
      `${OPENED.boxes.filter((b) => b.kind === 'say' || b.kind === 'group').length} 个盒子都在 x=${asideX}、宽 ${
        STAGE.cardW - STAGE.sayIndent
      } —— 认领到支线上的话它会落到 1 列去`,
  );

  /**
   * 🔴 **支线卡不认领旁白**：`c2` 说在支线第一步 `a1` 落笔之后，
   * 按"最后一张卡"算归属的话它会挂到 `a1` 上——而旁白全部来自主线。
   */
  const c2 = OPENED.boxes.find((b) => b.id === 'c2');
  check(
    '说在支线卡之后的那一句仍旧归主干上那一步',
    c2?.kind === 'say' && c2.ownerId === 's2',
    `c2 归 ${c2?.kind === 'say' ? c2.ownerId : '(没排出来)'} —— 归 a1 的话，那一句就挂到了另一条 agent 的推理下面`,
  );

  /**
   * **D23 的正身：按真实到达序逐条追加，除尾卡外每个盒子的 x/y/h 逐字不变。**
   *
   * 一度写成"有旁白 vs 完全没旁白"两份快照对比——那条在这一版下必然失败，而且**失败得不对**：
   * 一步的第一句到达时组头行凭空出现，本来就该多占一行。D23 防的是增量到达，所以按帧比。
   * 折叠态下连尾卡都不该动（组头行是定额高，计数从 3 涨到 4 不改变任何几何）；
   * 全展开态下也只有尾卡跟着往下走。
   */
  for (const [label, expanded] of [
    ['折叠态', new Set<string>()],
    ['全展开态', ALL_OPEN],
  ] as const) {
    const arrivals = [
      ...STEPS.map((s) => ({ at: s.startedAt, step: s as StepNode | null, chat: null as ChatLine | null })),
      ...CHAT.filter((c) => !c.opening).map((c) => ({ at: c.at, step: null, chat: c as ChatLine | null })),
    ].sort((a, b) => a.at - b.at);
    const steps: StepNode[] = [];
    const chat: ChatLine[] = [CHAT[0]!];
    let prev = build(steps, chat, true, expanded).layout;
    let drift = '';
    let onlyTail = true;
    for (const a of arrivals) {
      if (a.step) steps.push(a.step);
      if (a.chat) chat.push(a.chat);
      const cur = build(steps, chat, true, expanded).layout;
      for (const b of prev.boxes) {
        if (b.id === TAIL_BOX_ID) continue;
        const now = cur.byId.get(b.id);
        if (!now) {
          onlyTail = false;
          drift ||= `${label}：${b.id} 到了下一帧就没了`;
        } else if (now.x !== b.x || now.y !== b.y || now.h !== b.h) {
          onlyTail = false;
          drift ||= `${label}：来了 ${a.step?.id ?? a.chat?.id} 之后 ${b.id} 从 (${b.x},${b.y},h${b.h}) 挪到 (${now.x},${now.y},h${now.h})`;
        }
      }
      prev = cur;
    }
    check(
      `按到达序逐条追加，除尾卡外一个盒子都不动（${label}）`,
      onlyTail,
      drift || '每一帧与上一帧逐字一致 —— 后来到达的旁白只推得动尾卡，而尾卡下面没有东西可推',
    );
  }

  /**
   * 组头行是**定额高**：计数几位数、预览句多长都不许改变它，也不许改变它下面那张卡的位置。
   * （不写这条的话，"组头行照内容排"这种改法在别的检查下全都能过。）
   */
  const talky = (n: number, long: boolean): ChatLine[] => [
    { id: 'x0', opening: true, role: 'user', at: 500, text: QUESTION },
    ...Array.from({ length: n }, (_, i) => ({
      id: `x${i + 1}`,
      role: 'assistant' as const,
      at: 1100 + i,
      text: i === 0 && long ? '幂等键这条路要一次说清楚：'.repeat(12) : `第 ${i + 1} 句`,
    })),
  ];
  const few = build(STEPS, talky(3, false)).layout;
  const many = build(STEPS, talky(12, true)).layout;
  // 查不到就是归属算歪了（那一组挂到别人名下去了）——报 FAIL，不许在这儿抛异常：
  // 检查脚本一崩，整份结果一条都印不出来，看着像"没跑"而不是"错了"
  const g1 = few.byId.get(`${GROUP_BOX_PREFIX}s1`);
  const g2 = many.byId.get(`${GROUP_BOX_PREFIX}s1`);
  check(
    '组头行恒占一行：3 轮与 12 轮、短预览与长预览排出来逐字一样高',
    !!g1 &&
      !!g2 &&
      g1.h === STAGE.groupH &&
      g2.h === STAGE.groupH &&
      heightOf(g1) === STAGE.groupH &&
      heightOf(g2) === STAGE.groupH &&
      g1.y === g2.y &&
      few.byId.get('s2')!.y === many.byId.get('s2')!.y,
    `3 轮 h=${g1?.h}@y${g1?.y}、12 轮 h=${g2?.h}@y${g2?.y}，其下那张卡 y=${few.byId.get('s2')!.y}/${
      many.byId.get('s2')!.y
    } —— 一随内容变高，它下面每一张已经落笔的卡就跟着位移`,
  );

  /**
   * 人点开一组：**组头行自己与它上方的一切逐字不动**，位移只发生在他点的那一行之下。
   * 这一条钉的是"视线焦点不跳"——组头行要是跟着长高或上移，点开的那一下画面就会甩一截。
   */
  {
    const base = build(STEPS, CHAT, true).layout;
    const open = build(STEPS, CHAT, true, new Set(['s2'])).layout;
    const g = base.byId.get(`${GROUP_BOX_PREFIX}s2`);
    const gBottom = g ? g.y + g.h : 0;
    const trunkX = [STAGE.padX, STAGE.padX + STAGE.sayIndent];
    const deltas = new Set<number>();
    let stillAbove = true;
    let detail = '';
    for (const b of base.boxes) {
      const now = open.byId.get(b.id);
      if (!now) continue;
      const d = now.y - b.y;
      if (now.x !== b.x || now.h !== b.h || d < 0) {
        stillAbove = false;
        detail ||= `${b.id} 变了形或往上跑了（Δy=${d}）`;
      } else if (!g || b.id === g.id || b.y + b.h <= g.y) {
        // 组头行自己与它上方的一切：一个像素都不许动，人点的那一行原地不动
        if (d !== 0) {
          stillAbove = false;
          detail ||= `${b.id} 在组头行上方却跟着挪了 ${d}px —— 展开只该往组头行下面长`;
        }
      } else if (b.y >= gBottom && trunkX.includes(b.x)) deltas.add(d);
      // 支线/分叉那几列不在这条里：分叉卡是贴着它父亲排的，父亲让位它自然跟着走
    }
    const tailD = open.byId.get(TAIL_BOX_ID)!.y - base.byId.get(TAIL_BOX_ID)!.y;
    check(
      '点开一组：组头行自己与上方一切不动，下方主干整体让位同样多',
      !!g && stillAbove && deltas.size === 1 && [...deltas][0]! > 0 && tailD === [...deltas][0],
      (!g ? 's2 名下压根没排出组头行 —— 归属算歪了' : detail) ||
        `组头行 y=${g?.y} 未动，下方让位 ${[...deltas].join('/')}px，尾卡跟着走了 ${tailD}px`,
    );
  }

  /**
   * **没说过话的那一步一个像素都不多占。** 组头行恒占位这种实现方式不会被别的检查发现，
   * 表现是主干上凭空多出一截空白。`s2` 说过一句（`c2`）、`s3` 一句都没有，两段间距因此不同。
   */
  const gapTo = (from: string, to: string) => FULL.byId.get(to)!.y - (FULL.byId.get(from)!.y + FULL.byId.get(from)!.h);
  check(
    '说过话的那一步下面多一行组头，没说过的一个像素都不多占',
    gapTo('s2', 's3') === STAGE.groupTop + STAGE.groupH + STAGE.vGap &&
      // s4 是第二次会话的头一步，断点条自己那一段照旧加在它头上
      gapTo('s3', 's4') === STAGE.vGap + STAGE.sessionGap,
    `s2→s3 ${gapTo('s2', 's3')}（该是 ${STAGE.groupTop + STAGE.groupH + STAGE.vGap}）、` +
      `s3→s4 ${gapTo('s3', 's4')}（该是 ${STAGE.vGap + STAGE.sessionGap}）`,
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
   * **收尾时人和 agent 还在你一句我一句**：这是尾卡最容易失效的一处。
   * 收尾那几句归最后一步，只有"排卡 → 排组 → 推游标"这个顺序才把它们算进主干游标里；
   * 谁把它写回"排卡 → 推游标"，这几句就落到尾卡下面去，而画布最低点又变回一句话。
   *
   * ⚠️ **必须按展开态排**：折叠着的话那一组只有一行组头，比尾卡自己还矮，
   * 于是漏算也照样能过——那是一条恒真的检查。也**必须堆够几句**，理由同上。
   */
  const late: ChatLine[] = [
    ...CHAT,
    { id: 'c8', role: 'assistant', at: 9000, text: '影响面和遗留问题都收了，定稿闸是通的。形态我按分布型声明了——这次故障的主体就是那一刀切出来的分组。' },
    { id: 'c9', role: 'user', at: 9500, text: '先别定稿，等运维把 edge-sh-03 摘了确认成功率回来再说。' },
    { id: 'c10', role: 'assistant', at: 10_000, text: '好。摘完之后我再看一次同机房另外两台的成功率，确认那条链路是不是唯一的差异项。' },
    { id: 'c11', role: 'user', at: 10_500, text: '摘了，成功率回到 99.4%。' },
    { id: 'c12', role: 'assistant', at: 11_000, text: '那就对上了。我把这一条补进影响面那一步的证据里，剩下的等你定稿。' },
  ];
  const { layout: LATE } = build(STEPS, late, true, ALL_OPEN);
  const lateTail = LATE.byId.get(TAIL_BOX_ID)!;
  const lateSays = LATE.boxes.filter((b) => b.kind === 'say');
  check(
    '收尾之后还在一来一回地说，最低的仍旧是尾卡而不是那几句',
    lateSays.length >= 5 && LATE.boxes.every((b) => b.id === TAIL_BOX_ID || bottom(b) <= bottom(lateTail)),
    `尾卡下沿 ${bottom(lateTail)}，${lateSays.length} 句旁白最低 ${Math.max(...lateSays.map(bottom))} —— ` +
      '旁白没算进主干游标的话，这一条就是失败的',
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

// ── ⑫ 主干兜底步不上舞台，它的调用归信息卡 ─────────────────────────────────
/**
 * 🔴 三种错法这一组各钉一条：
 *
 *   1. **兜底步照旧出卡**（滤漏了）——一张永远没有命题、没有结论、没有证据的卡占着
 *      与"一个排查方向"同等规格的位置
 *   2. **把支线兜底也筛了**（只按 kind 筛）——一条跑完的子 agent 支线整列从画布上消失
 *   3. **信息卡那条带子按"有没有调用"决定出不出**——第一次兜底调用落地的那一刻信息卡
 *      长高一截，它下面每一张已经落笔的卡整体下移，而且一声不吭
 */
{
  const strayCalls = [
    {
      id: 'tc_s1',
      callNumber: 1,
      toolName: 'ToolSearch',
      origin: 'agent' as const,
      status: 'done',
      input: '{}',
      gate: null,
      outputPreview: '',
      outputLines: 3,
      startedAt: 400,
      endedAt: 600,
    },
  ];
  // 真实形态：永远 open、没有命题、0 条证据，排在最前（开场摸底）与最后（收尾杂务）
  const stray = (id: string, at: number) =>
    step({ id, kind: 'unclassified', direction: null, status: 'open', startedAt: at, calls: strayCalls });
  const withStray = [stray('sx0', 500), ...STEPS, stray('sx1', 99_000)];
  const { track: strayTrack, layout: strayLayout } = build(withStray, CHAT);

  check(
    '主干兜底步不出卡，它上下的每一张都逐字落在没有它时的位置上',
    !strayLayout.byId.has('sx0') &&
      !strayLayout.byId.has('sx1') &&
      !strayTrack.rows.some((r) => r.step.id.startsWith('sx')) &&
      FULL.boxes.every((b) => {
        const now = strayLayout.byId.get(b.id);
        return !!now && now.x === b.x && now.y === b.y && now.h === b.h;
      }),
    `盒子 ${strayLayout.boxes.length} 个（没有兜底步时 ${FULL.boxes.length} 个）—— ` +
      '它永远没有命题、没有结论、没有证据，占一张卡就是纯噪声',
  );

  check(
    '支线兜底步照旧出卡（同一个 kind，装的是另一件东西）',
    (() => {
      const laneStray = step({ id: 'lx', kind: 'unclassified', direction: null, lane: 'tool_use_aaa' });
      const { layout } = build([...STEPS, laneStray], CHAT);
      return layout.byId.has('lx');
    })(),
    '按 kind 一刀切的话，一条跑完的子 agent 支线整列从画布上消失，而它是有证据的',
  );

  check(
    '带证据的主干兜底步照旧出卡（老数据里有，筛掉证据就没有出口了）',
    (() => {
      const withEv = step({
        id: 'ex',
        kind: 'unclassified',
        direction: null,
        evidence: [{ id: 'e9', claim: 'e9', anchor: null, occurredAtRaw: null, actor: null, callId: 'tc_s1' }],
      });
      return build([...STEPS, withEv], CHAT).layout.byId.has('ex');
    })(),
    '真实链路上主干兜底恒为 0 条证据，但 seed 与任何直接发 step.closed 的路径不经过那条约束',
  );

  check(
    '已关、带结论的兜底步照旧出卡（0 条证据也照旧）',
    (() => {
      const closed = step({
        id: 'cx',
        kind: 'unclassified',
        direction: null,
        status: 'confirmed',
        verdict: '先扫了一遍回调代码，那把幂等锁只留了一条 TODO。',
      });
      return build([...STEPS, closed], CHAT).layout.byId.has('cx');
    })(),
    '判据只写"主干兜底 + 0 条证据"的话，这句人写下的结论连着它那张卡一起没了 —— ' +
      '而库里这种老数据可达（seed 一度就这么造）',
  );

  check(
    '信息卡那条带子恒占一行：有没有兜底调用，卡高与它下面每一张卡的位置逐字一样',
    (() => {
      const a = FULL.byId.get(CASE_BOX_ID)!;
      const b = strayLayout.byId.get(CASE_BOX_ID)!;
      return a.h === b.h && heightOf(a) === a.h && heightOf(b) === b.h;
    })(),
    `信息卡高 ${FULL.byId.get(CASE_BOX_ID)!.h} —— 按"有没有调用"决定出不出这一行的话，` +
      '第一次兜底调用落地的那一刻它长高一截，整条主干跟着下移',
  );

  check(
    '兜底步说话的那几句照旧有归属，不会挂到一张没有的卡下面',
    (() => {
      const orphan = strayLayout.boxes.filter(
        (b) => (b.kind === 'say' || b.kind === 'group') && !strayLayout.byId.has(b.ownerId),
      );
      return orphan.length === 0;
    })(),
    '归属是"说出口时最后那张主干卡"算出来的 —— 滤在调用方而不是 trackLayout 的话，' +
      '这几句会认领到一个不存在的盒子上，那一组于是整个不见',
  );
}

// ── ⑬ 预览夹具的序号不重号 ─────────────────────────────────────────────────
/**
 * 🔴 **同一会话里两个 `#9` 是真数据里不可能有的形态**：`ordinal` 是会话内序号，写入侧
 * 逐一发号。预览那份夹具在共用夹具（`scripts/fixtures/report-case.ts`）后面另接几步，
 * 序号一度是写死的——共用夹具一加步就撞号，而撞号之后卡面、报告与"被 #9 推翻"那类引用
 * 各指一张卡，两个屏上都不报错。这条兜的是"接着数"那个写法，不是某几个具体的数。
 */
{
  const seen = new Map<string, string>();
  const clash: string[] = [];
  for (const s of PREVIEW_STEPS) {
    const key = `${s.sessionId} #${s.ordinal}`;
    const prev = seen.get(key);
    if (prev) clash.push(`${key}：${prev} 与 ${s.id}`);
    else seen.set(key, s.id);
  }
  check(
    '预览夹具同一会话内的序号不重号',
    clash.length === 0,
    clash.length
      ? `撞号 ${clash.join('；')}`
      : `${PREVIEW_STEPS.length} 步，最大 #${Math.max(...PREVIEW_STEPS.map((s) => s.ordinal))}`,
  );
}

console.log('\n===== Spike Stage 结果 =====');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
