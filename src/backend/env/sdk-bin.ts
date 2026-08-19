import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * SDK 自带的那个 CLI 二进制，取 asar 外的实路径 —— **每个 `query()` 都要传**。
 *
 * 不传的话 SDK 自己去 resolve `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`
 * 再 spawn，开发时对，打包后必错：那条路径落在 app.asar 里，而 Electron 只给
 * `child_process.execFile` 补了 asar → unpacked 的转写，`spawn` 没有。
 * 表现是 `spawn ENOTDIR`（0.1.0 就是这么发出去的）：新建面板问不到模型、调查一起就挂，
 * 而错在打包产物里，开发和 spike 一路全绿。
 */

const require = createRequire(import.meta.url);

let cached: string | null | undefined;

/** 解析失败回 undefined，交回 SDK 自己那条路 —— 它的报错比这儿编一句更说得清。 */
export function sdkClaudeExecutable(): string | undefined {
  if (cached === undefined) cached = locate();
  return cached ?? undefined;
}

function locate(): string | null {
  let p: string;
  try {
    p = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  } catch {
    return null;
  }
  // asarUnpack 把它解到了归档旁边（electron-builder 认得出可执行文件，自动加的这条）
  const unpacked = p.replace(`.asar${path.sep}`, `.asar.unpacked${path.sep}`);
  return unpacked !== p && existsSync(unpacked) ? unpacked : p;
}

/**
 * 自带 CLI 说自己登没登录。**`null` 是「问不出来」，与「没登录」不是一回事** ——
 * 合成一个 boolean 的话，探测本身出错会在界面上变成一句斩钉截铁的「未登录」。
 *
 * 凭据不在 app 这边，也不一定落在文件里（macOS 上在 keychain），所以只能问它，
 * 别自己去猜某个路径存不存在。
 */
export type ClaudeAuth = { loggedIn: boolean; email: string | null };

const AUTH_TIMEOUT_MS = 8000;

export function claudeAuthStatus(): Promise<ClaudeAuth | null> {
  const bin = sdkClaudeExecutable();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    // 没登录时它**退 1 而 stdout 照样是那份 JSON**，所以只看退出码会把「已知没登录」
    // 错判成「问不出来」，横幅就再也不出了
    execFile(bin, ['auth', 'status', '--json'], { timeout: AUTH_TIMEOUT_MS }, (_err, stdout) => {
      try {
        const v = JSON.parse(stdout) as { loggedIn?: boolean; email?: string };
        resolve(typeof v.loggedIn === 'boolean' ? { loggedIn: v.loggedIn, email: v.email ?? null } : null);
      } catch {
        resolve(null);
      }
    });
  });
}
