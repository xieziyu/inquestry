import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * 这一份是不是正式渠道的包。
 *
 * 判据是 electron-builder 打包时写进去的 app-update.yml：只有走完整 target 的包才有它，
 * dev 与本地 `npm run package`（--dir）都没有。**只看 isPackaged 分不开本地包**——
 * 而两处要分的恰恰就是它：更新那边会因此常驻一行 ENOENT 红字（实测），
 * userData 那边则会让开发中的 schema 写进正式库。
 */
export function isReleaseChannel(): boolean {
  return app.isPackaged && existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}
