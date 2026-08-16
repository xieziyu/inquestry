import { defineConfig } from 'vite';
import path from 'node:path';

/**
 * 官网（GitHub Pages）。独立于 renderer 那套构建：不进 Electron、不需要 React，
 * 但 `site/main.js` **直接 import 应用的 `styles.css` 与 `logo.ts`**——
 * 站点上出现的工作区部件因此跟着应用一起改，不会退化成手抄的第二份。
 *
 * ⚠️ **root 是 `site/`，而被 import 的那几份在它外面**。dev server 靠 vite 默认的
 * `server.fs.allow`（认到仓库根）才放行；把 root 往下挪或改 allow 的话，
 * 表现是 dev 起得来但样式 404，而页面只是"长得不对"，不报错。
 */
export default defineConfig({
  root: path.resolve(__dirname, 'site'),
  // 部署在 https://<user>.github.io/inquestry/ 下，资源必须带仓库名前缀；
  // 换自定义域名时把这里改回 '/'。
  base: '/inquestry/',
  build: {
    outDir: path.resolve(__dirname, 'site/dist'),
    emptyOutDir: true,
  },
});
