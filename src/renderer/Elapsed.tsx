import { useSecond } from './clock.js';
import { elapsedText } from './live.js';

/**
 * 秒表。**整个 app 里只有它订阅时钟**（`clock.ts` 那段红字说了为什么不能往上提）。
 *
 * 秒数一律 `Date.now() - from` 现算：快照是事件驱动的，一次几十秒的调用期间一条都不推，
 * 靠快照的话这个数根本不会变——而"数字在变"正是这一层唯一扛事的东西。
 *
 * 自成一个模块是因为卡片们都要用它：搭在 `Stage.tsx` 上的话，`CaseCard` 这样的叶子
 * 得反过来运行时导入容器，两边成环——现在能跑只是因为绑定要到渲染那一刻才读。
 */
export function Elapsed({ from, markStale }: { from: number; markStale?: boolean }) {
  useSecond();
  return <>{elapsedText(Date.now() - from, markStale)}</>;
}
