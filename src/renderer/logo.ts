/**
 * 应用标记怎么画。**不带 React**，所以官网（`site/main.js`）也读这一份。
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

export type Tier = 'full' | 'small' | 'tiny';

const SOURCE: Record<Tier, string> = { full: markFull, small: markSmall, tiny: markTiny };

export function tierFor(size: number): Tier {
  if (size >= 128) return 'full';
  return size > 20 ? 'small' : 'tiny';
}

/** 文件里的固定色值 → 可覆写的品牌变量；fallback 与应用图标使用同一套定稿色。 */
const PALETTE: Array<[RegExp, string]> = [
  [/#C9D5E0/gi, 'var(--mk-top, #C9D5E0)'],
  [/#4D91D0/gi, 'var(--mk-middle, #4D91D0)'],
  [/#24577F/gi, 'var(--mk-bottom, #24577F)'],
];

/**
 * 取 `<svg>` 的内层内容：外层由调用方渲染，才给得了它 width/height/class。
 * mask id 必须按实例改名；同屏的不同尺寸若共用一个 id，浏览器可能把小档套上大档的镂空。
 */
export function markInner(tier: Tier, instance: string): string {
  const svg = SOURCE[tier];
  let inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'));
  for (const [re, v] of PALETTE) inner = inner.replace(re, v);
  const suffix = instance.replace(/[^a-zA-Z0-9_-]/g, '_');
  const ids = [...inner.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
  for (const id of ids) {
    const unique = `${id}-${suffix}`;
    inner = inner.replaceAll(`id="${id}"`, `id="${unique}"`).replaceAll(`url(#${id})`, `url(#${unique})`);
  }
  return inner;
}
