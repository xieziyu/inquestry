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
