import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import investigationPrompt from '../backend/prompt/investigation.md?raw';
import { hydratePath, findClaudeExecutable } from '../backend/env/shell-path.js';
import { CaseRunner } from './case-runner.js';
import type { OperatorReply } from '../shared/ipc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let runner: CaseRunner | null = null;
let win: BrowserWindow | null = null;
let pushTimer: NodeJS.Timeout | null = null;

/** 事件密集时合流再推，否则一个 turn 能打出上千次 IPC（architecture.md）。 */
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    // broadcast 而非 reply-to-sender：第一阶段只有一个窗口，但多窗口时零成本
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('snapshot', runner?.snapshot());
    }
  }, 60);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(HERE, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload 只在关掉 sandbox 时才加载；开着 sandbox 会静默失败，
      // 表现是 window.inquestry 未定义、渲染进程一片黑
      sandbox: false,
    },
  });

  // 渲染进程的错误默认只留在它自己的 devtools 里，转发出来才看得见
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[renderer] load failed', code, desc));
  win.webContents.on('preload-error', (_e, file, err) => console.error('[preload]', file, err));

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(HERE, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
 try {
  // 必须在任何 spawn 之前：SDK 读的是 spawn 时刻的 PATH
  await hydratePath();

  const dbFile = path.join(app.getPath('userData'), 'inquestry.db');
  runner = new CaseRunner(dbFile, investigationPrompt, schedulePush);

  ipcMain.handle('env:check', () => ({
    claude: findClaudeExecutable(),
    hint: '“已装但未登录/凭据过期”只有真正发起会话才知道，届时会话会直接报 401。',
  }));
  ipcMain.handle('case:start', (_e, question: string) => runner!.start(question));
  ipcMain.handle('case:send', (_e, text: string) => runner!.send(text));
  ipcMain.handle('case:interrupt', () => runner!.interrupt());
  ipcMain.handle('case:answerOperator', (_e, reply: OperatorReply) => runner!.answerOperator(reply));
  ipcMain.handle('case:snapshot', () => runner!.snapshot());
  ipcMain.handle('case:excerpt', (_e, callId: string, anchor: string | null) => runner!.excerpt(callId, anchor));

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 开发期自检：无人值守跑一轮并截图，用于在没有人盯着屏幕时验证 UI
  if (process.env.INQUESTRY_SHOT) {
    const shots = process.env.INQUESTRY_SHOT.split(',');
    win?.webContents.once('did-finish-load', async () => {
      if (process.env.INQUESTRY_AUTOSTART) void runner!.start(process.env.INQUESTRY_AUTOSTART);
      for (const [i, spec] of shots.entries()) {
        const [file, delay] = spec.split('@');
        await new Promise((r) => setTimeout(r, Number(delay ?? 5000) - (i ? Number(shots[i - 1]!.split('@')[1] ?? 0) : 0)));
        const img = await win!.webContents.capturePage();
        await writeFile(file!, img.toPNG());
        console.log('[shot]', file);
      }
      if (process.env.INQUESTRY_SHOT_INCIDENT) {
        await win!.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('事故'))?.click()`,
        );
        await new Promise((r) => setTimeout(r, 400));
        await writeFile(process.env.INQUESTRY_SHOT_INCIDENT, (await win!.webContents.capturePage()).toPNG());
        console.log('[shot] incident');
      }
      if (process.env.INQUESTRY_SHOT_QUIT) app.quit();
    });

    // 无人值守时代替操作员回填，好让整条链路能自己跑完
    if (process.env.INQUESTRY_AUTO_OPERATOR) {
      setInterval(() => {
        for (const ask of runner!.snapshot().pending) {
          runner!.answerOperator({
            id: ask.id,
            statement: ask.statement,
            answer: ask.suggestedAnswer || '(操作员：这条没跑，换个写法)',
            executedAt: '2026-08-09 12:41:07 +08:00',
          });
        }
      }, 4000);
    }
  }
 } catch (err) {
   // 启动失败必须看得见：否则表现是「窗口没出来」，连日志都没有
   console.error('[main] 启动失败', err);
   createWindow();
   win?.webContents.once('did-finish-load', () => {
     win?.webContents.executeJavaScript(
       `document.body.innerHTML = '<pre style="padding:40px;color:#f0806c;font:13px monospace">启动失败：' + ${JSON.stringify(String((err as Error).stack ?? err))} + '</pre>'`,
     );
   });
 }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
