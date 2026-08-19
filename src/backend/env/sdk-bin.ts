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
  if (cached === undefined) cached = resolve();
  return cached ?? undefined;
}

function resolve(): string | null {
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
