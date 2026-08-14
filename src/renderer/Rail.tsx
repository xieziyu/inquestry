import { LogoMark } from './LogoMark.js';

export type Screen = 'home' | 'workspace' | 'history' | 'settings';

/**
 * 全局导航（ui.md §8.5）。**一条 52px 的图标条，不写字、不带计数。**
 *
 * 它通到底而不是挂在顶栏之下：顶上那一段正好让开 macOS 交通灯并当拖拽区，
 * 主区因此不必再为交通灯留一次位——现在每一屏各有各的页头，那一格是给标题的。
 *
 * 排查的切换不在这儿。它在历史排查页（ui.md §8.3）：rail 上有常驻入口之后，
 * 切换不再是工作区内的手势，也就不必在工作区里再挂一排 chip。
 */
export function Rail({
  screen,
  /**
   * 有排查在等人处理（D28 的跨案汇总）。**是个点不是个数**——ui.md §4：
   * "有没有事找你是一个颜色的有无，不需要读字"。
   *
   * 没有它这一条就断了：切换入口搬到历史排查页之后，后台那条卡在 `ask_operator`
   * 上的支线在别的屏上一点痕迹都没有，而①档不处理就是永远等下去。
   */
  todo,
  /** claude 找不到。坏消息用绯色，别占掉暖色那一档。 */
  envBad,
  onGo,
}: {
  screen: Screen;
  todo: boolean;
  envBad: boolean;
  onGo: (s: Screen) => void;
}) {
  /**
   * 不写字，那"这是什么"就全靠 title 与 aria-label——两个都要给，而且**给的不是同一句**：
   * `title` 是鼠标停下来才看的，放得下补充说明；`aria-label` 是这一格的名字，
   * 把补充说明也塞进去的话，读屏每次经过都要念一整句。
   */
  const item = (id: Screen, name: string, hint: string, icon: React.JSX.Element, dot = false) => (
    <button
      className={`rail-btn${screen === id ? ' on' : ''}`}
      title={hint}
      aria-label={name}
      aria-current={screen === id ? 'page' : undefined}
      onClick={() => onGo(id)}
    >
      {icon}
      {dot && <span className="dot" />}
    </button>
  );

  return (
    <nav className="rail" aria-label="主导航">
      <div className="mark">
        <LogoMark size={20} />
      </div>
      {item('home', '首页', '首页 · 新建排查', <HomeIcon />)}
      {item(
        'workspace',
        '工作区',
        todo ? '工作区 · 有排查在等你处理' : '工作区',
        <TrackIcon />,
        todo,
      )}
      {item('history', '历史排查', '历史排查 · 检索与切换', <HistoryIcon />)}
      <span className="rail-gap" />
      <span
        className={`env ${envBad ? 'bad' : ''}`}
        title={envBad ? '没找到 claude 可执行文件' : 'claude 已就绪'}
      />
      {item('settings', '设置', '设置', <GearIcon />)}
    </nav>
  );
}

const S = {
  width: 17,
  height: 17,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const HomeIcon = () => (
  <svg {...S}>
    <path d="M3 10.2 12 3l9 7.2" />
    <path d="M5 9.5V20h14V9.5" />
  </svg>
);

/** 图标就是轨道本身：主干纵向 + 一条只向右生长的分叉（D23）。 */
const TrackIcon = () => (
  <svg {...S}>
    <path d="M7 4.5v15" />
    <circle cx="7" cy="7.5" r="2.1" />
    <circle cx="7" cy="16.5" r="2.1" />
    <path d="M7 12h6a2 2 0 0 1 2 2" />
    <circle cx="17.5" cy="14" r="2.1" />
  </svg>
);

const HistoryIcon = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5.2l3.4 2" />
  </svg>
);

const GearIcon = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.1 14.4a1.6 1.6 0 0 0 .32 1.8l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.8-.32 1.6 1.6 0 0 0-.97 1.47v.17a2 2 0 0 1-4 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.8.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.8 1.6 1.6 0 0 0-1.47-.97H2.8a2 2 0 0 1 0-4h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.8l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.8.32h.08A1.6 1.6 0 0 0 9.7 3.7v-.17a2 2 0 0 1 4 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.8-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.8v.08a1.6 1.6 0 0 0 1.47.97h.17a2 2 0 0 1 0 4h-.09a1.6 1.6 0 0 0-1.47.97z" />
  </svg>
);
