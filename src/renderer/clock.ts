import { useSyncExternalStore } from 'react';

/**
 * 一枚模块级的秒钟，舞台心跳层那几个秒数靠它走。
 *
 * **为什么非要有它**：`main/index.ts` 的 `schedulePush()` 是事件驱动 + 60ms 合流，
 * 没事发生就一条快照都不推——一次九十秒的工具调用期间 renderer 收到的快照数是 **0**。
 * 秒数因此走不动，而"画面零变化"正是这一层要修的那个毛病。也别反过来让 main 每秒推一次：
 * 那等于每秒重建一整份快照（好几条聚合查询）只为让一个数字加一。
 *
 * 🔴 **只有显示秒数的那几个叶子组件许订阅它。** 不许把刻度提成一个整个 Stage 都消费的
 * context 或 `useState`：那样每秒要对账整棵舞台（实测 dev build 下 16 个世界节点 0.7ms、
 * 79 个 1.1ms，而且随调查变长一路涨），可每秒真正要变的只有 (开着的步数 + 在跑的支线数 + 1)
 * 个文本节点，通常两三个。收在叶子上，开销就与图的大小脱钩了。
 * 写成前一种**一样跑得对、一样不会报错**，只是长调查越跑越卡——所以这条没有会失败的检查，
 * 只有这段话。
 *
 * 窗口被遮挡时 Electron 的 `backgroundThrottling` 会把这个定时器降到分钟级，不用管：
 * 每次渲染都是 `Date.now() - startedAt` 现算，回到前台第一帧数字就自己对上了。
 * ⚠️ 但验证时要留意——"隔两秒读一次文本变了"那条断言在被遮挡的窗口上会失败。
 */

let timer: ReturnType<typeof setInterval> | null = null;
let tick = 0;
const subs = new Set<() => void>();

/**
 * 订阅秒钟，返回退订。
 *
 * **没人订的时候定时器要真的停掉**：留着的话调查空闲时它照旧每秒唤醒一次，
 * 而这个 app 多数时间是空闲的。
 */
export function subscribeSecond(fn: () => void): () => void {
  subs.add(fn);
  timer ??= setInterval(() => {
    tick += 1;
    for (const f of [...subs]) f();
  }, 1000);
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** 秒钟的刻度。**只是个每秒会变的数**，不是时刻——秒数一律由用它的组件自己现算。 */
export const secondTick = () => tick;

/** 定时器这会儿在不在跑。只给 `spike:live` 用。 */
export const clockRunning = () => timer !== null;

/** 每秒重渲染一次调用它的那个组件。**父组件不许调**，理由见上面那段红字。 */
export function useSecond(): number {
  return useSyncExternalStore(subscribeSecond, secondTick, secondTick);
}
