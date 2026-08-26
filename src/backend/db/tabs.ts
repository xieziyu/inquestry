/**
 * 工作区那排 tab 落在 `ui_settings` 里的那一行（`shared/tabs.ts` 是它的计算规则）。
 *
 * **算法在 shared，跟库有关的那两件事在这儿**：启动时把不该再开 tab 的调查滤掉，以及落库。
 * 摆在 main 里的话这一段就没有回归网——它跑在 Electron 进程里，spike 起不来。
 */

import { keepTabs, NO_TABS, readTabs, type CaseTabs } from '../../shared/tabs.js';
import type { Db } from './database.js';

const TABS_KEY = 'ui.tabs';

/**
 * 落一份新的。**先过一遍 `readTabs` 归一**：这一份的来路是 renderer，
 * 原样落库的话，一个 active 指着不在 open 里的 id 会留到下一次启动才现形。
 * 回的是真正落进去的那一份，调用方直接认它。
 */
export function saveCaseTabs(db: Db, tabs: CaseTabs): CaseTabs {
  const next = readTabs(JSON.stringify(tabs)) ?? NO_TABS;
  db.prepare(
    `INSERT INTO ui_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(TABS_KEY, JSON.stringify(next));
  return next;
}

/**
 * 启动时把上次那排 tab 读回来。**恢复的是视图，不是会话**——开不开跑由人自己说。
 *
 * 两道过滤缺一不可：库里没有的（删掉了）与不是 `open` 的（定稿 / 归档）都不再开 tab。
 * 不滤的话，点回去得到的是一个照旧能打字、发出去却什么都不会发生的工作区。
 *
 * `readTabs` 回 null = 这个库**从没写过** tab（升级上来的旧库），那一次沿用旧行为：
 * 挑最近一条未定稿的开成唯一一个 tab。少了这一档的表现是"升级完手上那次调查不见了"；
 * 而"写过、是空的"必须走另一条——人自己关光了 tab，不该下次启动又自动开一个。
 *
 * 过滤掉的那几个**当场落回库**：不写的话库里那份会一直带着早就归档的 id，
 * 而"下次启动照样滤得掉"会让这种脏数据永远看不出来。
 */
export function restoreCaseTabs(db: Db): CaseTabs {
  const raw =
    (db.prepare(`SELECT value FROM ui_settings WHERE key=?`).get(TABS_KEY) as
      | { value: string }
      | undefined)?.value ?? null;
  const saved = readTabs(raw);
  let tabs: CaseTabs;
  if (saved) {
    const alive = new Set(
      (db.prepare(`SELECT id FROM cases WHERE status='open'`).all() as { id: string }[]).map((r) => r.id),
    );
    tabs = keepTabs(saved, (id) => alive.has(id));
  } else {
    const row = db
      .prepare(`SELECT id FROM cases WHERE status='open' ORDER BY updated_at DESC LIMIT 1`)
      .get() as { id: string } | undefined;
    tabs = row ? { open: [row.id], active: row.id } : NO_TABS;
  }
  return saveCaseTabs(db, tabs);
}
