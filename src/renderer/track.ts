import type { ChatLine, StepNode } from '../shared/ipc.js';

/**
 * 轨道布局（D23 / ui.md §3）。
 *
 * > **列 = 一条探索线，行 = 到达顺序；一行落笔之后它属于哪一列不再改。**
 *
 * 这条约束不是为了好看：节点每几秒钻出来一个，任何"把图排漂亮"的布局都会让正在读的
 * 那个节点位移。所以这里**只算列，不动顺序**——行序逐字就是传进来的到达顺序。
 *
 * 由此派生出的实现方式：列只从**已经出现过的**步算。这一手同时兜掉了三件事——
 * 父在后面才到（真出现的话，按树排就得把已读节点整段挪走）、父根本不存在、以及自引用，
 * 三者一律落回主干。也因此它天然不会成环，不需要防环。
 *
 * 后两种正常情况下到不了这里（写入侧会先归一，见 `openStep`），留着是因为这个函数
 * 得对任意一份快照都算得出东西来——它同时也是那条写入侧规则的兜底。
 *
 * **列是语义轴，不是缩进量。** 一条子 agent 支线自己就是一列，它能往下长第二步第三步；
 * agent 显式声明的分叉同理各自占一列。所以"这一列是谁在查"说得出口，而缩进说不出。
 * 代价写明：**列号只往右发、不回收**——回收会让同一列上下两张卡分属两条互不相干的推理，
 * 而"顺着一列往下读"正是这个轴唯一的读法。旧稿那条 `MAX_DEPTH`（深链会把卡片挤出画布）
 * 随舞台改成画布一并作废：画布没有"挤出去"这回事，横向由缩放与导览图兜着。
 */

/**
 * 一条探索线。`col` 在这条线**第一次出现**时分配，之后不动。
 *
 * `trunk` 恒为 0 列：信息卡永远是它的头，所以哪怕第一步就来自支线也占不到 0 列。
 */
export type TrackLane = {
  id: string;
  col: number;
  kind: 'trunk' | 'agent' | 'fork';
  /**
   * 这条线对应的 `StepNode.lane`；只有子 agent 支线有。
   * **与 `id` 不是同一个串**（`id` 带 `lane:` 前缀，三种线共用一个命名空间），
   * 而 `snap.liveLanes` 装的是这一个——两边直接比 `id` 的话永远比不中。
   */
  laneKey: string | null;
  /** 列头上那枚标签。 */
  label: string;
  /** 标签后面那句补充（支线的短 id / 分叉接在谁下面）；没有就是 null。 */
  note: string | null;
};

export type TrackRow = {
  step: StepNode;
  /** 这一行长在哪条探索线上（`TrackLane.id`）。 */
  laneId: string;
  /** 0 = 主干。横坐标由布局乘上去。 */
  col: number;
  /** 这一行是它那条探索线的头一步（列头标签挂在它上面）。 */
  laneHead: boolean;
  /** 节点上显示的序号，恒为 `#N`。会话归属看断点条，不靠前缀——理由见下面的 `label`。 */
  label: string;
  /** 承接的那一步；null = 主干，或父不在这条轨道上。跨会话时带会话号。 */
  parentLabel: string | null;
  /** 会话断点：这一行是新一次会话的头一步（第一行不算——它上面没有"上一次会话"）。 */
  sessionBreak: boolean;
  /**
   * 「← 被 X 推翻」里的 X。
   *
   * **推翻者不在这条轨道上时给空串而不是不给**：这一行照样要划掉。
   * 少一条曲线只是少了个指向，少一道划线则是把一个已经作废的结论显示成仍然成立的。
   */
  refutedBy: string | null;
  /** 这一步推翻了谁（曲线的另一头，让人不必顺着线找）。 */
  refutes: string[];
};

/** 推翻回指线。**全屏只有这一种曲线**，它一出现就不用读字也知道发生了什么。 */
export type RefuteEdge = { fromId: string; toId: string };

export type TrackLayout = {
  rows: TrackRow[];
  /** 出现过的探索线，按列号升序。列头标签与导览图都读它。 */
  lanes: TrackLane[];
  /** 两头都在轨道上的才画得出来；画不出来的那一头由 `refutedBy` 用文字兜着。 */
  edges: RefuteEdge[];
};

