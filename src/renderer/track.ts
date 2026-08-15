import type { ChatLine, StepNode } from '../shared/ipc.js';

/**
 * 轨道布局（D23 / ui.md §3）。
 *
 * > **主干严格纵向单调追加，永不重排；分叉只向右生长。**
 *
 * 这条约束不是为了好看：节点每几秒钻出来一个，任何"把图排漂亮"的布局都会让正在读的
 * 那个节点位移。所以这里**只算 x（缩进），不动顺序**——行序逐字就是传进来的到达顺序。
 *
 * 由此派生出的实现方式：深度只从**已经出现过的**步算。这一手同时兜掉了三件事——
 * 父在后面才到（真出现的话，按树排就得把已读节点整段挪走）、父根本不存在、以及自引用，
 * 三者一律落回主干。也因此它天然不会成环，不需要防环。
 *
 * 后两种正常情况下到不了这里（写入侧会先归一，见 `openStep`），留着是因为这个函数
 * 得对任意一份快照都算得出东西来——它同时也是那条写入侧规则的兜底。
 */

/** 再深就跑出画布了。超了仍然是父子，只是不再往右缩进——`depthCapped` 会标出来。 */
export const MAX_DEPTH = 3;

export type TrackRow = {
  step: StepNode;
  /** 0 = 主干。缩进量由 CSS 乘上去。 */
  depth: number;
  /** 节点上显示的序号，恒为 `#N`。会话归属看断点条，不靠前缀——理由见下面的 `label`。 */
  label: string;
  /** 承接的那一步；null = 主干，或父不在这条轨道上。跨会话时带会话号。 */
  parentLabel: string | null;
  /** 缩进到顶了，父子关系仍在。 */
  depthCapped: boolean;
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
  /** 两头都在轨道上的才画得出来；画不出来的那一头由 `refutedBy` 用文字兜着。 */
  edges: RefuteEdge[];
};

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

  const depths = new Map<string, number>();
  const refutes = new Map<string, string[]>();
  for (const s of steps) {
    const target = s.supersededBy ? byId.get(s.supersededBy) : undefined;
    if (!target) continue;
    const by = refutes.get(s.supersededBy!) ?? [];
    by.push(refTo(s, target));
    refutes.set(s.supersededBy!, by);
  }

  const rows: TrackRow[] = steps.map((step, i) => {
    // 只认已经出现过的父。写在 depths.set 之前，自引用因此查不到自己
    const parentDepth = step.parentStepId ? depths.get(step.parentStepId) : undefined;
    const depth = parentDepth === undefined ? 0 : Math.min(parentDepth + 1, MAX_DEPTH);
    depths.set(step.id, depth);
    const parent = parentDepth === undefined ? undefined : byId.get(step.parentStepId!);
    const refuter = step.supersededBy ? byId.get(step.supersededBy) : undefined;
    const prev = steps[i - 1];
    return {
      step,
      depth,
      label: label(step),
      parentLabel: parent ? refTo(parent, step) : null,
      depthCapped: parentDepth !== undefined && parentDepth + 1 > MAX_DEPTH,
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

  return { rows, edges };
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
 * 拿"当前时间"或"当前在跑哪一步"去定位的话，同一句话会随着排查往下走而挪位置。
 *
 * **每次会话开场那条不织进去**：它是 harness 用建单信息拼的（问题正文 + 基准日期 + 工作区），
 * 立案卡上已经逐字有了，织进来就是同一段话在一屏上出现两次。认法是"以问题正文开头的 user 句"
 * ——`session_id` 在快照里没有，而 role 与正文是有的。
 */
export function weaveChat(rows: TrackRow[], chat: ChatLine[], question?: string): StageRow[] {
  const q = question?.trim();
  const said = chat.filter((c) => !(q && c.role === 'user' && c.text.trim().startsWith(q)));
  const out: StageRow[] = [];
  let i = 0;
  const drain = (before: number) => {
    while (i < said.length && said[i]!.at < before) {
      const line = said[i]!;
      out.push({ kind: 'chat', id: `chat-${line.at}-${i}`, line });
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
