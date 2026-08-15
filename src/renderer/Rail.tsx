export type Screen = 'home' | 'workspace' | 'history' | 'settings';

/**
 * 全局导航（ui.md §8.5）。**一条 52px 的图标条，不写字、不带计数。**
 *
 * 它**挂在整幅顶栏之下**，不通到底（参照 `~/Projects/duetlens` 的 `AppRail`）。
 * 应用标记也不在这儿——顶栏左端那一格是它的，见 styles.css 的 `.brand`。
 *
 * ⚠️ 原先让它通到底，理由是"顶上那一段正好让开 macOS 交通灯"——**那是错的**：
 * 三颗灯连起来比这条 52px 的 rail 还宽，它只让开了竖着那一段，横着多出来的一截
 * 压在页头左端，而 rail 那条右边线从灯中间穿了过去。让位因此是顶栏一家的事
 * （`--head-pad`），rail 的右边线从顶栏下沿才画（`--head-h`，见 styles.css 的外壳网格）。
 * 这两个变量与 `main/index.ts` 里钉死的 `trafficLightPosition` 是一套，改一处要连着改。
 *
 * 调查的切换不在这儿。它在历史调查页（ui.md §8.3）：rail 上有常驻入口之后，
 * 切换不再是工作区内的手势，也就不必在工作区里再挂一排 chip。
 */
export function Rail({
  screen,
  /**
   * 有调查在等人处理（D28 的跨案汇总）。**是个点不是个数**——ui.md §4：
   * "有没有事找你是一个颜色的有无，不需要读字"。
   *
   * 没有它这一条就断了：切换入口搬到历史调查页之后，后台那条卡在 `ask_operator`
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
      {item('home', '首页', '首页 · 新建调查', <HomeIcon />)}
      {item(
        'workspace',
        '工作区',
        todo ? '工作区 · 有调查在等你处理' : '工作区',
        <TrackIcon />,
        todo,
      )}
      {item('history', '历史调查', '历史调查 · 检索与切换', <HistoryIcon />)}
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