/** 主干那条线的 id。信息卡也算它的一员，所以它恒占 0 列。 */
export const TRUNK = 'trunk';

export function trackLayout(steps: StepNode[]): TrackLayout {
  const byId = new Map(steps.map((s) => [s.id, s]));

  /**
   * 节点自己的序号**恒为 `#N`，不带会话前缀**。
   *
   * 一度写成"多会话时全部改带 `S1#N`"，而"是不是多会话"要看整份列表——第二次会话一开，
   * 已经渲染出去的每一行都会被回头改写一次。位置没动，但那正是"永不重排"要防的那种回头改。
   * 会话归属由断点条说明；跨会话的引用另见 `refTo`。
   */
  const label = (s: StepNode) => `#${s.ordinal}`;

  /**
   * 交叉引用（承接谁、推翻了谁）指向别的会话时才带会话号。同一次会话内 `#5` 不会有歧义，
   * 而且带不带只取决于两端自己，与列表里此刻有几次会话无关——所以它也不会被回头改写。
   */
  const refTo = (target: StepNode, from: StepNode) =>
    target.sessionIndex === from.sessionIndex
      ? `#${target.ordinal}`
      : `S${target.sessionIndex}#${target.ordinal}`;

  const refutes = new Map<string, string[]>();
  for (const s of steps) {
    const target = s.supersededBy ? byId.get(s.supersededBy) : undefined;
    if (!target) continue;
    const by = refutes.get(s.supersededBy!) ?? [];
    by.push(refTo(s, target));
    refutes.set(s.supersededBy!, by);
  }

  /** 主干先占 0 列：信息卡是它的头，哪怕第一步就来自支线也抢不走这一列。 */
  const lanes: TrackLane[] = [{ id: TRUNK, col: 0, kind: 'trunk', laneKey: null, label: '主干', note: null }];
  const seen = new Set<string>();

  const rows: TrackRow[] = steps.map((step, i) => {
    // 只认已经出现过的父。写在 seen.add 之前，自引用因此查不到自己
    const parent = step.parentStepId && seen.has(step.parentStepId) ? byId.get(step.parentStepId) : undefined;
    seen.add(step.id);

    /**
     * 这一步长在哪条线上：
     * - 有泳道键 → 那条子 agent 支线自己那一列（**同一条支线的第二步接着往下长**，
     *   不另开一列——泳道键正是"同一条 agent 在查"的那个身份）
     * - 认得的父 → agent 显式声明的分叉，**自开一列**
     * - 其余 → 主干
     */
    const laneId = step.lane ? `lane:${step.lane}` : parent ? `fork:${step.id}` : TRUNK;
    let lane = lanes.find((l) => l.id === laneId);
    const laneHead = !lane;
    if (!lane) {
      lane = {
        id: laneId,
        col: lanes.length,
        kind: step.lane ? 'agent' : 'fork',
        laneKey: step.lane,
        label: step.lane ? '支线' : '分叉',
        note: step.lane ? `子 agent ${step.lane.slice(-6)}` : parent ? `接 ${refTo(parent, step)}` : null,
      };
      lanes.push(lane);
    }

    const refuter = step.supersededBy ? byId.get(step.supersededBy) : undefined;
    const prev = steps[i - 1];
    return {
      step,
      laneId,
      col: lane.col,
      laneHead,
      label: label(step),
      parentLabel: parent ? refTo(parent, step) : null,
      // **第一行永远不标断点。** 标的话，第二次会话一开就要在整条轨道顶上插进一个块，
      // 把每一张已读的卡片整体下推——比改写文本更实在的位移
      sessionBreak: !!prev && step.sessionIndex !== prev.sessionIndex,
      refutedBy: step.supersededBy ? (refuter ? refTo(refuter, step) : '') : null,
      refutes: refutes.get(step.id) ?? [],
    };
  });

  const edges = steps
    .filter((s) => s.supersededBy && byId.has(s.supersededBy))
    .map((s) => ({ fromId: s.supersededBy!, toId: s.id }));

  return { rows, lanes, edges };
}

