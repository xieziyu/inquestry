import type { CaseBrief, CaseHit, ShapeSuggestion } from '../shared/ipc.js';

/**
 * 定稿确认条上「状态型的主体填不填得出来」该信哪一份。
 *
 * 确认条冻的是弹出那一刻 main 算出来的整份建议，而快照每 60ms 换一次。两难在于：
 *
 * - 一律用冻住的：agent 随后给根因补上了应然/实然，那句"这一块会是空的"再也不消失
 * - 一律用实时的：根因**换了人**时两者指着不同的步——预选的是新根因声明的 `state`，
 *   却按旧根因判定成"填得出来"，于是一句提醒都没有，人当场确认就冻出一份空主体报告
 *
 * 所以按根因认：还是同一步就信实时的（补上了就自动消警），换了人就用冻住那份
 * （它与已经冻住的形态出自同一次计算，至少自洽）。
 */
export function stateFillable(frozen: ShapeSuggestion | undefined, live: ShapeSuggestion): boolean {
  if (!frozen) return live.stateFillable;
  return live.rootStepId === frozen.rootStepId ? live.stateFillable : frozen.stateFillable;
}

/**
 * 待办卡里人已经敲进去的东西，按「调查 + 条目 id」存。
 *
 * 提到 App 级是因为卡片跟着快照渲染：一换调查旧卡片就卸载，局部 state 随之蒸发，
 * 粘贴的查询结果、写好的拒绝理由全没。存在这里，切回去还在。
 */
export type CardDrafts = Record<string, Record<string, string>>;

export const draftKey = (caseId: string, itemId: string) => `${caseId}:${itemId}`;

/**
 * 对账：某个调查里已经不在快照上的条目，草稿也该跟着走。
 *
 * 草稿本身只在处置落地时才删得掉，但卡片消失的路径不止那一条——闸门到点自动放行、
 * 回填超时作废、停止或重开把待办整批散掉、后台 runner 被回收，都会让卡片从快照上消失。
 * 条目 id 每次都不同、App 又是长驻的，不对账的话这些记录只增不减，
 * 里面还可能躺着人粘进去的整段查询结果。
 *
 * **只对账传进来的那一次调查。** 别的调查的待办这会儿根本不在快照里，
 * 拿不到它们的 id；一并清掉就等于把「切回去草稿还在」这件事又废了。
 */
export function pruneDrafts(drafts: CardDrafts, caseId: string, aliveIds: Iterable<string>): CardDrafts {
  const alive = new Set(aliveIds);
  const prefix = `${caseId}:`;
  const dead = Object.keys(drafts).filter(
    (k) => k.startsWith(prefix) && !alive.has(k.slice(prefix.length)),
  );
  // 没得清就原样返回：换个新对象只会白白多一次渲染
  if (!dead.length) return drafts;
  const next = { ...drafts };
  for (const k of dead) delete next[k];
  return next;
}

/**
 * 把一份查出来的调查列表上的**运行时那一半**换成最新快照里的那一份。
 *
 * 检索命中与历史调查页那一页共用它（两者都是一次性查出来的，泛型只为保住各自多出来的字段）：
 * **同一条约束由两处各写一份的话，其中一处迟早跟不上**，而跟不上的表现正是这条要防的。
 *
 * 列表是一次性查出来的（人打完字、或翻到这一页那一刻），而「等你 N」「运行中」「当前」每 60ms 会变。
 * 不换的话，人停在检索结果上的这段时间里，**新冒出来的待办一条都不会显示**——
 * 而跨 case 汇总存在的全部理由就是别让那条支线静静挂死（D28）。
 *
 * 🔴 **不在 `cases` 里的按"静的"算，不是保留命中里那份旧值。** 这不是猜：
 * 快照里那份列表把「当前的 / 还跑着的 / 挂着待办的」全部钉住（`CaseRegistry.pinnedIds`），
 * 所以一次调查**不在里面** ⟺ 它三样都不是。留着旧值的话，一条刚被处理掉的待办
 * 会在检索结果上一直挂着「等你 3」。
 *
 * `loaded` 同理归零：它只说"main 这会儿还持有它的运行时"，没被钉住的就是没有。
 * ⚠️ **`started` 不在归零之列**：它是库里的事实（跑过没有），与钉不钉住无关——
 * 归零的话，一次真跑过的调查在检索结果里会显示成「待开始」。
 */
export function freshenHits<T extends CaseBrief>(hits: T[], cases: CaseBrief[]): T[] {
  const live = new Map(cases.map((c) => [c.id, c]));
  return hits.map((h): T => {
    const now = live.get(h.id);
    return {
      ...h,
      todos: now?.todos ?? 0,
      running: now?.running ?? false,
      current: now?.current ?? false,
      loaded: now?.loaded ?? false,
      // 状态与"跑过没有"是库里的事实，不随快照抖动；标题同理。命中那三项
      // （hits/snippet/where）说的是"这次检索为什么找到它"，更不该被覆盖
      status: now?.status ?? h.status,
      started: h.started,
    };
  });
}
