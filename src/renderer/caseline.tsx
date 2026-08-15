import type { CaseBrief, CaseListRow } from '../shared/ipc.js';
import { SHAPE_COPY } from '../shared/report.js';

/**
 * 首页与历史调查页共用的一行调查怎么读。
 *
 * **两页共用同一套措辞与徽标**：同一次调查在两个列表里显示成两种状态，
 * 人会以为那是两次调查——而这两页正是切换调查的仅有入口（ui.md §8.3）。
 */

/**
 * 这一行现在处于什么状态。
 *
 * 运行时那一档排在库状态之前：`running` / `todos` 是"此刻正在发生的事"，
 * 而 `status` 只说得出"上次收尾成什么样"。一个正卡在待办上的 open 调查
 * 按库状态读出来是"已停止"，那正是 D28 要防的那种静静挂死。
 *
 * 🔴 **没在跑那一档按 `started` 分，不按 `loaded`。** 后者是"main 还持有它的运行时"，
 * 一个内存事实：点开看过一眼、一轮都没跑过的调查会被它读成「已停止」，而那次调查点进去
 * 底部写的是「待开始」——同一次调查在两处说了两句相反的话，且两处都不报错。
 * 反过来，一个真跑过又被限流降级掉的调查会读成「未打开」。
 *
 * **措辞与工作区底部状态栏（`RunBar` 的 `stateLabel`）是一套**：那一条说的是"这一轮"，
 * 这一条说的是"这次调查"，但两者对同一个事实必须用同一个词。改一处要连着改。
 */
export function caseState(c: CaseBrief) {
  return runState({ status: c.status, running: c.running, started: c.started });
}

/**
 * 四个词的**唯一出处**：已定稿 / 已归档 / 运行中 / 已停止 / 待开始。
 *
 * 列表与工作区底部状态栏都读它。两处问的问题确实不同（"这次调查现在什么情况" vs
 * "这一轮在干嘛"），但**同一个事实必须用同一个词**——各写各的下场就是首页写「已停止」、
 * 点进去写「待开始」，人只能猜哪个是真的。
 *
 * 状态栏那侧另有一档「会话中断」，那是这一条给不出的额外信息，不与这四个词冲突。
 */
export function runState(p: {
  status: CaseBrief['status'];
  /** 有一轮正在跑。 */
  running: boolean;
  /** 这次调查跑过没有。 */
  started: boolean;
}): { label: string; tone: 'run' | 'idle' | 'done' } {
  if (p.status === 'closed') return { label: '已定稿', tone: 'done' };
  if (p.status === 'aborted') return { label: '已归档', tone: 'done' };
  if (p.running) return { label: '运行中', tone: 'run' };
  return { label: p.started ? '已停止' : '待开始', tone: 'idle' };
}

/** 已定稿的调查多一句"按哪种形态装的"——那是它最有信息量的一栏。 */
export function caseShape(c: CaseListRow): string | null {
  return c.verdictShape ? SHAPE_COPY[c.verdictShape].label : null;
}

/**
 * 相对时间。**只到"天"为止，再往前就给日期**：
 * "37 天前"要人自己换算成哪一天，而调查是按日子记的（基准日期就是一天）。
 */
export function ago(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  const min = Math.floor(d / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  const t = new Date(ms);
  const mm = `${t.getMonth() + 1}`.padStart(2, '0');
  const dd = `${t.getDate()}`.padStart(2, '0');
  // 跨年的要带年份：只给 08-12 的话，去年那次看起来像上周
  return t.getFullYear() === new Date(now).getFullYear()
    ? `${mm}-${dd}`
    : `${t.getFullYear()}-${mm}-${dd}`;
}

/**
 * 工作区只显示末级目录名，完整路径进 title——列表要的是认得出是哪个项目。
 * null 只可能来自"工作区必填"这条规则之前立的旧调查。
 */
export function rootLabel(root: string | null): string {
  return root ? (root.split('/').filter(Boolean).slice(-1)[0] ?? root) : '无工作区';
}

/** 末级目录名之外的那一段（`/a/b/c` → `/a/b`）：工作区菜单里答"哪一个同名的"。 */
export function rootParent(root: string): string {
  const i = root.replace(/\/+$/, '').lastIndexOf('/');
  return i > 0 ? root.slice(0, i) : '/';
}

/**
 * 「等你 N」徽标。暖色是全局唯一的（ui.md §4），所以它只在这一处出现——
 * 别的状态一律用中性色或主色。
 */
export function TodoBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="badge todo">等你 {n}</span>;
}