/**
 * 舞台上的一项：一步，或 agent / 人说的一句话。
 *
 * **对话不再压在底部一条带里。** 原先只露最后一句 assistant 文本，理由是"agent 的文字里
 * 已经没有证据搬运，只剩判断"——判断没错，但那条带把判断放在了离它所属的那一步最远的地方：
 * 屏幕最底下、输入框上面，读起来像一句悬空的总结。判断属于轨道，所以它就长在轨道上。
 */
export type StageRow =
  | { kind: 'step'; id: string; row: TrackRow }
  | { kind: 'chat'; id: string; line: ChatLine };

/**
 * 把对话织进轨道。**不改轨道自己的顺序**（D23）：行序仍旧逐字是 `rows` 的顺序，
 * 每句话只是插到"它说出口时已经开出来的最后一步"后面。
 *
 * 两个值都不会再变（`startedAt` 与 `at` 都是落库那一刻定的），所以插好的位置也不会再动——
 * 拿"当前时间"或"当前在跑哪一步"去定位的话，同一句话会随着调查往下走而挪位置。
 *
 * **每次会话开场那条不织进去**：它是 harness 用建单信息拼的（问题正文 + 基准日期 + 工作区），
 * 信息卡上已经逐字有了，织进来就是同一段话在一屏上出现两次。**认的是 main 标好的
 * `opening`**（那侧按 session 判得准）——一度在这儿按"正文以问题开头"猜，问题短的时候，
 * 人后来引用原问题再补充的那句真话会跟着一起消失。
 *
 * **id 用这一行自己的**，不用它在数组里的下标：快照只带最近一段，队首一被截掉，
 * 按下标编的 id 会整体错位，React 当成一批新节点重挂一遍。
 */
