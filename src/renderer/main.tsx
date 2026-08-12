import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ExportImage } from './ExportImage.js';
import './styles.css';

/**
 * 同一个 renderer 有两个入口：调查台 / 报告屏那一套，和长图的渲染视图（ui.md §7.2）。
 * 后者跑在 main 开的离屏窗口里，人看不到——它与报告屏共用数据与样式，只换外壳。
 */
const params = new URLSearchParams(location.search);
const token = params.get('token');

createRoot(document.getElementById('root')!).render(
  params.get('export') === 'image' && token ? <ExportImage token={token} /> : <App />,
);
