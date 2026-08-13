/**
 * 应用标记。
 *
 * 几何的唯一来源是 `build/logo/*.svg`（同一批文件供 `npm run icons:gen` 出应用图标），
 * 这里只做两件事：**按尺寸降档**，以及把文件里写死的色值换成色板变量，好跟着主题走。
 *
 * ⚠️ 阈值必须与 `scripts/gen-icons.ts` 的 `variantFor()` 一致。两处各写一套的结果是
 * dock 里那枚和界面里这枚在同一个尺寸上长得不一样，而这种不一致没人会去核。
 */
import markFull from '../../build/logo/mark.svg?raw';
import markSmall from '../../build/logo/mark-small.svg?raw';
import markTiny from '../../build/logo/mark-tiny.svg?raw';

type Tier = 'full' | 'small' | 'tiny';

const SOURCE: Record<Tier, string> = { full: markFull, small: markSmall, tiny: markTiny };

function tierFor(size: number): Tier {
  if (size >= 128) return 'full';
  return size > 20 ? 'small' : 'tiny';
}

/** 文件里的固定色值 → 色板变量。灰的两档各有深浅两个取值（小档为了压住糊边调亮过）。 */
const PALETTE: Array<[RegExp, string]> = [
  [/#6F7C89|#7E8C99/gi, 'var(--mk-tangle)'],
  [/#93A0AC|#9AA7B3/gi, 'var(--mk-line)'],
  [/#5A9EDD/gi, 'var(--ok)'],
  [/#C9564C/gi, 'var(--bad)'],
  [/#E0A94A/gi, 'var(--warn)'],
];

/**
 * 取 `<svg>` 的内层内容：外层由 React 渲染，才给得了它 width/height/class。
 *
 * 这几个标记里没有 `defs` / `id`，所以不必像别处那样给 id 加实例后缀——
 * 真加了 defs 就得补上，否则同屏挂两枚会互相串引用。
 */
function body(tier: Tier): string {
  const svg = SOURCE[tier];
  let inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'));
  for (const [re, v] of PALETTE) inner = inner.replace(re, v);
  return inner;
}

export function LogoMark({
  size = 24,
  tier,
  className,
}: {
  size?: number;
  /** 强制某一档；不给就按 size 自动降。 */
  tier?: Tier;
  className?: string;
}) {
  const t = tier ?? tierFor(size);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label="Inquestry"
      dangerouslySetInnerHTML={{ __html: body(t) }}
    />
  );
}