export function weaveChat(rows: TrackRow[], chat: ChatLine[]): StageRow[] {
  const said = chat.filter((c) => !c.opening);
  const out: StageRow[] = [];
  let i = 0;
  const drain = (before: number) => {
    while (i < said.length && said[i]!.at < before) {
      const line = said[i]!;
      out.push({ kind: 'chat', id: line.id, line });
      i += 1;
    }
  };
  for (const row of rows) {
    drain(row.step.startedAt);
    out.push({ kind: 'step', id: row.step.id, row });
  }
  drain(Number.POSITIVE_INFINITY);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 舞台几何（ui.md §3）。舞台是一整幅可缩放拖拽的画布，下半个文件回答"每张卡落在哪儿"。
 *
 * > **列 = 一条探索线（`track.ts` 分配），行 = 到达顺序；坐标只在节点第一次出现时算一次。**
 *
 * 这是 D23 在画布上的形式：节点每几秒钻出来一个，正读着的那张卡不许动。所以这里
 * **没有任何一步是"看一眼全局再排"**——每条线各有一个只增不减的游标，新节点落在
 * 游标与"父卡下沿"两者的较大处，然后把游标推下去。追加因此永远不动已经落笔的任何一张。
 *
 * 🔴 **卡片高度必须算得出来，不能量。** 量高度意味着先渲染再定位，而那正是"位置会变"的
 * 入口：卡片一展开、字体一回退，已读的卡就整片位移。所以正文的行数在这里估、
 * 盒子的高度按估出来的行数算，**渲染那侧再用同一个行数去裁**（`Stage.tsx` 把它写成
 * 每个元素自己的 `-webkit-line-clamp`，不是 CSS 里写死的一个数）——
 * 两处对不上的表现是安静地裁掉半行字，而那半行多半正是那一步的假设句。
 * 估行数一律**往多了估**：估多了只是卡片下面空一点，估少了是把内容裁掉。
 *
 * 🔴 **高度只准建立在不会再变的字段上。** 这一条比上一条更容易漏：估得再准，只要那段文本
 * 后来变了，卡片就会长高，它下面每一张已经落笔的卡跟着整体下移——而那正是 D23 禁的事，
 * 且全程没有任何报错。库里可变的恰恰是最想显示的两样：
 *
 * - `verdict` 由 `close_step` 补上（同一步还能被再 close 一次改掉）→ **结论恒占两行的槽**，
 *   这会儿没有结论也照样留着。空着的那块读起来正是"结论还没出来"
 * - `cases.title` 由 `case.renamed` 改（agent 读完问题几秒后**必然**改一次）→ **标题恒占一行**，
 *   全文在详情浮层里
 *
 * `direction`（只在 `step.opened` 写）与 `cases.question`（只在 `case.opened` 写）不会变，
 * 所以它们照旧按内容估。由 `spike:stage` 那两条"补上结论 / 改完标题坐标不动"兜着。
 *
 * ═══ 尾卡是这条规则**唯一的例外**，理由写在这儿 ═══
 *
 * 主干有头有尾：信息卡是头（问题），收束卡是尾（结论）。尾卡按定义永远在最下面，
 * 所以主干一长它就得跟着下移——**它的坐标每帧重算，不是出生时算一次**。
 *
 * 这不违反 D23 的意图。D23 禁的是"已经落笔的节点因为后来的信息而位移"，判据是
 * **位移会不会推走别人**：尾卡在所有盒子的下方，它下移一张卡都不会碰到，
 * 位移只发生在它自己身上。`spike:stage` 那一组把这条写成了两句会失败的断言
 * （尾卡下沿是全图最低 · 加一步之后其余每张卡坐标逐字不变）。
 *
 * 别把这条例外读成"尾卡随便算"：它自己的**高度仍旧是定额**，理由与上面那两条一模一样——
 * 根因会换人、形态会在确认条上被改、闸门记号会从"差两步"变成"通了"，全是可变字段。
 */

export const STAGE = {
  /** 卡片宽度。改它要连着 `CHARS_PER_LINE` 一起改，否则行数估算与实际换行对不上。 */
  cardW: 340,
  sayW: 292,
  /** 列间距。 */
  colGap: 92,
  /** 旁白落在主干左侧，与主干列之间留这么宽。 */
  sayGap: 60,
  vGap: 24,
  /** 左边留出旁白那一栏 + 推翻曲线的空槽。 */
  padX: 392 + 44,
  padY: 52,
  /** 会话断点条自己占的高度（只有断点那一行前面加）。 */
  sessionGap: 26,
  /** 列头标签压在这条线上方。 */
  laneHead: 28,
} as const;

/**
 * 一行装得下几个全角字。**往小了写**：估出来的行数因此偏多，宁可下面空一点。
 * 只有不可变的那几段在这儿——可变的那两段走下面的定额，压根不估。
 */
const CHARS_PER_LINE = { dir: 22, say: 21, question: 22 } as const;

/** 结论那一格的定额：**恒占两行**，与这会儿有没有结论无关（见上面那段红字）。 */
export const VERDICT_LINES = 2;
/** 标题那一格的定额：**恒占一行**，改名不改高度。全文在详情浮层里。 */
export const TITLE_LINES = 1;
/**
 * 尾卡上那句根因（或"为什么没有根因"）的定额：**恒占两行**。
 * 它是全卡最会变的一段——根因换人、被推翻、归档时整条不印，全都不该改变高度。
 */
export const TAIL_VERDICT_LINES = 2;

/** 全角按 1、半角按 0.55 算——中英混排的假设句按纯中文估会短掉近一半。 */
function textWidth(s: string) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! > 0x2e80 ? 1 : 0.55;
  return w;
}

/**
 * 卡面上那句假设。**估行数与渲染必须用同一份文本**——两个兜底句一长一短，
 * 各写一份的结果是支线那张卡按短的估、按长的渲染，末尾那行被裁掉。
 *
 * 两句兜底不能共用一句：主干那句说的是"agent 在声明方向之前就先查了一次"，
 * 支线那句得说清方向由主线收敛时给；照抄主干那句的话，读的人会以为主线漏了一次 `open_step`。
 */
export function directionText(step: { direction: string | null; lane: string | null }) {
  if (step.direction) return step.direction;
  return step.lane
    ? '（支线：子 agent 自己的调用都记在这里，方向由主线在收敛回来时给）'
    : '（未归类：agent 在声明方向之前就先查了一次）';
}

