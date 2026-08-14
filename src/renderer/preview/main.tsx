/**
 * 浏览器预览入口（ui.md §11）：先把假的 `window.inquestry` 装上，再挂真的 `App`。
 *
 *   npm run preview:ui   →   http://localhost:5178/preview.html
 *
 * 用的是**真组件 + 真 CSS**，改一行样式浏览器里立刻看得到，不必等 electron-vite 重启。
 * 代价写在 ui.md §11：这里没有 main 进程，凡是"存下来了没有""重启后还在不在"
 * 一律证明不了，那几条仍然只能在真 app 里验。
 */
import { createRoot } from 'react-dom/client';
import { App } from '../App.js';
import type { Screen } from '../Rail.js';
import { installPreviewApi } from './fixtures.js';
import '../styles.css';

installPreviewApi();

const SCREENS: Screen[] = ['home', 'workspace', 'history', 'settings'];
const asked = new URLSearchParams(location.search).get('screen');
const screen = SCREENS.find((s) => s === asked);

createRoot(document.getElementById('root')!).render(<App initialScreen={screen} />);
