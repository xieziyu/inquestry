import type { StepNode } from '../shared/ipc.js';

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
