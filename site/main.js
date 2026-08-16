/**
 * 官网入口。
 *
 * 🔴 **卡片、待办、闸门这些部件的样式不在这儿，也不许在 landing.css 里另抄一份**——
 * 直接 import 应用那份 `styles.css`，站点上出现的工作区部件因此跟着应用一起改。
 * landing.css 只管站点自己的外壳（导航、hero、时间轴、滚动动效）与少量落位覆写。
 */
import '../src/renderer/styles.css';
import './landing.css';
// 标记的几何与调色同应用的 LogoMark 走同一份（`logo.ts` 不带 React，所以这儿也能读）
import { markInner, tierFor } from '../src/renderer/logo.js';
// 仓库 / 作者的唯一出处同样是应用里那份，别在页面上再抄一遍地址
import { PROJECT_LINKS } from '../src/shared/links.js';

// releases 与仓库内的路径由这儿现拼——links.ts 只收口"项目在哪"
const LINKS = {
  ...PROJECT_LINKS,
  releases: `${PROJECT_LINKS.repo}/releases/latest`,
  issues: `${PROJECT_LINKS.repo}/issues/new`,
  changelog: `${PROJECT_LINKS.repo}/blob/main/CHANGELOG.md`,
  license: `${PROJECT_LINKS.repo}/blob/main/LICENSE`,
};
document.querySelectorAll('[data-link]').forEach((a) => {
  const href = LINKS[a.dataset.link];
  if (!href) return;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer';
});
document.getElementById('year').textContent = String(new Date().getFullYear());

document.querySelectorAll('.mark').forEach((svg, i) => {
  svg.innerHTML = markInner(tierFor(Number(svg.getAttribute('width'))), `lp${i}`);
});

const track = document.getElementById('track');
const spine = document.getElementById('spine');
const fill = document.getElementById('spineFill');
const stops = [...document.querySelectorAll('.lp-stop')];
const nav = document.getElementById('nav');

/**
 * 两条判定线，各管一件事：
 *
 * - `.in`（节点亮 + 卡片落）看**线头走到没有**，取 68vh——卡片上沿刚过屏幕下三分之一才落。
 * - `.settled`（直角连线走出去 + 右边那块摊开）看这一节**停稳没有**：卡片中线落在视口中带里。
 *
 * 🔴 两件事不许合成一件。合了之后快速滑过时右边会一路闪，而它本来就是"停下来才给你看"
 * 的东西——这一段的整个意思就在那个停顿上。
 *
 * ⚠️ 中带的宽度跟着 `.lp-stop` 的高度走：两节间距只有 64vh，带宽再往上给，
 * 上下两节会同时算停稳，右边两块一起摊开。
 */
const SETTLE_BAND = 0.3;

function update() {
  const r = track.getBoundingClientRect();
  const line = innerHeight * 0.68;
  const y = Math.max(0, Math.min(r.height, line - r.top));
  fill.style.height = `${y}px`;
  spine.style.setProperty('--headY', `${y}px`);
  // 线头只在轨道里露面，走完最后一节就收掉
  spine.style.setProperty('--headOn', y > 4 && y < r.height - 4 ? 1 : 0);

  const mid = innerHeight / 2;
  for (const s of stops) {
    const c = s.querySelector('.lp-card').getBoundingClientRect();
    s.classList.toggle('in', c.top <= line);
    s.classList.toggle('settled', Math.abs(c.top + c.height / 2 - mid) < innerHeight * SETTLE_BAND);
  }
  nav.classList.toggle('stuck', scrollY > 20);
}

// 直接在 scroll 里跑：浏览器本来就把 scroll 合并到每帧最多一次，而 update() 只读几个 rect。
// 用 rAF 再包一层反而会在后台标签页里被挂起——那时 rAF 不派发，"已排队"的标志位再也清不掉，
// 整条驱动就静默死了。
addEventListener('scroll', update, { passive: true });
addEventListener('resize', update);
update();
