import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import investigationPrompt from '../backend/prompt/investigation.md?raw';
import { BACKENDS, loadModelOptions } from '../backend/agent/capabilities.js';
import { DEMO_INCIDENT_DATE, DEMO_QUESTION } from '../backend/datasource/demo.js';
import { blobDir, openDatabase, type Db } from '../backend/db/database.js';
import { readIntake, sweepZombies } from '../backend/store/sqlite-store.js';
import { localTzOffset, todayLocal, tzOffsetOn } from '../shared/time.js';
import { hydratePath, findClaudeExecutable } from '../backend/env/shell-path.js';
import { CaseRegistry } from './case-registry.js';
import { CaseRunner } from './case-runner.js';
import {
  EMPTY_SNAPSHOT,
  type AgentChoice,
  type GateDecision,
  type IntakeDraft,
  type IntakeOptions,
  type IntakeResult,
  type OperatorReply,
  type Snapshot,
  type VerdictShape,
} from '../shared/ipc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECENT_ROOTS_KEY = 'intake.recent_roots';
const MODEL_CACHE_KEY = 'agent.models';

let db: Db;
let blobs: string;
let cases: CaseRegistry<CaseRunner>;
let win: BrowserWindow | null = null;
let pushTimer: NodeJS.Timeout | null = null;

/** 事件密集时合流再推，否则一个 turn 能打出上千次 IPC（architecture.md）。 */
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    // 案子是在真的开跑那一刻才 spawn 出进程的，光在切换时查限流会漏掉
    cases.enforceLimit();
    // broadcast 而非 reply-to-sender：第一阶段只有一个窗口，但多窗口时零成本
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('snapshot', snapshot());
    }
  }, 60);
}

/** 当前案子的投影 + 全部案子的概览。后者哪个案子在看都得有，否则别处的待办没人看得见。 */
function snapshot(): Snapshot {
  const briefs = cases.briefs();
  return cases.current?.snapshot(briefs) ?? { ...EMPTY_SNAPSHOT, cases: briefs };
}

/** 当前案子；正在立新案时为空，这时除了立案什么都点不到。 */
const current = () => cases.current;

function setting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM ui_settings WHERE key=?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function putSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO ui_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, value);
}

