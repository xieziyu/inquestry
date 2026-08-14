import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * 只开 origin（`open http://localhost:5178`、浏览器预览面板）拿到的会是 Electron 那份
 * `index.html`——那里没有 preload 注入的 `window.inquestry`，只剩白屏。所以把 / 送到预览入口。
 */
function previewEntry(): Plugin {
  return {
    name: 'inquestry-preview-entry',
    apply: 'serve',
    configureServer(server) {
      // 在 configureServer 里直接 use 会插到 vite 内置中间件之前，先于 html 处理拦下 /
      server.middlewares.use((req, res, next) => {
        const [pathname, query] = (req.url ?? '/').split('?');
        if (pathname !== '/' && pathname !== '/index.html') return next();
        // 302 而不是内部 rewrite：地址栏留下 /preview.html，顺带把 ?screen= 带过去
        res.writeHead(302, { Location: `/preview.html${query ? `?${query}` : ''}` });
        res.end();
      });
    },
  };
}

/**
 * ⚠️ **root 是仓库根，不是 `src/renderer`**（`electron.vite.config.ts` 里是后者）：
 * 预览夹具借的是 `scripts/fixtures/report-case.ts`，那份在 renderer 目录之外，
 * root 设成 renderer 的话 vite 会以"越界"为由拒绝提供它。
 */
export default defineConfig({ root: '.', plugins: [react(), previewEntry()] });
