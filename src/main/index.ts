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
  type ExportResult,
  type GateDecision,
  type IntakeDraft,
  type IntakeOptions,
  type IntakeResult,
  type OperatorReply,
  type Snapshot,
  type VerdictShape,
} from '../shared/ipc.js';
import { reportMarkdown } from '../shared/markdown.js';
import { reportInput } from '../shared/report.js';

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

/**
 * 导出 Markdown（D26 / ui.md §7.1）。
 *
 * **带 caseId 核对**（`currentIf`）：切过去之后 current 是新案子，旧界面那一下的点击
 * 会导出另一个案子的内容，而文件名是按当前案子起的——一份没人会察觉搞错了的交付物。
 *
 * `target` 只给无人值守自检用（`INQUESTRY_EXPORT_MD`）：给了就直接写，不弹保存框。
 */
async function exportMarkdown(caseId: string, target?: string): Promise<ExportResult> {
  const runner = cases.currentIf(caseId);
  if (!runner) return { ok: false, reason: 'no-case', error: '这个案子不在手上，可能刚切走了。' };
  const input = reportInput(runner.snapshot());
  // 立案单读不出来就没有报告可导。**说出来**，别写一个只有页脚的空文件
  if (!input) return { ok: false, reason: 'no-case', error: '这个案子还没有立案单，导不出报告。' };

  const md = reportMarkdown(input, { generatedAt: Date.now() });
  let file = target ?? null;
  if (!file) {
    const r = await dialog.showSaveDialog(win!, {
      title: '导出 Markdown',
      defaultPath: path.join(app.getPath('downloads'), `${fileStem(input.case.title, caseId)}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    file = r.filePath;
  }

  try {
    await writeFile(file, md, 'utf8');
    return { ok: true, path: file };
  } catch (err) {
    // 写盘失败必须回到界面上：静默失败的表现是"按了导出、什么都没发生"，
    // 而人以为报告已经存下来了
    return { ok: false, reason: 'failed', error: String((err as Error).message ?? err) };
  }
}

/** 文件名取标题，路径分隔符与控制字符一律换掉；带上 caseId 好让同名的两个案子分得开。 */
function fileStem(title: string, caseId: string): string {
  const safe = title.replace(/[/\\:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${safe.slice(0, 40) || 'inquestry'} ${caseId}`;
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
  // 开发期自检用 `INQUESTRY_EXPORT_MD` 指定落点，好让界面那一下不卡在保存框上
  ipcMain.handle('case:exportMarkdown', (_e, caseId: string) =>
    exportMarkdown(caseId, process.env.INQUESTRY_EXPORT_MD),
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
  // 三个开关任一存在就挂这段自检：导出那条兜底不该依赖一个跟它无关的截图变量
  // （只设 `INQUESTRY_EXPORT_MD` 时它压根不会跑，而日志与文档都说它跑了）
  if (process.env.INQUESTRY_SHOT || process.env.INQUESTRY_SHOT_REPORT || process.env.INQUESTRY_EXPORT_MD) {
    const shots = process.env.INQUESTRY_SHOT ? process.env.INQUESTRY_SHOT.split(',') : [];
    win?.webContents.once('did-finish-load', async () => {
     try {
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
        // **先等界面到位再摸它**：单独设这个变量时（不带 INQUESTRY_SHOT）这里是
        // `did-finish-load` 后第一件事，比第一份快照还早——报告屏与 .toreport
        // 谁都还没画出来。不等的话表现是"进不去报告屏"，而两者只是还没渲染出来
        const ready: string = await win!.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 50; i += 1) {
            if (document.querySelector('.reportscreen')) return 'here';
            if (document.querySelector('.toreport')) return 'toreport';
            await new Promise((r) => setTimeout(r, 200));
          }
          return 'none';
        })()`);
        if (ready === 'none') throw new Error('[shot] 进不去报告屏：等了 10s，既没有报告屏也没找到 .toreport');
        // 先留一帧点击前的：**固定等一会儿再拍是不够的**——实测点进报告屏后 400ms 拍到的
        // 与点击前那一张字节完全相同（§11 的过期帧）。等到画面真的变了才算拍到，
        // 等不到就抛；否则文件名和日志都说这是报告，而里面是调查台
        const before = (await win!.webContents.capturePage()).toPNG();
        // 收尾之后界面会自己翻到报告屏（§9.11），那时不用点
        if (ready === 'toreport') {
          await win!.webContents.executeJavaScript(`document.querySelector('.toreport').click()`);
        }
        let after: Buffer | null = ready === 'here' ? before : null;
        for (let i = 0; i < 10 && !after; i += 1) {
          await new Promise((r) => setTimeout(r, 400));
          const png = (await win!.webContents.capturePage()).toPNG();
          if (!png.equals(before)) after = png;
        }
        if (!after) throw new Error('[shot] 报告屏拍到的还是点击前那一帧（capturePage 过期帧，见 ui.md §11）');
        await writeFile(process.env.INQUESTRY_SHOT_REPORT, after);
        console.log('[shot] report');
      }
      // 导出这条链路在真 app 里才跑得到，且**要从界面按钮按下去**：
      // renderer → preload → main → 写盘 → 回执。直接调 main 那个函数验不到回执，
      // 而"按了导出、什么都没发生"正是这条路最容易的失效方式。
      // 纯函数那一侧（章节与渲染）由 spike:markdown 兜着。**失败要抛**
      if (process.env.INQUESTRY_EXPORT_MD) {
        // **等界面到位再点**：`did-finish-load` 比第一份快照早，那一刻连顶栏都还没有。
        // 不等的话表现是"报告屏上没有导出按钮"，而按钮只是还没画出来
        const receipt: string | null = await win!.webContents.executeJavaScript(`(async () => {
          const wait = async (sel) => {
            for (let i = 0; i < 50; i += 1) {
              const el = document.querySelector(sel);
              if (el) return el;
              await new Promise((r) => setTimeout(r, 200));
            }
            return null;
          };
          if (!document.querySelector('.exportmd')) {
            // 库里只剩冻结的案子时启动会停在立案面板（启动只恢复 open 的那种），
            // 那时切换栏上还有它 —— 点进去，这也正是人会做的动作
            if (!document.querySelector('.toreport')) {
              const chip = await wait('.casebar .chip:not(.new)');
              if (!chip) return null;
              chip.click();
            }
            const enter = await wait('.toreport');
            if (!enter) return null;
            enter.click();
          }
          const btn = await wait('.exportmd');
          if (!btn) return null;
          btn.click();
          const line = await wait('.exported');
          return line ? line.textContent : '';
        })()`);
        if (receipt === null) throw new Error('[export] 进不去报告屏，或那儿没有导出按钮');
        if (!receipt.startsWith('已导出到')) throw new Error(`[export] 界面没给出成功回执：${receipt}`);
        // 回执说成功、盘上却没有东西，是这条链路唯一还骗得过人的失败方式
        if (!statSync(process.env.INQUESTRY_EXPORT_MD).size) throw new Error('[export] 落盘的是个空文件');
        console.log('[export]', receipt);
      }
      if (process.env.INQUESTRY_SHOT_QUIT) app.quit();
     } catch (err) {
       // 这个 handler 里抛出去的异常没人接：表现是无人值守跑干等到超时，一行日志都没有。
       // **失败必须无条件非零退出**——INQUESTRY_SHOT_QUIT 只管"成功之后要不要自动退出"，
       // 不该顺带决定"失败要不要退出"，否则单独设 INQUESTRY_EXPORT_MD 跑失败时进程会
       // 一直挂着，调用方拿不到能判定失败的退出码
       console.error('[shot] 自检失败', err);
       app.exit(1);
     }
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