function recentRoots(): string[] {
  try {
    const v = JSON.parse(setting(RECENT_ROOTS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 案子的 UI 侧状态。这里放的是「立案时选的 agent」——它还没有 session 可落，
 * 但立完案不开跑就退出是常事，不存的话重开会静默换成默认模型，
 * 顶栏和之后真正建的 session 都不再是人选的那套。
 */
function readCaseUi(caseId: string): { agent?: AgentChoice } {
  try {
    const row = db.prepare(`SELECT value FROM case_ui_state WHERE case_id=?`).get(caseId) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

function writeCaseUi(caseId: string, patch: { agent?: AgentChoice }) {
  const next = JSON.stringify({ ...readCaseUi(caseId), ...patch });
  db.prepare(
    `INSERT INTO case_ui_state (case_id,value) VALUES (?,?)
     ON CONFLICT(case_id) DO UPDATE SET value=excluded.value`,
  ).run(caseId, next);
}

function rememberRoot(root: string | null) {
  if (!root) return;
  putSetting(RECENT_ROOTS_KEY, JSON.stringify([root, ...recentRoots().filter((r) => r !== root)].slice(0, 8)));
}

/**
 * 立案：新开一个 case，它下面的第一个 session 要到点「开始排查」才开。
 *
 * **不动别的案子**（D28）：手上那个可能正跑着，或者正卡在待办上等人。
 */
function createCase(draft: IntakeDraft): IntakeResult {
  const question = draft.question.trim();
  const root = checkProjectRoot(draft.projectRoot);
  if ('error' in root) return { ok: false, field: 'projectRoot', error: root.error };

  rememberRoot(root.path);
  const caseId = `case_${randomUUID().slice(0, 8)}`;
  cases.adopt(
    caseId,
    new CaseRunner({
      db,
      blobDir: blobs,
      promptText: investigationPrompt,
      caseId,
      intake: {
        title: titleOf(question),
        question,
        projectRoot: root.path,
        incidentDate: draft.incidentDate,
        // 时区不由用户填，取立案机器的偏移落库定死；**按事故那天算**，
        // 不是按此刻——有夏令时的地区冬夏差一小时（见 shared/time.ts）
        tzOffset: tzOffsetOn(draft.incidentDate),
        clues: draft.clues?.trim() || null,
      },
      agent: draft.agent,
      onChange: schedulePush,
    }),
  );
  writeCaseUi(caseId, { agent: draft.agent });
  schedulePush();
  return { ok: true };
}

/** 按库里的立案单重建一个案子的运行时。库里没有这个 id 就返回 null（切换栏会拒绝切过去）。 */
function loadCase(caseId: string): CaseRunner | null {
  const intake = readIntake(db, caseId);
  if (!intake) return null;
  return new CaseRunner({
    db,
    blobDir: blobs,
    promptText: investigationPrompt,
    caseId,
    intake,
    agent: lastAgentChoice(caseId),
    onChange: schedulePush,
  });
}

/**
 * 项目起点要在立案之前验：它随后就是 SDK 的 `cwd`。
 * 不验的话路径不存在也能立案成功，直到点「开始排查」才由 query 抛错、会话直接 crashed，
 * 而那时坏路径已经进了最近目录列表。
 */
function checkProjectRoot(input: string | null): { path: string | null } | { error: string } {
  const p = input?.trim();
  if (!p) return { path: null };
  const resolved = p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
  // 相对路径要按 main 进程的 cwd 解释，打包后那是个说不准的目录 —— 与其猜不如让人看见
  if (!path.isAbsolute(resolved)) return { error: `请给绝对路径（${p}）` };
  try {
    if (!statSync(resolved).isDirectory()) return { error: `${resolved} 不是目录` };
    accessSync(resolved, constants.R_OK | constants.X_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { error: code === 'ENOENT' ? `找不到 ${resolved}` : `读不了 ${resolved}（${code ?? err}）` };
  }
  return { path: resolved };
}

/** 重开最近一个未结案的 case：一次事故跨多会话，重启只是它下面又开了一个 session。 */
function restoreLatestCase() {
  const row = db
    .prepare(`SELECT id FROM cases WHERE status='open' ORDER BY updated_at DESC LIMIT 1`)
    .get() as { id: string } | undefined;
  if (row) cases.switchTo(row.id);
}

/** 上次跑用的那套；没跑过就用立案时选的。中途换模型是常态，所以最近一次优先。 */
function lastAgentChoice(caseId: string): AgentChoice {
  const last = db
    .prepare(`SELECT backend, model, effort FROM sessions WHERE case_id=? ORDER BY started_at DESC LIMIT 1`)
    .get(caseId) as { backend: 'claude' | 'codex'; model: string | null; effort: string | null } | undefined;
  if (last) return { backend: last.backend, model: last.model, effort: last.effort };
  return readCaseUi(caseId).agent ?? { backend: 'claude', model: null, effort: null };
}

/** 切换栏上的短标签：问题的第一行，长了截断。 */
function titleOf(question: string): string {
  const first = question.split('\n').find((l) => l.trim())?.trim() ?? '未命名案件';
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

async function intakeOptions(): Promise<IntakeOptions> {
  const { models, probed } = await loadModelOptions({
    read: () => setting(MODEL_CACHE_KEY),
    write: (v) => putSetting(MODEL_CACHE_KEY, v),
  });
  return {
    backends: BACKENDS,
    models,
    modelsProbed: probed,
    recentRoots: recentRoots(),
    defaults: { incidentDate: todayLocal(), tzOffset: localTzOffset() },
    demo: { question: DEMO_QUESTION, incidentDate: DEMO_INCIDENT_DATE },
  };
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
  db = openDatabase(dbFile);
  blobs = blobDir(dbFile);
  // **必须赶在任何 runner 建起来之前**：此刻库里所有 pending 的调用与 live 的会话
  // 都必然是上一个进程留下的（进程一走，等着人回答的 Promise 也就没了）。
  // 建完 runner 再扫就会把这一轮自己的活计一起判成放弃
  const swept = sweepZombies(db, { blobDir: blobs, now: () => Date.now() });
  if (swept.calls || swept.sessions) console.log('[main] 清扫上次遗留', swept);
  cases = new CaseRegistry<CaseRunner>({ db, create: loadCase });
  restoreLatestCase();

  ipcMain.handle('env:check', () => ({
    claude: findClaudeExecutable(),
    hint: '“已装但未登录/凭据过期”只有真正发起会话才知道，届时会话会直接报 401。',
  }));
  ipcMain.handle('intake:options', () => intakeOptions());
  ipcMain.handle('intake:pickRoot', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择项目起点' });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('case:create', (_e, draft: IntakeDraft) => createCase(draft));
  ipcMain.handle('case:switch', (_e, caseId: string) => {
    cases.switchTo(caseId);
    schedulePush();
  });
  ipcMain.handle('case:new', () => {
    cases.toIntake();
    schedulePush();
  });
  // 下面这些都依赖「当前案子」，一律判空不用 `!`：点「＋ 新案件」的那一刻 currentId 就是
  // null 了，而 renderer 要等下一次快照（最多 60ms）才换屏——这中间旧界面照样发得出调用。
  // 用非空断言的话那一下是个 TypeError，invoke 变成未处理的 rejection，
  // 用户那侧只看到输入框被清空、内容没了
  // 这四个还要核对 renderer 说的是哪个案子（`currentIf`）：光判空不够，
  // 切过去之后 current 是**新**案子，旧界面那一下会正正好落到它头上
  ipcMain.handle('case:start', (_e, caseId: string, question?: string) =>
    cases.currentIf(caseId)?.start(question),
  );
  ipcMain.handle('case:restart', (_e, caseId: string) => cases.currentIf(caseId)?.restart());
  // 唯一要回执的一个：送没送出去，renderer 据此决定草稿该不该清
  ipcMain.handle('case:send', async (_e, caseId: string, text: string) => {
    const runner = cases.currentIf(caseId);
    return runner ? runner.send(text) : false;
  });
  ipcMain.handle('case:interrupt', (_e, caseId: string) => cases.currentIf(caseId)?.interrupt());
  // 收尾后两档（D29）。问询与执行是两个入口：合成一个的话，界面就得靠 60ms 前的快照
  // 决定"这一下是问还是执行"，而隔着那一拍点下去的会是不可逆的结案
  // 对不上就回 null，不回一个「什么都不缺」的空壳：后者会让界面弹出确认条，
  // 而那个案子根本不在手上——人对着一份已经切走的案子按下不可逆的那一下
  ipcMain.handle(
    'case:requestClosing',
    (_e, caseId: string) => cases.currentIf(caseId)?.requestClosing() ?? null,
  );
  // 不成立时差的那两步要原样回给界面，不然人只看到按钮没反应
  ipcMain.handle(
    'case:close',
    (_e, caseId: string, shape: VerdictShape) =>
      cases.currentIf(caseId)?.closeCase(shape) ?? { ok: false, missing: [] },
  );
  ipcMain.handle('case:archive', (_e, caseId: string) => {
    const runner = cases.currentIf(caseId);
    if (!runner) return false;
    runner.archiveCase();
    schedulePush();
    return true;
  });
  ipcMain.handle('case:answerOperator', (_e, caseId: string, reply: OperatorReply) =>
    cases.currentIf(caseId)?.answerOperator(reply) ?? false,
  );
  ipcMain.handle('case:decideGate', (_e, caseId: string, d: GateDecision) =>
    cases.currentIf(caseId)?.decideGate(d) ?? false,
  );
  ipcMain.handle('case:snapshot', () => snapshot());
  ipcMain.handle('case:excerpt', (_e, callId: string, anchor: string | null) =>
    current()?.excerpt(callId, anchor) ?? '(没有选中的案子)',
  );

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('before-quit', () => cases.closeAll());

  // 开发期自检：无人值守跑一轮并截图，用于在没有人盯着屏幕时验证 UI
  if (process.env.INQUESTRY_SHOT) {
    const shots = process.env.INQUESTRY_SHOT.split(',');
    win?.webContents.once('did-finish-load', async () => {
      if (process.env.INQUESTRY_AUTOSTART) {
        // 无人值守时替人立一次案，好让整条链路能自己跑完
        createCase({
          projectRoot: null,
          question: process.env.INQUESTRY_AUTOSTART,
          incidentDate: DEMO_INCIDENT_DATE,
          clues: null,
          agent: { backend: 'claude', model: null, effort: null },
        });
        void current()?.start();
      }
      for (const [i, spec] of shots.entries()) {
        const [file, delay] = spec.split('@');
        await new Promise((r) => setTimeout(r, Number(delay ?? 5000) - (i ? Number(shots[i - 1]!.split('@')[1] ?? 0) : 0)));
        const img = await win!.webContents.capturePage();
        await writeFile(file!, img.toPNG());
        console.log('[shot]', file);
      }
      // 事故时间线现在属于报告屏（D21），拍它就是拍报告。
      // **点不到入口要出声**：`?.click()` 静默跳过的话，拍出来的是调查台，
      // 而文件名与日志都说这是报告——一张认错了的截图比没有更糟
      if (process.env.INQUESTRY_SHOT_REPORT) {
        const opened = await win!.webContents.executeJavaScript(
          `!!document.querySelector('.toreport') && (document.querySelector('.toreport').click(), true)`,
        );
        if (!opened) throw new Error('[shot] 进不去报告屏：没找到 .toreport');
        await new Promise((r) => setTimeout(r, 400));
        await writeFile(process.env.INQUESTRY_SHOT_REPORT, (await win!.webContents.capturePage()).toPNG());
        console.log('[shot] report');
      }
      if (process.env.INQUESTRY_SHOT_QUIT) app.quit();
    });

    // 无人值守时代替操作员回填。闸门也要一起放行：否则跑到第一个 ②档就停在那儿，
    // 而它三分钟后才自动放行，截图早就拍完了
    if (process.env.INQUESTRY_AUTO_OPERATOR) {
      setInterval(() => {
        const runner = current();
        if (!runner) return;
        for (const gate of snapshot().gates) runner.decideGate({ id: gate.id, action: 'allow' });
        for (const ask of snapshot().pending) {
          runner.answerOperator({
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
