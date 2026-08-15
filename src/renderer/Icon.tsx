/**
 * 动作按钮上的图标。
 *
 * **只给动作，不给状态。** ui.md §5 那条「状态一律写字，不用图标」说的是状态词
 * （进行中 / 已证实 / 被推翻）——那些字会跟着截图被转发到看不见上下文的地方，图标在那儿
 * 会失去含义。按钮不进截图（导出视图里交互件整条移除），它要的是**在一排字里一眼分得出哪个是哪个**，
 * 而这正是图标比字快的地方。所以两条并存，不冲突。
 *
 * 一律**图标 + 字**，不做纯图标按钮（rail 是例外，它有 `aria-label` 且只有四格）：
 * 纯图标要人先学一遍，而这些按钮多数一次排查只按一两下，学不起来。
 *
 * 画法与 rail 的那几个同源（`Rail.tsx` 的 `S`）：24 格、描边、`currentColor`——
 * 换一套画法的话，同一个应用里会有两种线宽的图标。
 */

const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export type IconName =
  | 'plus'
  | 'report'
  | 'stop'
  | 'send'
  | 'pencil'
  | 'download'
  | 'seal'
  | 'archive'
  | 'back'
  | 'chevron'
  | 'check'
  | 'deny'
  | 'play'
  | 'folder'
  | 'arrow';

const PATHS: Record<IconName, React.JSX.Element> = {
  plus: <path d="M12 5v14M5 12h14" />,
  /** 一页纸加几行字：报告就是这个东西。 */
  report: (
    <>
      <path d="M6 3.5h8.5L19 8v12.5H6z" />
      <path d="M14 3.5V8h5M9 12.5h7M9 16h5" />
    </>
  ),
  /** 实心方块——「停」在任何播放器上都是这个形，不必再学。 */
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  pencil: (
    <>
      <path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  download: <path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 20h14" />,
  /** 定稿 = 盖个章：一个圈里的勾。 */
  seal: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12.2l2.4 2.4 4.6-4.8" />
    </>
  ),
  /** 归档 = 收进箱子：带盖的方箱。 */
  archive: (
    <>
      <path d="M3.5 6.5h17v3.5h-17z" />
      <path d="M5 10v9.5h14V10M10 14h4" />
    </>
  ),
  back: <path d="M19 12H5m6-6l-6 6 6 6" />,
  arrow: <path d="M5 12h14m-6-6l6 6-6 6" />,
  chevron: <path d="M6 9.5l6 6 6-6" />,
  check: <path d="M4.5 12.5l5 5 10-10.5" />,
  deny: <path d="M6 6l12 12M18 6L6 18" />,
  play: <path d="M8 5.5l11 6.5-11 6.5z" />,
  folder: <path d="M3 7.5a2 2 0 0 1 2-2h3.7l2 2.4H19a2 2 0 0 1 2 2v6.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
};

/**
 * `size` 默认 14：按钮里的字是 12–12.5px，图标比字略大才不显得瘪。
 * `aria-hidden` 是恒定的——按钮自己那几个字已经是它的名字了，读屏再念一遍图标是重复。
 */
export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="ic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...S}
    >
      {PATHS[name]}
    </svg>
  );
}
