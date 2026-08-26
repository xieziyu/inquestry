/**
 * 工作区上那排 tab 的全部状态计算。
 *
 * **tab 只是视图**：关掉一个 tab 只是把这次调查移出视图列表，它在 main 里的运行时
 * 一点没动（会话照旧跑、待办照旧等着人）。所以这一份里没有任何"关掉"的语义，
 * 只有"还看不看得见"——真要收掉一次调查走的是归档 / 删除那两条路。
 *
 * 放 shared 而不是 renderer：main 启动时要拿同一套规则把落库的那份过滤一遍
 * （已归档 / 已删的调查不该再长出一个点进去就是空的 tab），两处各写一遍的话，
 * 迟早一边留下另一边不认的 id，而那种不一致只在重启之后才现形。
 */

export type CaseTabs = {
  /** 打开着的调查，顺序即屏幕上从左到右的顺序。 */
  open: string[];
  /** 这会儿在看哪一个；`null` = 一个都没开。 */
  active: string | null;
};

export const NO_TABS: CaseTabs = { open: [], active: null };

/**
 * 从落库的那份 JSON 读回来。
 *
 * 🔴 **读不出来与从没写过是两回事，所以返回值区分 null**：从没写过的那一次
 * （升级上来的旧库）要沿用旧行为——挑最近一条未定稿的调查开成一个 tab，
 * 否则升级之后手上那次调查会静默消失，看起来像调查被清空了。
 * 而写过、内容坏了的按"一个都没开"处理：那是坏数据，不该拿它去猜。
 */
export function readTabs(raw: string | null): CaseTabs | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<CaseTabs>;
    const open = Array.isArray(v.open) ? v.open.filter((x): x is string => typeof x === 'string') : [];
    const active = typeof v.active === 'string' && open.includes(v.active) ? v.active : (open[0] ?? null);
    return { open: [...new Set(open)], active };
  } catch {
    return NO_TABS;
  }
}

/**
 * 打开一次调查：已经有 tab 就聚焦它，没有就在末尾追加一个。
 *
 * **不把已有的那个挪到末尾**：tab 的位置是人记住"我那份在左边第二个"的唯一依据，
 * 每点一次就重排的话，一排 tab 会在每次切换后原地洗牌。
 */
export function focusOrAppend(tabs: CaseTabs, caseId: string): CaseTabs {
  if (tabs.active === caseId) return tabs;
  const open = tabs.open.includes(caseId) ? tabs.open : [...tabs.open, caseId];
  return { open, active: caseId };
}

/**
 * 把一个 tab 移出视图列表。
 *
 * 关掉的正是当前那个时，**右边优先、没有右边才取左边**：这一排是按打开顺序排的，
 * 右边那个是后来打开的、多半也是刚才切过来的那条线索；一律回到左边的话，
 * 连着关掉几个之后人会被送回一个几十分钟前的调查。
 */
export function closeTab(tabs: CaseTabs, caseId: string): CaseTabs {
  const at = tabs.open.indexOf(caseId);
  if (at < 0) return tabs;
  const open = tabs.open.filter((x) => x !== caseId);
  if (tabs.active !== caseId) return { open, active: tabs.active };
  // 删掉之后，原位置上站着的就是右邻；它不存在说明关的是最后一个，退回左邻
  return { open, active: open[at] ?? open[at - 1] ?? null };
}

/**
 * ⌘W 这一下该关掉哪个 tab；**`null` = 这一屏不归 tab 管，交回系统默认（关窗口）**。
 *
 * 加速键是 main 侧全局的，按下时人可能正在任何一屏上。**落点归属看这一屏是不是某个 tab
 * 的内容**（`onTabScreen`）：在首页 / 历史 / 设置上按 ⌘W，屏幕上一个 tab 都看不见，
 * 却悄悄关掉一个手上开着的调查——人以为自己关的是窗口。
 *
 * 手上一个 tab 都没有时同样回退：那时这一下本来就没有别的意思。
 */
export function tabForCloseKey(tabs: CaseTabs, onTabScreen: boolean): string | null {
  return onTabScreen ? tabs.active : null;
}

/**
 * 只留还该看得见的那几个（`alive` 说了算）。
 *
 * 逐个走 `closeTab` 而不是一把 filter：当前那个正好被淘汰时，接替它的仍旧按
 * "右邻优先"挑——filter 一把过的话只剩"活着的第一个"，而那与人关掉它时的落点不一样。
 */
export function keepTabs(tabs: CaseTabs, alive: (caseId: string) => boolean): CaseTabs {
  return tabs.open.filter((id) => !alive(id)).reduce(closeTab, tabs);
}