/** 估行数。空文本给 0 行（那一段整个不渲染，也就不占高度）。 */
export function estLines(text: string | null | undefined, perLine: number, max: number) {
  const t = text?.trim();
  if (!t) return 0;
  // 硬换行本来就各占一行，按整段估会把它们并成一行
  const lines = t.split('\n').reduce((n, seg) => n + Math.max(1, Math.ceil(textWidth(seg) / perLine)), 0);
  return Math.min(max, lines);
}

/** 卡片盒子。`x/y/w/h` 是世界坐标，`*Lines` 是渲染那侧要用的裁行数。 */
export type StageBox =
  | { kind: 'case'; id: string; x: number; y: number; w: number; h: number; titleLines: number; questionLines: number }
  | {
      kind: 'step';
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      row: TrackRow;
      dirLines: number;
      vdLines: number;
    }
  | { kind: 'say'; id: string; x: number; y: number; w: number; h: number; line: ChatLine; textLines: number }
  /** 收束卡：主干的尾。内容由 `shared/report.ts` 的 `tailSummary()` 投影，这里只管几何。 */
  | { kind: 'tail'; id: string; x: number; y: number; w: number; h: number; vdLines: number };

/**
 * 连线只有三种形，各自只说一件事：
 * - `flow` 实线 —— 同一条探索线接着往下
 * - `open` 虚线 —— 从父卡开出一条新的探索线
 * - `refute` 曲线 —— 推翻。**全屏只有这一种曲线**，一出现就不用读字（ui.md §3）
 */
export type StageEdge = { id: string; kind: 'flow' | 'open' | 'refute'; fromId: string; toId: string };

export type StageLaneHead = TrackLane & { x: number; y: number };

export type StageLayout = {
  boxes: StageBox[];
  byId: Map<string, StageBox>;
  laneHeads: StageLaneHead[];
  edges: StageEdge[];
  /** 会话断点条：`第 N 次会话`，落在那一行卡片的上方。 */
  marks: { id: string; x: number; y: number; sessionIndex: number }[];
  bounds: { x1: number; y1: number; x2: number; y2: number; w: number; h: number };
  /** 最新落笔的那一张（「跟随最新」与首次打开时停在它身上）。 */
  lastId: string | null;
};

export const CASE_BOX_ID = '__case__';
export const TAIL_BOX_ID = '__tail__';

/**
 * 三个高度公式。每一项都对着 CSS 里那一条：内外边距 + 边框 + 每行的行高。
 *
 * 🔴 **必须比实际渲染出来的高一两个像素**（`box-sizing: border-box`，所以两条边框也要算进来）。
 * 算少了的表现是卡片底下那一行被裁掉半截，而 `overflow: hidden` 让它一声不吭。
 * 改 `styles.css` 里的字号 / 行高 / padding 时这三条要跟着改——由 `spike:stage` 那条
 * "高度与裁行数对得上"兜着，但那条只验两处一致，**验不出这个常数本身对不对**：
 * 真正会失败的检查在 `uishot` 那种真渲染的探针里（正文 scrollHeight 不超过它自己的高度）。
 */
function caseHeight(titleLines: number, questionLines: number) {
  return 32 + titleLines * 21 + 7 + questionLines * 19 + 36;
}
function stepHeight(dirLines: number, vdLines: number) {
  return 58 + dirLines * 20 + 6 + vdLines * 18;
}
function sayHeight(lines: number) {
  return 18 + lines * 19;
}
/**
 * 上边框与内边距 · 标题行 · 结论槽的上边距 + 每行 · 记号行 · 按钮行 · 下内边距与边框。
 *
 * ⚠️ 结论槽这一段渲染那侧要**同时给 `-webkit-line-clamp` 和 `min-height`**：只给 clamp 的话，
 * 根因只有一行时它就真的只占一行，下面的记号行与按钮整体上浮，卡底空出一整行——
 * 而 step 卡不需要 min-height 是因为结论是它最后一段，空在下面正好读作"结论还没出来"。
 */
function tailHeight(vdLines: number) {
  return 12 + 18 + 7 + vdLines * 19 + 35 + 41 + 14;
}

/**
 * 按盒子自己报的行数把高度再算一遍。**给检查用**：高度与裁行数是一处改另一处必须跟着改的
 * 一对，而对不上时没有任何报错——只是安静地裁掉半行字。
 */
