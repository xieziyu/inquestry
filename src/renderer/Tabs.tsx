import { useEffect, useRef } from 'react';
import type { CaseBrief } from '../shared/ipc.js';

/**
 * 工作区顶上那排 tab：**打开着的调查**，一个 tab 一次调查。
 *
 * 🔴 **tab 只是视图。** 关掉一个只把它移出这排，调查在 main 里照旧跑、待办照旧等着人
 * （切调查从来就不中断任何一个，见 `case-registry.ts`）。所以这里没有"停止""结束"，
 * 真要收掉一次调查走的是报告屏上的定稿 / 归档。
 *
 * 状态点只有两档，取自快照里那份调查概览（`CaseBrief`）——**不另开一路轮询**：
 * 有人等你（暖色，全局唯一那一档）压过在跑（主色）。两者都没有就不点，
 * 一个静止的调查不该在余光里留下任何东西。
 */
export function Tabs({
  tabs,
  active,
  briefs,
  onPick,
  onClose,
}: {
  tabs: string[];
  active: string | null;
  briefs: CaseBrief[];
  onPick: (caseId: string) => void;
  onClose: (caseId: string) => void;
}) {
  const on = useRef<HTMLDivElement>(null);
  /**
   * 开得多到要横向滚时，当前那个得自己露出来：从首页 / 历史切过来的那一下，
   * 它很可能落在滚动区外——屏幕上于是一排 tab 里一个高亮的都没有。
   *
   * ⚠️ **不用 `behavior:'smooth'`**：窗口没获焦点时它一次都不跑（CLAUDE.md §验界面），
   * 而这个 app 的验证环境天然不获焦点。`nearest` 保证已经看得见时不动。
   */
  useEffect(() => {
    on.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  if (!tabs.length) return null;
  const by = new Map(briefs.map((c) => [c.id, c]));
  return (
    <div className="casetabs" role="tablist">
      {tabs.map((id) => {
        const c = by.get(id);
        /**
         * 列表里没有这一条时只剩 id 可显示。**不编一个「未命名」**：那句话与调查真的
         * 没起标题长得一模一样，而这儿的成因是列表还没推到（新开的那一瞬）。
         */
        const title = c?.title ?? id;
        // 「等你」压过「在跑」：一个调查可以既跑着又等着人，而要人动手的那一档更急。
        // ⚠️ `running` 是 runner 的 `isBusy`，被限流降级之后它是 false——点不亮就是真的没在跑
        const mark = c?.todos ? 'todo' : c?.running ? 'run' : null;
        return (
          <div key={id} ref={id === active ? on : undefined} className={`casetab${id === active ? ' on' : ''}`}>
            <button
              className="pick"
              role="tab"
              aria-selected={id === active}
              title={title}
              onClick={() => onPick(id)}
            >
              {mark && <i className={`dot ${mark}`} />}
              <span className="t">{title}</span>
            </button>
            {/* 叉子单独一枚按钮：套在上面那枚里会变成嵌套 button，点关闭连带切过去 */}
            <button
              className="x"
              title="关闭标签页（⌘W）。调查照旧在后台跑"
              aria-label={`关闭标签页 ${title}`}
              onClick={() => onClose(id)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
