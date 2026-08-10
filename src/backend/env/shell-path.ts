import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 补齐 `process.env.PATH`，让 Finder / Dock 启动的 app 也能找到 `claude`。
 *
 * 终端里 `npm start` 起的进程继承终端 PATH，一切正常；但 launchd 拉起的 app 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，`claude` 一个都不在里面（本机装在 ~/.local/bin）。
 * 两层：登录 shell 问一次真实 PATH（覆盖 fnm / mise 这类版本管理器），再补常见安装位兜底。
 *
 * 必须在任何 spawn 之前 await 完 —— SDK 读的是 spawn 时刻的 process.env。
 */

const PROBE_TIMEOUT_MS = 3000;
const MARKER = '__inquestry_path__';

function fallbackDirs(): string[] {
  const home = os.homedir();
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.bun/bin')];
}

function probeLoginShell(): Promise<string | null> {
  const shell = process.env.SHELL;
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    // -i 是关键：zsh / bash 只有交互式才读 rc 文件，而版本管理器多半装在那里
    const child = execFile(
      shell,
      ['-ilc', `echo "${MARKER}:$PATH:${MARKER}"`],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        resolve(stdout.match(new RegExp(`${MARKER}:(.*?):${MARKER}`, 's'))?.[1] ?? null);
      },
    );
    child.stdin?.end();
  });
}

export async function hydratePath(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const fromShell = await probeLoginShell();
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [process.env.PATH ?? '', fromShell ?? '', ...fallbackDirs().filter(existsSync)]
    .flatMap((s) => s.split(path.delimiter))) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  process.env.PATH = merged.join(path.delimiter);
}

/** 环境检查：装了没、能不能跑。「已装但未登录」要等真正发起会话才知道（architecture.md）。 */
export function findClaudeExecutable(): string | null {
  const candidates = [
    ...(process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, 'claude')),
    path.join(os.homedir(), '.local/bin/claude'),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}