export function heightOf(box: StageBox) {
  if (box.kind === 'case') return caseHeight(box.titleLines, box.questionLines);
  if (box.kind === 'step') return stepHeight(box.dirLines, box.vdLines);
  if (box.kind === 'tail') return tailHeight(box.vdLines);
  return sayHeight(box.textLines);
}

/**
 * 排一遍舞台。
 *
 * `items` 是 `weaveChat` 织好的到达序列，`lanes` 是 `trackLayout` 分配好的列——
 * 这里只做几何，不再判断任何"这一步属于谁"的事。
 *
 * `tail` 只是个开关：**尾卡出没出生由 `shared/report.ts` 的 `tailSummary()` 判**，
 * 卡面上写什么也在那儿。几何这侧不认识 case 状态，也就不会有第二处规则。
 */
export function stageLayout(
  items: StageRow[],
  lanes: TrackLane[],
  caseCard: { title: string; question: string } | null,
  tail = false,
): StageLayout {
  const boxes: StageBox[] = [];
  const byId = new Map<string, StageBox>();
  const edges: StageEdge[] = [];
  const marks: StageLayout['marks'] = [];
  const cursor = new Map<string, number>();
  const lastOfLane = new Map<string, string>();
  const laneHeads: StageLaneHead[] = [];
  const colX = (col: number) => STAGE.padX + col * (STAGE.cardW + STAGE.colGap);

  const push = (box: StageBox) => {
    boxes.push(box);
    byId.set(box.id, box);
  };

  if (caseCard) {
    const titleLines = TITLE_LINES;
    const questionLines = estLines(caseCard.question, CHARS_PER_LINE.question, 3);
    const h = caseHeight(titleLines, questionLines);
    push({ kind: 'case', id: CASE_BOX_ID, x: colX(0), y: STAGE.padY, w: STAGE.cardW, h, titleLines, questionLines });
    cursor.set(TRUNK, STAGE.padY + h + STAGE.vGap);
    lastOfLane.set(TRUNK, CASE_BOX_ID);
    // 主干的列头压在信息卡上方，不是压在第一步上方——信息卡就是这一列的开头
    const trunk = lanes.find((l) => l.id === TRUNK);
    if (trunk) laneHeads.push({ ...trunk, x: colX(0), y: STAGE.padY - STAGE.laneHead + 6 });
  }

  /**
   * 旁白自己一条游标：它落在主干左边那一栏，**不推进主干的游标**。
   * 推进的话，agent 每说一句话就把接下来的每一步整体下移一截，而那句话与那一步无关。
   */
  let sayCursor = STAGE.padY;

  for (const item of items) {
    if (item.kind === 'chat') {
      const textLines = estLines(item.line.text, CHARS_PER_LINE.say, 3) || 1;
      const h = sayHeight(textLines);
      const y = Math.max(cursor.get(TRUNK) ?? STAGE.padY, sayCursor);
      push({
        kind: 'say',
        id: item.id,
        x: colX(0) - STAGE.sayW - STAGE.sayGap,
        y,
        w: STAGE.sayW,
        h,
        line: item.line,
        textLines,
      });
      sayCursor = y + h + 12;
      continue;
    }

    const row = item.row;
    const dirLines = estLines(directionText(row.step), CHARS_PER_LINE.dir, 2) || 1;
    const vdLines = VERDICT_LINES;
    const h = stepHeight(dirLines, vdLines);
    const x = colX(row.col);

    // 开一条新线时与父卡齐平再往下错一点：父子的先后一眼看得出，而两者谁都不必让位
    const parentBox = row.step.parentStepId ? byId.get(row.step.parentStepId) : undefined;
    let floor: number = STAGE.padY;
    if (parentBox && parentBox.kind === 'step' && parentBox.x !== x) floor = Math.max(floor, parentBox.y + 26);

    let y = Math.max(cursor.get(row.laneId) ?? STAGE.padY, floor);
    // 断点条占的高度加在这一行头上，而不是让它盖住上一张卡的下沿
    if (row.sessionBreak) y += STAGE.sessionGap;
    push({ kind: 'step', id: row.step.id, x, y, w: STAGE.cardW, h, row, dirLines, vdLines });
    cursor.set(row.laneId, y + h + STAGE.vGap);

    if (row.sessionBreak) {
      marks.push({ id: `mark-${row.step.id}`, x, y: y - 18, sessionIndex: row.step.sessionIndex });
    }
    if (row.laneHead && !laneHeads.some((l) => l.id === row.laneId)) {
      const lane = lanes.find((l) => l.id === row.laneId);
      if (lane) laneHeads.push({ ...lane, x, y: y - STAGE.laneHead + 6 });
    }

    /**
     * 一条线内部用实线接上一张，**只有列头才画那条"开出去"的虚线**。
     *
     * 子 agent 支线的每一步都把 `parent_step_id` 指回起它那次调用所在的那一步，
     * 按父画的话同一条支线会有两三条虚线从主干扎过来，而它们说的是同一件事。
     */
    const prev = lastOfLane.get(row.laneId);
    if (prev) edges.push({ id: `f-${prev}-${row.step.id}`, kind: 'flow', fromId: prev, toId: row.step.id });
    else if (parentBox) {
      edges.push({ id: `o-${parentBox.id}-${row.step.id}`, kind: 'open', fromId: parentBox.id, toId: row.step.id });
    }
    lastOfLane.set(row.laneId, row.step.id);
  }

  /**
   * 收束卡：主干的尾（见文件中段那段「唯一的例外」）。
   *
   * y 取**所有游标的最大值，旁白那条也算在内**——只按主干算的话，agent 收尾时多说两句，
   * 旁白就又落到尾卡下面去了，而"终点不许是一句话"正是这张卡存在的全部理由。
   */
  if (tail) {
    const h = tailHeight(TAIL_VERDICT_LINES);
    const y = Math.max(STAGE.padY, sayCursor, ...cursor.values());
    push({ kind: 'tail', id: TAIL_BOX_ID, x: colX(0), y, w: STAGE.cardW, h, vdLines: TAIL_VERDICT_LINES });
    // 主干接到尾卡上：不接的话它看着是块飘在最下面的东西，而它恰恰是这条线的收束
    const prev = lastOfLane.get(TRUNK);
    if (prev) edges.push({ id: `f-${prev}-${TAIL_BOX_ID}`, kind: 'flow', fromId: prev, toId: TAIL_BOX_ID });
  }

  const bounds = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity, w: 0, h: 0 };
  for (const b of boxes) {
    bounds.x1 = Math.min(bounds.x1, b.x);
    // 列头与断点条都长在卡片上方，不算进去的话"适应"会把它们切掉
    bounds.y1 = Math.min(bounds.y1, b.y - STAGE.laneHead);
    bounds.x2 = Math.max(bounds.x2, b.x + b.w);
    bounds.y2 = Math.max(bounds.y2, b.y + b.h);
  }
  if (!boxes.length) {
    bounds.x1 = 0;
    bounds.y1 = 0;
    bounds.x2 = STAGE.cardW;
    bounds.y2 = 200;
  }
  bounds.w = bounds.x2 - bounds.x1;
  bounds.h = bounds.y2 - bounds.y1;

  // 「跟随最新」认的是**最后一步**，不是尾卡：跟随要停在刚发生的事上，
  // 而尾卡每帧都在那儿，认它的话每加一步都被拽到画布最下面那张不动的卡上
  const lastStep = [...boxes].reverse().find((b) => b.kind === 'step');
  return { boxes, byId, laneHeads, edges, marks, bounds, lastId: (lastStep ?? boxes[0])?.id ?? null };
}

/**
 * 推翻回指线接进来。**两头都得在舞台上**——画不出来的那一头由卡片上那句
 * 「← 被 X 推翻」兜着（少一条曲线只是少个指向，少一道划线才是把作废的结论显示成成立的）。
 */
export function refuteEdges(layout: StageLayout, pairs: { fromId: string; toId: string }[]): StageEdge[] {
  return pairs
    .filter((e) => layout.byId.has(e.fromId) && layout.byId.has(e.toId))
    .map((e) => ({ id: `r-${e.fromId}-${e.toId}`, kind: 'refute' as const, fromId: e.fromId, toId: e.toId }));
}
