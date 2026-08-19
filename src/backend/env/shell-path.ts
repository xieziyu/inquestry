import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 补齐 `process.env.PATH`，**为的是 agent 手里的 Bash 工具**：CLI 是 app 自带的
 * （见 `sdk-bin.ts`），但它跑起来之后要调的 git / kubectl / mise 装的那一套，
 * 全靠这份 PATH 找。
 *
 * 终端里起的进程继承终端 PATH，一切正常；launchd 拉起的 app 只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，于是同一条命令在终端里跑得通、在 app 里 not found。
 * 两层：登录 shell 问一次真实 PATH（覆盖 fnm / mise 这类版本管理器），再补常见安装位兜底。
 *
 * 必须在任何 spawn 之前 await 完 —— 子进程拿的是 spawn 时刻的 process.env。
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
