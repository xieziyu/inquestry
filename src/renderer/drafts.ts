import type { ShapeSuggestion } from '../shared/ipc.js';

/**
 * 结案确认条上「状态型的主体填不填得出来」该信哪一份。
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
 * 待办卡里人已经敲进去的东西，按「案子 + 条目 id」存。
 *
 * 提到 App 级是因为卡片跟着快照渲染：一切案子旧卡片就卸载，局部 state 随之蒸发，
 * 粘贴的查询结果、写好的拒绝理由全没。存在这里，切回去还在。
 */
export type CardDrafts = Record<string, Record<string, string>>;

export const draftKey = (caseId: string, itemId: string) => `${caseId}:${itemId}`;

/**
 * 对账：某个案子里已经不在快照上的条目，草稿也该跟着走。
 *
 * 草稿本身只在处置落地时才删得掉，但卡片消失的路径不止那一条——闸门到点自动放行、
 * 回填超时作废、停止或重开把待办整批散掉、后台 runner 被回收，都会让卡片从快照上消失。
 * 条目 id 每次都不同、App 又是长驻的，不对账的话这些记录只增不减，
 * 里面还可能躺着人粘进去的整段查询结果。
 *
 * **只对账传进来的那一个案子。** 别的案子的待办这会儿根本不在快照里，
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
