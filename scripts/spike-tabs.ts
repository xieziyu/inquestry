/**
 * Spike Tabs —— 验工作区那排 tab 的状态计算（`src/shared/tabs.ts`）。
 *
 * 这一带的每一条错法都是安静的：tab 只是视图，算错了不会有任何报错，
 * 表现是"关掉一个之后落到了另一个调查上""重启回来少了两个"。所以要验的是：
 *
 *   1. **聚焦不追加、也不重排。** 同一次调查点两下要还是一个 tab，而且不许换位置——
 *      位置是人记住"我那份在第二个"的唯一依据
 *   2. **关掉当前那个之后落到右邻**，右邻没有才退左邻，全空了才是 null。
 *      一律回左边的话，连着关几个会把人送回一个几十分钟前的调查
 *   3. **关掉别的 tab 不许动当前那个**——最容易写反的一条，而它的表现是
 *      "点了别人的叉，自己这屏换了个调查"
 *   4. **过滤（已归档 / 已删）要走同一条落点规则**：一把 filter 的话，当前那个被淘汰时
 *      落到的是"活着的第一个"，与人自己关掉它时的落点不一样
 *   5. **从没写过与写坏了是两回事**：前者要沿用旧行为（挑最近一条），
 *      后者按空处理。合成一个的话，升级上来的旧库会静默丢掉手上那次调查
 *   6. **落库那份可能被人手改坏**：active 指着一个不在 open 里的 id、open 里有重复，
 *      读回来都不许把这种状态原样带进界面
 *   7. **⌘W 的落点归属看 tab 条在不在场。** 加速键是 main 侧全局的，人可能正在任何一屏上——
 *      在首页 / 历史 / 设置上接管它，等于屏幕上一个 tab 都看不见却悄悄关掉一个手上开着的调查
 *   8. **启动那一下的三档**（`backend/db/tabs.ts`，跑在真库上）：已收尾 / 已删的滤掉、
 *      滤完当场写回、以及"从没写过"与"写过是空的"必须分道走。这一段以前住在 main 里，
 *      Electron 进程外起不来，于是整段没有回归网
 *
 * 跑：npm run rebuild:node && npm run spike:tabs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { blobDir, openDatabase } from '../src/backend/db/database.js';
import { restoreCaseTabs, saveCaseTabs } from '../src/backend/db/tabs.js';
import { openCase, setCaseStatus } from '../src/backend/store/sqlite-store.js';
import {
  closeTab,
  focusOrAppend,
  keepTabs,
  NO_TABS,
  readTabs,
  tabForCloseKey,
  type CaseTabs,
} from '../src/shared/tabs.js';

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const T = (open: string[], active: string | null): CaseTabs => ({ open, active });

// ── 1. 聚焦或追加 ──
check(
  '没开过的调查追加到末尾并成为当前',
  eq(focusOrAppend(T(['a', 'b'], 'a'), 'c'), T(['a', 'b', 'c'], 'c')),
  '首页/历史点一条没开过的调查 = 开一个新 tab',
);
check(
  '已经开着的只聚焦，不追加也不挪位置',
  eq(focusOrAppend(T(['a', 'b', 'c'], 'c'), 'a'), T(['a', 'b', 'c'], 'a')),
  '挪位置的话一排 tab 会在每次切换后原地洗牌，人再也数不出自己那份在第几个',
);
check(
  '点当前那个是空操作（同一个对象）',
  focusOrAppend(T(['a', 'b'], 'b'), 'b') === undefined ? false : eq(focusOrAppend(T(['a', 'b'], 'b'), 'b'), T(['a', 'b'], 'b')),
  '重复点同一个 tab 不该产生新状态，否则每点一下都要多推一次落库',
);
check(
  '第一个 tab 自动成为当前',
  eq(focusOrAppend(NO_TABS, 'a'), T(['a'], 'a')),
  '空列表打开第一个之后必须有当前，否则工作区不知道该画谁',
);

// ── 2/3. 关闭 ──
check(
  '关掉当前那个落到右邻',
  eq(closeTab(T(['a', 'b', 'c'], 'b'), 'b'), T(['a', 'c'], 'c')),
  '右边那个多半是后来打开、刚切过来的那条线索',
);
check(
  '关掉最后一个（当前）才退回左邻',
  eq(closeTab(T(['a', 'b', 'c'], 'c'), 'c'), T(['a', 'b'], 'b')),
  '右边没有了才轮到左边',
);
check(
  '关掉唯一一个之后没有当前',
  eq(closeTab(T(['a'], 'a'), 'a'), T([], null)),
  'active 必须变成 null——留着一个已经不在列表里的 id，工作区会照着它画一屏没有 tab 的界面',
);
check(
  '关掉别的 tab 不动当前',
  eq(closeTab(T(['a', 'b', 'c'], 'b'), 'c'), T(['a', 'b'], 'b')),
  '点别人的叉却把自己这屏切走，是这一条写反时的表现',
);
check(
  '关一个不在列表里的 id 什么都不做',
  closeTab(T(['a', 'b'], 'a'), 'zz') === undefined
    ? false
    : eq(closeTab(T(['a', 'b'], 'a'), 'zz'), T(['a', 'b'], 'a')),
  '删掉一次从没开过 tab 的调查会走到这儿',
);

// ── ⌘W 的落点归属 ──
check(
  'tab 条在场且有 tab：关的是当前那个',
  tabForCloseKey(T(['a', 'b'], 'b'), true) === 'b',
  '工作区/报告上按 ⌘W = 关掉手上这个调查的 tab',
);
check(
  '不在 tab 条那几屏：交回系统默认（关窗口），tab 一个不动',
  tabForCloseKey(T(['a', 'b'], 'b'), false) === null,
  '🔴 首页 / 历史 / 设置上屏幕上一个 tab 都看不见，却悄悄关掉一个手上开着的调查——'
    + '人以为自己关的是窗口。这一条写反了不会有任何报错',
);
check(
  '一个 tab 都没有：哪一屏都回退',
  tabForCloseKey(NO_TABS, true) === null && tabForCloseKey(NO_TABS, false) === null,
  '关掉最后一个之后再按一下 ⌘W，人要的就是关窗口',
);

// ── 4. 过滤 ──
const alive = (ids: string[]) => (id: string) => ids.includes(id);
check(
  '过滤掉已归档 / 已删的，当前还活着就不动',
  eq(keepTabs(T(['a', 'b', 'c'], 'b'), alive(['a', 'b'])), T(['a', 'b'], 'b')),
  '重启恢复时最常见的一档',
);
check(
  '当前那个被淘汰时按「右邻优先」落点，不是「活着的第一个」',
  eq(keepTabs(T(['a', 'b', 'c'], 'b'), alive(['a', 'c'])), T(['a', 'c'], 'c')),
  '一把 filter 会落到 a 上——与人自己关掉 b 时的落点不一样，而两条路该给同一个结果',
);
check(
  '全被淘汰就是空',
  eq(keepTabs(T(['a', 'b'], 'a'), alive([])), T([], null)),
  '库被清空 / 全部归档之后 tab 条整条不出现',
);

// ── 5/6. 读回落库那份 ──
check(
  '从没写过回 null，与「写过、是空的」分得开',
  readTabs(null) === null && eq(readTabs('{"open":[],"active":null}'), NO_TABS),
  '升级上来的旧库要沿用「挑最近一条未定稿的」，而人自己关光了 tab 的那次不该再自动开一个',
);
check(
  '内容坏了按空处理，不抛',
  eq(readTabs('{{{'), NO_TABS) && eq(readTabs('null'), NO_TABS),
  '坏数据不该把启动整条挡住——那时表现是 app 停在启动失败屏',
);
check(
  'active 指着一个不在 open 里的 id 时归到第一个',
  eq(readTabs('{"open":["a","b"],"active":"zz"}'), T(['a', 'b'], 'a')),
  '原样带进界面的话，tab 条上没有一个是选中的，而工作区画着另一个调查',
);
check(
  'open 里的重复项与非字符串一并清掉',
  eq(readTabs('{"open":["a","a",7,"b"],"active":"b"}'), T(['a', 'b'], 'b')),
  '重复的 id 会让 React 的 key 撞上，两枚 tab 从此一起高亮',
);

// ── 8. 启动那一下：跑在真库上（`backend/db/tabs.ts`）──
{
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-tabs-')), 'inquestry.db');
  const db = openDatabase(file);
  const blobs = blobDir(file);
  let clock = 1_700_000_000_000;
  const ctx = (caseId: string) => ({ caseId, blobDir: blobs, now: () => (clock += 1000) });
  const mk = (id: string) =>
    openCase(db, ctx(id), {
      title: id,
      question: `${id} 的问题`,
      projectRoot: null,
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    });
  // 建的顺序就是 updated_at 的顺序：**最后建的那个故意是收了尾的**，
  // 好让"挑最近一条"那一档必须真的看 status，而不是照着 updated_at 拿第一行
  mk('t_a');
  mk('t_b');
  mk('t_gone');
  setCaseStatus(db, ctx('t_gone'), 'closed');
  const raw = () =>
    (db.prepare(`SELECT value FROM ui_settings WHERE key='ui.tabs'`).get() as { value: string } | undefined)
      ?.value ?? null;

  check(
    '从没写过：挑最近一条**未定稿**的开成唯一一个 tab',
    eq(restoreCaseTabs(db), T(['t_b'], 't_b')),
    '升级上来的旧库走这一档；不看 status 的话会挑中刚定稿的 t_gone，点进去是个发什么都不动的工作区',
  );
  // **当前那个夹在两个活着的中间**：一把 filter 与「右邻优先」在这份夹具上给出不同的落点
  // （前者落回 t_a，后者落到 t_b）。当前排在头一个的话两条路答案相同，这条检查就是空的
  saveCaseTabs(db, T(['t_a', 't_gone', 't_b', 't_never'], 't_gone'));
  check(
    '已收尾的与库里根本没有的都滤掉，落点仍按「右邻优先」',
    eq(restoreCaseTabs(db), T(['t_a', 't_b'], 't_b')),
    '不滤的话，点回去是一个照旧能打字、发出去却什么都不会发生的工作区；'
      + '而落点要与人自己关掉那个 tab 时一致，否则同一件事两条路给两个结果',
  );
  check(
    '滤完当场写回库，不留着下次再滤',
    raw() === JSON.stringify(T(['t_a', 't_b'], 't_b')),
    '只在内存里滤的话，库里那份会一直带着早就归档的 id，而这种脏数据永远看不出来',
  );
  saveCaseTabs(db, { open: [], active: null });
  check(
    '写过、是空的：不再走"挑最近一条"的兜底',
    eq(restoreCaseTabs(db), NO_TABS),
    '🔴 与上面那一档同一条 SQL 的两个分支：合成一个的话，人自己关光了 tab，下次启动又给他开一个',
  );
  check(
    'active 指着一个不在 open 里的 id 不许落进库',
    eq(saveCaseTabs(db, { open: ['t_a'], active: 't_b' }), T(['t_a'], 't_a')),
    '来路是 renderer，原样落库的话这种状态要到下一次启动才现形',
  );
  console.log(`\n临时库：${file}`);
}

console.log('\n===== Spike Tabs 结果 =====');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
