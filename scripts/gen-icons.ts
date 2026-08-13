/**
 * 从 build/logo/*.svg 生成应用图标（build/icon.icns + build/icon.png）。
 *
 * 单一来源是手写的分档 SVG；本脚本只负责套 macOS 图标底板、光栅化、组装 icns。
 * 依赖 rsvg-convert（brew install librsvg）与 iconutil（macOS 自带）；
 * 产物已提交进仓库，所以打包机上不需要这两个工具，只有改图时才要跑。
 *
 *   npm run icons:gen
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LOGO = path.join(ROOT, 'build', 'logo');
const OUT = path.join(ROOT, 'build');
const TMP = path.join(ROOT, 'node_modules', '.cache', 'inquestry-icons');

/** macOS Big Sur 图标栅格：1024 画布里 824 的圆角方，圆角半径为其 22.5%。 */
const CANVAS = 1024;
const PLATE = 824;
const PLATE_R = PLATE * 0.225;

/**
 * 各档在 96 画布里可见内容的实际跨度与几何中心。
 *
 * **不能三档共用一组数**：降档删的是内容，跨度跟着变，套用同一个缩放会让 16px 那版
 * 比 128px 那版明显小一圈，而两者本该看着一样重。数值由笔画外沿（含 stroke 宽度的一半）
 * 与圆点半径量出来，改了 SVG 就要重量。
 */
const VARIANTS = {
  full: { file: 'mark.svg', span: 87.97, cx: 49.51, cy: 49.88 },
  small: { file: 'mark-small.svg', span: 89.2, cx: 47.9, cy: 48.89 },
  tiny: { file: 'mark-tiny.svg', span: 90.65, cx: 46.68, cy: 49.0 },
} as const;

type Variant = keyof typeof VARIANTS;

/** 可见内容占底板的比例。 */
const CONTENT = 0.76;

/** 分档阈值与 renderer/LogoMark.tsx 必须一致：细节糊掉之前降档。 */
function variantFor(px: number): Variant {
  if (px >= 128) return 'full';
  return px > 20 ? 'small' : 'tiny';
}

const ICONSET: Array<[string, number]> = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

/** 取出 <svg> 的内层内容，好把它塞进底板那张画布里。 */
function markBody(file: string): string {
  const svg = readFileSync(path.join(LOGO, file), 'utf8');
  const open = svg.indexOf('>', svg.indexOf('<svg'));
  return svg.slice(open + 1, svg.lastIndexOf('</svg>'));
}

function compose(variant: Variant): string {
  const { file, span, cx, cy } = VARIANTS[variant];
  const scale = (PLATE * CONTENT) / span;
  // 按量出来的几何中心对齐，不按 viewBox 中心——这个标记是横长的，两者差得出来
  const tx = CANVAS / 2 - cx * scale;
  const ty = CANVAS / 2 - cy * scale;
  const inset = (CANVAS - PLATE) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2130"/>
      <stop offset="1" stop-color="#0c0f16"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${PLATE}" height="${PLATE}" rx="${PLATE_R}" fill="url(#plate)"/>
  <rect x="${inset + 1.5}" y="${inset + 1.5}" width="${PLATE - 3}" height="${PLATE - 3}" rx="${PLATE_R - 1.5}" fill="none" stroke="#ffffff" stroke-width="3" opacity=".08"/>
  <g transform="translate(${tx} ${ty}) scale(${scale})">${markBody(file)}</g>
</svg>
`;
}

function render(variant: Variant, px: number, dest: string): void {
  execFileSync('rsvg-convert', ['-w', String(px), '-h', String(px), '-o', dest, path.join(TMP, `${variant}.svg`)]);
}

function main(): void {
  rmSync(TMP, { recursive: true, force: true });
  const iconset = path.join(TMP, 'icon.iconset');
  mkdirSync(iconset, { recursive: true });

  for (const v of Object.keys(VARIANTS) as Variant[]) {
    writeFileSync(path.join(TMP, `${v}.svg`), compose(v));
  }

  for (const [name, px] of ICONSET) {
    render(variantFor(px), px, path.join(iconset, name));
  }

  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(OUT, 'icon.icns')]);
  // electron-builder 在非 macOS 目标上要 png；顺带给 README / 站点用
  copyFileSync(path.join(iconset, 'icon_512x512@2x.png'), path.join(OUT, 'icon.png'));
  rmSync(TMP, { recursive: true, force: true });

  console.log('icons: build/icon.icns + build/icon.png');
}

main();
