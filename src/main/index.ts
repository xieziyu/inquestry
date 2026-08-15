import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import investigationPrompt from '../backend/prompt/investigation.md?raw';
import { BACKENDS, loadModelOptions } from '../backend/agent/capabilities.js';
import { blobDir, openDatabase, type Db } from '../backend/db/database.js';
import { readIntake, renameCase, sweepZombies } from '../backend/store/sqlite-store.js';
import { casePage } from '../backend/db/queries.js';
import { exportStamp, localTzOffset, todayLocal } from '../shared/time.js';
import { hydratePath, findClaudeExecutable } from '../backend/env/shell-path.js';
import { proposeCaseTitle } from './case-namer.js';
import { CaseRegistry } from './case-registry.js';
import { applyTakeover, CaseRunner } from './case-runner.js';
import {
  EMPTY_SNAPSHOT,
  type AgentChoice,
  type AppInfo,
  type CaseListPage,
  type CaseListQuery,
  type ExportPayload,
  type ExportResult,
  type GateDecision,
  type IntakeDraft,
  type IntakeOptions,
  type IntakeResult,
  type OperatorReply,
  type Snapshot,
  type TakeoverResult,
  type VerdictShape,
} from '../shared/ipc.js';
import { normalizeSettings, type UiSettings } from '../shared/settings.js';
import { reportMarkdown } from '../shared/markdown.js';
import { pageFile } from '../shared/paging.js';
import { reportInput } from '../shared/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECENT_ROOTS_KEY = 'intake.recent_roots';
const MODEL_CACHE_KEY = 'agent.models';
const SETTINGS_KEY = 'app.settings';

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
    // 调查是在真的开跑那一刻才 spawn 出进程的，光在切换时查限流会漏掉
    cases.enforceLimit();
    // broadcast 而非 reply-to-sender：第一阶段只有一个窗口，但多窗口时零成本
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('snapshot', snapshot());
    }
  }, 60);
}

/** 当前调查的投影 + 全部调查的概览。后者哪个调查在看都得有，否则别处的待办没人看得见。 */
function snapshot(): Snapshot {
  const briefs = cases.briefs();
  return cases.current?.snapshot(briefs) ?? { ...EMPTY_SNAPSHOT, cases: briefs };
}

/** 当前调查；正在立新案时为空，这时除了新建调查什么都点不到。 */
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

/**
 * 应用级设置的读侧。**每次读都过一遍 `normalizeSettings`**，不缓存一份在内存里：
 * 库里那份可能是上个版本写的、也可能被人手改坏了，而"读到一个越界值"的后果
 * （闸门 0 秒、在跑上限 0）全都是安静地不工作。
 */
function settings(): UiSettings {
  try {
    return normalizeSettings(JSON.parse(setting(SETTINGS_KEY) ?? '{}'));
  } catch {
    return normalizeSettings({});
  }
}

/**
 * 存设置并**当场把它铺到运行时上**。
 *
 * 这一步最容易漏：只写库的话，改完的上限要到下次启动才生效，而界面上那个数字
 * 看起来已经改好了。限流是唯一一个"存起来还不够"的——闸门那个每次挂闸门时现取，
 * 新建调查的默认值也是下次打开面板时现读，只有它活在 registry 的字段里。
 */
function saveSettings(patch: UiSettings): UiSettings {
  const next = normalizeSettings(patch);
  putSetting(SETTINGS_KEY, JSON.stringify(next));
  cases.setLimits({ maxLive: next.limits.maxLiveCases, maxLoaded: next.limits.maxLoadedCases });
  schedulePush();
  return next;
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
 * 调查的 UI 侧状态。这里放的是「新建调查时选的 agent」——它还没有 session 可落，
 * 但建完单不开跑就退出是常事，不存的话重开会静默换成默认模型，
 * 顶栏和之后真正建的 session 都不再是人选的那套。
 */
function readCaseUi(caseId: string): { agent?: AgentChoice; takeover?: boolean } {
  try {
    const row = db.prepare(`SELECT value FROM case_ui_state WHERE case_id=?`).get(caseId) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

function writeCaseUi(caseId: string, patch: { agent?: AgentChoice; takeover?: boolean }) {
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
 * 新建调查：新开一个 case，它下面的第一个 session 要到点「开始排查」才开。
 *
 * **不动别的调查**（D28）：手上那个可能正跑着，或者正卡在待办上等人。
 */
function createCase(draft: IntakeDraft): IntakeResult {
  const question = draft.question.trim();
  const root = checkProjectRoot(draft.projectRoot);
  if ('error' in root) return { ok: false, field: 'projectRoot', error: root.error };

  rememberRoot(root.path);
  // 基准日期取建单这一刻，不再由人填：填错不会报错，只让无日期的时间串整体挪几天（ui.md §8.1）
  const now = new Date();
  const incidentDate = todayLocal(now);
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
        incidentDate,
        tzOffset: localTzOffset(now),
        // 「已知现象」不再单收：写清楚在 question 里就够了。列与旧调查里的值照旧留着
        clues: null,
      },
      agent: draft.agent,
      // 权限模式初值由设置屏给（ui.md §8.1 的最后一项）。**要连同 agent 一起落
      // `case_ui_state`**：只交给 runner 的话，这个调查被限流降级一次、或关一次 app，
      // 「我要全程接管」就被静默取消了——而它正是那一档要防的
      takeover: draft.takeover,
      limits: () => settings().limits,
      onChange: schedulePush,
    }),
  );
  writeCaseUi(caseId, { agent: draft.agent, takeover: draft.takeover });
  schedulePush();
  // 起标题是**新建之后的一件后台事**，不挡这一下：它要 spawn 一次 CLI，
  // 而人点完「新建」的下一个动作是点「开始排查」。落地了自己会推一轮快照
  void nameCase(caseId, question);
  return { ok: true };
}

/**
 * 让 agent 读完问题后给这次调查起个短标题（`case-namer.ts` 说明了为什么它另开一次 spawn）。
 *
 * **只在标题仍是那句兜底时才写**：起标题这一趟要几秒，这几秒里人完全可能已经自己改过了，
 * 而人改过的东西不该被一条迟到的建议盖掉。
 */
async function nameCase(caseId: string, question: string) {
  const proposed = await proposeCaseTitle(question);
  if (!proposed) return;
  if (readIntake(db, caseId)?.title !== titleOf(question)) return;
  if (renameTo(caseId, proposed, 'agent')) schedulePush();
}

/** 改标题。事件走 `renameCase`，这儿只补上 main 这侧的上下文。 */
function renameTo(caseId: string, title: string, source: 'agent' | 'operator'): boolean {
  try {
    return renameCase(db, { caseId, blobDir: blobs, now: () => Date.now() }, title, source);
  } catch (err) {
    console.error('[main] 改标题失败', err);
    return false;
  }
}

/** 按库里的建单信息重建一次调查的运行时。库里没有这个 id 就返回 null（列表会拒绝切过去）。 */
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
    takeover: readCaseUi(caseId).takeover ?? false,
    limits: () => settings().limits,
    onChange: schedulePush,
  });
}

/**
 * 工作区要在新建调查之前验：它随后就是 SDK 的 `cwd`。
 * 不验的话路径不存在也能新建调查成功，直到点「开始排查」才由 query 抛错、会话直接 crashed，
 * 而那时坏路径已经进了最近目录列表。
 */
function checkProjectRoot(input: string | null): { path: string } | { error: string } {
  const p = input?.trim();
  if (!p) return { error: '先选一个工作区目录' };
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

/** 重开最近一个未定稿的 case：一次调查跨多会话，重启只是它下面又开了一个 session。 */
function restoreLatestCase() {
  const row = db
    .prepare(`SELECT id FROM cases WHERE status='open' ORDER BY updated_at DESC LIMIT 1`)
    .get() as { id: string } | undefined;
  if (row) cases.switchTo(row.id);
}

/** 上次跑用的那套；没跑过就用新建调查时选的。中途换模型是常态，所以最近一次优先。 */
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
 * **带 caseId 核对**（`currentIf`）：切过去之后 current 是新调查，旧界面那一下的点击
 * 会导出另一次调查的内容，而文件名是按当前调查起的——一份没人会察觉搞错了的交付物。
 *
 * `target` 只给无人值守自检用（`INQUESTRY_EXPORT_MD`）：给了就直接写，不弹保存框。
 */
async function exportMarkdown(caseId: string, target?: string): Promise<ExportResult> {
  const runner = cases.currentIf(caseId);
  if (!runner) return { ok: false, reason: 'no-case', error: '这次调查不在手上，可能刚切走了。' };
  const input = reportInput(runner.snapshot());
  // 建单信息读不出来就没有报告可导。**说出来**，别写一个只有页脚的空文件
  if (!input) return { ok: false, reason: 'no-case', error: '这次调查还没有建单信息，导不出报告。' };

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

/** 长图的固定宽度（ui.md §7.2）：1240 CSS px、@2x 输出 2480px，与报告页的 `.paper` 同宽。 */
const IMG_WIDTH = 1240;
/**
 * **@2x 由 CDP 的 `deviceScaleFactor` 给，不靠显示器**（实测）：`capturePage()` 出来的尺寸
 * 跟着当前屏幕的缩放走，在 1x 机器上会静默产出一张半尺寸的图——而"同一个 case 在谁的机器上
 * 导出都是同一张图"正是长图这条的前提。`clip.scale` 保持 1，两个一起放大会得到 4x。
 */
const IMG_SCALE = 2;

/**
 * 这次导出要渲染的东西，等离屏视图自己来取（`export:payload`）。
 *
 * **现给现收**：token 是随机的、导完就删，正常界面拿不到也就取不走别人的快照。
 */
const exportPayloads = new Map<string, ExportPayload>();

/** 离屏视图量完排版后报回来的东西。字段名两侧要对上，改一边等于把图裁错。 */
type ExportLayout = { width: number; pages: { top: number; height: number }[] };

/**
 * 导出长图（D26 的后一半 / ui.md §7.2）。
 *
 * 与 Markdown 同吃 `reportPlan()`，换的只是渲染目标：另开一个**离屏窗口**载入
 * `?export=image`，那一屏按真实排版分页并把每页的落点量出来，这里逐页裁图写盘。
 *
 * ⚠️ **不用 `capturePage()`**：它拍的是合成器那一帧，尺寸跟着显示器缩放走，
 * 而且未获焦点时会回过期帧（ui.md §11 实测过）。这里走 CDP 的
 * `Page.captureScreenshot`，尺寸由 `deviceScaleFactor` 定死，超出视口的部分也拍得到。
 */
async function exportImage(caseId: string, target?: string): Promise<ExportResult> {
  const runner = cases.currentIf(caseId);
  if (!runner) return { ok: false, reason: 'no-case', error: '这次调查不在手上，可能刚切走了。' };
  const input = reportInput(runner.snapshot());
  if (!input) return { ok: false, reason: 'no-case', error: '这次调查还没有建单信息，导不出报告。' };

  // **先问落点再渲染**：反过来的话人要对着一个没反应的按钮等上几秒才等到保存框
  let file = target ?? null;
  if (!file) {
    const r = await dialog.showSaveDialog(win!, {
      title: '导出长图',
      defaultPath: path.join(app.getPath('downloads'), `${fileStem(input.case.title, caseId)}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    file = r.filePath;
  }

  const token = randomUUID();
  exportPayloads.set(token, { input, generatedAt: exportStamp(Date.now()) });
  let shot: BrowserWindow | null = null;
  try {
    shot = new BrowserWindow({
      show: false,
      width: IMG_WIDTH,
      height: 900,
      // 底色要与报告页同一个：不给的话窗口底是白的，图片边缘会漏出一条白
      backgroundColor: '#141a1f',
      webPreferences: {
        preload: path.join(HERE, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await loadRenderer(shot, { export: 'image', token });
    const dbg = shot.webContents.debugger;
    dbg.attach('1.3');
    // ⚠️ **这两句必须在载入之后**：对着还没载入文档的窗口发
    // `Emulation.setDeviceMetricsOverride`，整个进程 SIGSEGV（Electron 43 实测，
    // 崩在 main 里，表现是"什么都没发生、退出码还是 0"）。
    //
    // 放在载入之后不影响分页：这里给的宽度与窗口本来的内容宽度同为 1240，
    // `deviceScaleFactor` 又只管出图倍率、不参与 CSS 排版，所以那一屏量到的高度不会因它变。
    // 真变了也兜得住——下面那句宽度核对与逐页的尺寸核对都会当场报错。
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: IMG_WIDTH,
      height: 900,
      deviceScaleFactor: IMG_SCALE,
      mobile: false,
    });

    const layout = await waitForLayout(shot);
    // 宽度对不上就是那一屏的样式没按 1240 排（比如挂上了报告屏的外壳）：
    // 照裁的话会得到一张两边被切掉或留白的图，而它看起来"只是有点怪"
    if (Math.round(layout.width) !== IMG_WIDTH) {
      throw new Error(`长图视图排出来是 ${layout.width}px 宽，应为 ${IMG_WIDTH}px`);
    }

    // **先把每一页都拍完，再动盘上的文件**：边拍边写的话，拍到第三页才失败（尺寸对不上、
    // 那一屏塌了）会在目录里留下前两页——一组看起来正常、其实是半份的报告，
    // 而它与一次成功的导出长得一模一样
    const shots: Buffer[] = [];
    for (const rect of layout.pages) shots.push(await capturePage(dbg, rect));

    const files = shots.map((_, i) => pageFile(file, i, shots.length));
    await writeAll(files, shots);
    // 这次没覆盖到、却顶着同一个名字的旧图要说出来（**只报不删**，见 `staleSiblings`）
    return { ok: true, path: files[0]!, pages: files.length, stale: staleSiblings(file, files) };
  } catch (err) {
    return { ok: false, reason: 'failed', error: String((err as Error).message ?? err) };
  } finally {
    exportPayloads.delete(token);
    // 窗口销毁会带走 debugger；漏掉这一句的话每导一次就留下一个看不见的窗口
    shot?.destroy();
  }
}

/** 两个入口共用一份载入逻辑：dev 走 vite 的地址，打包后走文件。 */
async function loadRenderer(w: BrowserWindow, query: Record<string, string>) {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    await w.loadURL(url.toString());
  } else {
    await w.loadFile(path.join(HERE, '../renderer/index.html'), { query });
  }
}

/**
 * 等那一屏把分页量出来。**它自己报 ready，这边不靠固定等一会儿**——
 * 等短了会按一份还没排完版的矩形去裁（ui.md §11 那条过期帧的同族：安静地产出一张错图）。
 *
 * 渲染侧的失败也走这条路报上来：只等超时的话，错误信息只会是"超时"，
 * 说不出是取不到快照还是量不到某一块。
 */
async function waitForLayout(shot: BrowserWindow): Promise<ExportLayout> {
  for (let i = 0; i < 150; i += 1) {
    const got: ExportLayout | { error: string } | null = await shot.webContents.executeJavaScript(
      'window.__inquestryExport ?? null',
    );
    if (got && 'error' in got) throw new Error(`长图那一屏没排出来：${got.error}`);
    if (got && got.pages.length) return got;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('长图那一屏 15s 内没报出分页结果');
}

/**
 * 拍一页。**拍完比对像素尺寸**（ui.md §7.2）：这条链路最容易的失效方式不是抛异常，
 * 而是安静地给出一张高度不对的图——半截报告看起来只是"内容少了点"。
 * 不符先重拍一次（排版可能刚好在这一刻还没稳），再不符就报错，绝不写一张对不上的图出去。
 */
async function capturePage(
  dbg: Electron.Debugger,
  rect: { top: number; height: number },
): Promise<Buffer> {
  const want = { w: IMG_WIDTH * IMG_SCALE, h: Math.round(rect.height) * IMG_SCALE };
  let got = { w: 0, h: 0 };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data } = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      // 超出视口的部分要拍得到，否则一整页只有第一屏是画面、其余全空
      captureBeyondViewport: true,
      // `fromSurface:false` 会忽略 captureBeyondViewport，只给一个视口那么高（实测）
      fromSurface: true,
      clip: { x: 0, y: rect.top, width: IMG_WIDTH, height: Math.round(rect.height), scale: 1 },
    });
    const buf = Buffer.from(data, 'base64');
    got = pngSize(buf);
    if (got.w === want.w && got.h === want.h) return buf;
  }
  throw new Error(`拍出来的图是 ${got.w}×${got.h}，应为 ${want.w}×${want.h}`);
}

/**
 * 全写成功了才让新图露面：先落到同目录的临时文件，最后逐个 `rename` 换上去
 * （同目录的 rename 是原子替换）。中途写失败时临时文件全删，用户看得见的那几个名字一个没动。
 */
async function writeAll(files: string[], data: Buffer[]) {
  const temps = files.map((f) => `${f}.inquestry-part`);
  const backups = files.map((f) => `${f}.inquestry-old`);
  /** 挪开过旧文件的那几页，和已经换上新图的那几页。**两份要分开记**，见下。 */
  const backedUp: number[] = [];
  const swapped: number[] = [];
  try {
    for (const [i, t] of temps.entries()) await writeFile(t, data[i]!);
    for (const [i, t] of temps.entries()) {
      // **换之前先把旧的挪开**：换到第三页才失败时，前两页已经被新的盖掉了，
      // 而 rename 之后旧内容就没地方找回来——目录里于是留下"两页新 + 一页旧"的一组，
      // 它与一次成功的导出长得一模一样。挪开才有得还
      if (existsSync(files[i]!)) {
        await rename(files[i]!, backups[i]!);
        backedUp.push(i);
      }
      await rename(t, files[i]!);
      swapped.push(i);
    }
    // 全换上去了才删备份。**这一步失败不算导出失败**：图已经在盘上了，
    // 留下几个看得出是什么的 `.inquestry-old` 比把成功报成失败强
    for (const i of backedUp) await rm(backups[i]!, { force: true }).catch(() => {});
  } catch (err) {
    // 先撤掉这一轮换上去的，再把挪开的还回来。**还原要认 `backedUp` 而不是 `swapped`**：
    // 失败正好落在"挪开了旧的、还没换上新的"这中间时，那一页在 `swapped` 里没有记录，
    // 只按它还原的话，用户原本那张图就停在 `.inquestry-old` 上不见了（实测栽过）
    for (const i of [...swapped].reverse()) await rm(files[i]!, { force: true }).catch(() => {});
    for (const i of [...backedUp].reverse()) {
      if (existsSync(backups[i]!)) await rename(backups[i]!, files[i]!).catch(() => {});
    }
    // 收尾失败不该盖过真正的原因（rename 成功的那些临时文件已经不在了）
    for (const t of temps) await rm(t, { force: true }).catch(() => {});

    // **回滚自己失败了也要说出来**：上面每一步都是 best-effort，全吞掉的话
    // "失败时整组还原"就成了一句不作数的承诺——原图停在 `.inquestry-old` 上、
    // 或者某几页还是新的，而人只看到最初那个错误，回头去找自己那张图才发现不见了。
    //
    // **按结果核，不按步骤核**：`rm` 失败之后 `rename` 照样可能盖回去（rename 会覆盖），
    // 按步骤记的话会报一堆其实已经自愈的"失败"；真正要回答的只有一个问题——
    // 那个名字上现在是不是用户原来那张图。
    const trouble = [
      ...backedUp
        .filter((i) => existsSync(backups[i]!) || !existsSync(files[i]!))
        .map((i) => `${files[i]} 没还原回来，旧的在 ${backups[i]}`),
      // 原先没有这个文件、这一轮新写上去又没删掉的：留着就是半新半旧那一组的另一半
      ...swapped
        .filter((i) => !backedUp.includes(i) && existsSync(files[i]!))
        .map((i) => `${files[i]} 是这次写上去的，没能删掉`),
    ];
    if (trouble.length) {
      throw new Error(`${String((err as Error).message ?? err)}；回滚没做干净：${trouble.join('；')}`);
    }
    throw err;
  }
}

/**
 * 顶着同一个名字、这次却没被覆盖到的旧图。**只报不删**。
 *
 * 单页导出落 `<target>`、多页落 `<target>-1…N`，于是同一个路径先后导出两次、页数又变了的话，
 * 上一次的产物会原样留在旁边：它看起来就是这次的导出，打开却是一份过期的报告——
 * 而报告正是要交出去的东西。
 *
 * 删掉它们是另一种错：**保存框只问过用户那一个名字**，`<stem>-3.png` 有没有可能是他自己的文件、
 * 是不是别的调查导的，这儿一概不知道。所以这里只把名字报回界面，删不删由人决定
 * （同这份代码里"缺席要写出来"的那一条：说出来比替人处置可信）。
 */
function staleSiblings(target: string, written: string[]): string[] {
  const dir = path.dirname(target);
  const ext = path.extname(target) || '.png';
  const stem = path.basename(target, ext);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const like = new RegExp(`^${escape(stem)}(-\\d+)?${escape(ext)}$`);
  const mine = new Set(written);
  try {
    return readdirSync(dir)
      .filter((name) => like.test(name))
      .map((name) => path.join(dir, name))
      .filter((full) => !mine.has(full))
      .sort();
  } catch {
    // 读不了目录只是少一句提示，不该反过来把一次成功的导出报成失败
    return [];
  }
}

/** PNG 头里的真实像素尺寸。**不看解码库**：这里要的正是"盘上那张图到底多大"。 */
function pngSize(buf: Buffer): { w: number; h: number } {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG)) return { w: 0, h: 0 };
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * 起手在首页，报告的入口在工作区（ui.md §0）。**两条探针共用这一段**：
 * 各写一份的话，补了一边、另一边照旧栽在同一个坑里——这一次就是这么栽的
 * （`exportProbe` 改完了，`INQUESTRY_SHOT_REPORT` 那条还在找早就撤掉的 `.casebar .chip`）。
 *
 * 顺序照人的动作走：首页那份最近列表里点一行 → 切过去并翻到工作区。
 * 手上已经有工作区（`.toreport` 在）时什么都不做。
 */
const ENTER_WORKSPACE = `(async () => {
  const wait = async (sel) => {
    for (let i = 0; i < 50; i += 1) {
      const el = document.querySelector(sel);
      if (el) return el;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };
  if (document.querySelector('.reportscreen') || document.querySelector('.toreport')) return 'ok';
  const row = await wait('.crow');
  if (!row) return 'no-case';
  row.click();
  return (await wait('.toreport')) ? 'ok' : 'no-workspace';
})()`;

/**
 * 无人值守时"进报告屏、按下那个导出按钮、把回执读回来"的一段脚本（ui.md §11）。
 *
 * **两种导出共用一份**：它们在界面上的失效方式一模一样（按了、什么都没发生），
 * 各写一份的话，补了一边的等待、另一边照旧栽在同一个坑里。
 *
 * ⚠️ **每一步都要等界面到位**：`did-finish-load` 比第一份快照还早，那一刻连顶栏都没有。
 * 不等的话报的是"没有导出按钮"，而按钮只是还没画出来。
 */
function exportProbe(button: string): string {
  return `(async () => {
    const wait = async (sel) => {
      for (let i = 0; i < 50; i += 1) {
        const el = document.querySelector(sel);
        if (el) return el;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    };
    if (!document.querySelector(${JSON.stringify(button)})) {
      if ((await ${ENTER_WORKSPACE}) !== 'ok') return null;
      const enter = await wait('.toreport');
      if (!enter) return null;
      enter.click();
    }
    const btn = await wait(${JSON.stringify(button)});
    if (!btn) return null;
    // **先把上一次的回执关掉**：两种导出接连跑时屏上还挂着前一条，不关的话这里会立刻
    // 读到它并当成本次的回执——两次都"成功"，而后一次可能压根没落地
    const stale = document.querySelector('.exported');
    if (stale) {
      stale.querySelector('button').click();
      for (let i = 0; i < 25 && document.querySelector('.exported'); i += 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (document.querySelector('.exported')) return '(上一条回执关不掉)';
    }
    btn.click();
    const line = await wait('.exported');
    return line ? line.textContent : '';
  })()`;
}

/** 文件名取标题，路径分隔符与控制字符一律换掉；带上 caseId 好让同名的两个调查分得开。 */
function fileStem(title: string, caseId: string): string {
  const safe = title.replace(/[/\\:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${safe.slice(0, 40) || 'inquestry'} ${caseId}`;
}

/** 调查列表上的短标签：问题的第一行，长了截断。 */
function titleOf(question: string): string {
  const first = question.split('\n').find((l) => l.trim())?.trim() ?? '未命名调查';
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

/**
 * 关于那一节的内容。**版本号一律现取**——renderer 里写死的那份与打包出来的必然对不上。
 *
 * `claude --version` 要 spawn 一次，所以结果缓存在模块里：设置屏每次打开都探一次的话，
 * 那一页的打开速度就跟着一个外部进程走。探不到就是 null，不编一个"未知版本"。
 */
let claudeVersionCache: string | null | undefined;
function claudeVersion(bin: string | null): string | null {
  if (claudeVersionCache !== undefined) return claudeVersionCache;
  claudeVersionCache = null;
  if (bin) {
    try {
      claudeVersionCache =
        execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 4000 }).trim().split(/\s+/)[0] ?? null;
    } catch (err) {
      console.error('[main] 探测 claude 版本失败', err);
    }
  }
  return claudeVersionCache;
}

function appInfo(): AppInfo {
  const dbPath = path.join(app.getPath('userData'), 'inquestry.db');
  const bin = findClaudeExecutable();
  let dbBytes = 0;
  try {
    dbBytes = statSync(dbPath).size;
  } catch {
    // 库文件刚建起来之前读不到，显示 0 就够——这一栏是给人看大小的，不是校验
  }
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    sqlite: (db.prepare(`SELECT sqlite_version() AS v`).get() as { v: string }).v,
    claudePath: bin,
    claudeVersion: claudeVersion(bin),
    dbPath,
    dbBytes,
  };
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
    // 面板的 agent 三项从设置里取初值；模型探测不到时那一档会退回内置表，
    // 所以这里给的 model 可能不在 `models` 里——面板自己按"选不到就回 default"处理
    agentDefaults: settings().intake,
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    titleBarStyle: 'hiddenInset',
    /**
     * 交通灯钉死在这儿，好让 CSS 那侧的让位量算得出来（`--head-pad`）。
     * 三颗灯连起来 52px 宽（x=20 起，右缘 72），y 取的是 46px 顶栏的竖直居中。
     *
     * ⚠️ **rail 让不开它**——灯比这条 52px 的 rail 还宽。让位是顶栏一家的事，
     * 顶栏因此做成整幅的、压在 rail 上面那一格（见 styles.css 的外壳网格）。
     * 不写这一项就跟着 macOS 版本漂，而漂了没人会去核——表现是标题被灯压住。
     */
    trafficLightPosition: { x: 20, y: 17 },
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

  void loadRenderer(win, {});
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
  if (swept.calls || swept.sessions || swept.lanes) console.log('[main] 清扫上次遗留', swept);
  cases = new CaseRegistry<CaseRunner>({ db, create: loadCase });
  restoreLatestCase();

  ipcMain.handle('env:check', () => ({
    claude: findClaudeExecutable(),
    hint: '“已装但未登录/凭据过期”只有真正发起会话才知道，届时会话会直接报 401。',
  }));
  ipcMain.handle('intake:options', () => intakeOptions());
  ipcMain.handle('intake:pickRoot', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择工作区目录' });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('case:create', (_e, draft: IntakeDraft) => createCase(draft));
  // 改标题不经 `currentIf`：历史调查页上改的那一条多半不是当前调查，
  // 而它与"当前跑着的是哪一个"毫无关系
  ipcMain.handle('case:rename', (_e, caseId: string, title: string) => {
    const ok = renameTo(caseId, title, 'operator');
    if (ok) schedulePush();
    return ok;
  });
  ipcMain.handle('case:switch', (_e, caseId: string) => {
    cases.switchTo(caseId);
    schedulePush();
  });
  ipcMain.handle('case:new', () => {
    cases.toIntake();
    schedulePush();
  });
  // 检索不进快照：它由人打字驱动，塞进 60ms 一轮的全量推送里等于每次都跑一遍全库检索
  ipcMain.handle('case:search', (_e, term: string) => cases.search(term));
  // 下面这些都依赖「当前调查」，一律判空不用 `!`：点「＋ 新调查」的那一刻 currentId 就是
  // null 了，而 renderer 要等下一次快照（最多 60ms）才换屏——这中间旧界面照样发得出调用。
  // 用非空断言的话那一下是个 TypeError，invoke 变成未处理的 rejection，
  // 用户那侧只看到输入框被清空、内容没了
  // 这四个还要核对 renderer 说的是哪个调查（`currentIf`）：光判空不够，
  // 切过去之后 current 是**新**调查，旧界面那一下会正正好落到它头上
  ipcMain.handle('case:start', (_e, caseId: string, question?: string) =>
    cases.currentIf(caseId)?.start(question),
  );
  ipcMain.handle('case:restart', (_e, caseId: string) => cases.currentIf(caseId)?.restart());
  // 接管模式（overview §3.5）。**要落 `case_ui_state`**：只存运行时里的话，限流把这个
  // runner 降级一次、或关一次 app，"我要自己判"就被静默取消了——而那正是它要防的
  // **落库要等 runner 那边真切成**：切不动却先写进去的话，下次启动会照着一个从没生效过的
  // 「已接管」把界面点亮，而 backend 那侧仍是分类器在判。反过来那半（切成了却落不了库）
  // 由 `applyTakeover` 兜着——两头都是同一种"说了谎的状态"
  ipcMain.handle('case:takeover', async (_e, caseId: string, on: boolean): Promise<TakeoverResult> => {
    const runner = cases.currentIf(caseId);
    if (!runner) return 'gone';
    const r = await applyTakeover(runner, caseId, on, () => writeCaseUi(caseId, { takeover: on }));
    // 回滚那条路也要推一次：界面上的开关这会儿画的是人按下的那一下，得让它跟回实际状态
    schedulePush();
    return r;
  });
  // 唯一要回执的一个：送没送出去，renderer 据此决定草稿该不该清
  ipcMain.handle('case:send', async (_e, caseId: string, text: string) => {
    const runner = cases.currentIf(caseId);
    return runner ? runner.send(text) : false;
  });
  ipcMain.handle('case:interrupt', (_e, caseId: string) => cases.currentIf(caseId)?.interrupt());
  ipcMain.handle('case:stopLane', async (_e, caseId: string, lane: string) => {
    const runner = cases.currentIf(caseId);
    return runner ? runner.stopLane(lane) : false;
  });
  // 收尾后两档（D29）。问询与执行是两个入口：合成一个的话，界面就得靠 60ms 前的快照
  // 决定"这一下是问还是执行"，而隔着那一拍点下去的会是不可逆的定稿
  // 对不上就回 null，不回一个「什么都不缺」的空壳：后者会让界面弹出确认条，
  // 而那次调查根本不在手上——人对着一份已经切走的调查按下不可逆的那一下
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
  // 开发期自检用 `INQUESTRY_EXPORT_IMG` 指定落点，同 Markdown 那条
  ipcMain.handle('case:exportImage', (_e, caseId: string) =>
    exportImage(caseId, process.env.INQUESTRY_EXPORT_IMG),
  );
  // 只有长图那个离屏视图会调；token 对不上就什么都不给
  ipcMain.handle('export:payload', (_e, token: string) => exportPayloads.get(token) ?? null);
  /**
   * 历史调查页那一页。**每行的运行时那一半要现合**（同 `search()` 的理由，ui.md §8.3）：
   * 「等你 N」「运行中」只活在运行时里，库里查出来的行少了这一下，
   * 一个正卡在 `ask_operator` 上等人的调查会被显示成一次静止的旧调查。
   */
  ipcMain.handle('case:list', (_e, q: CaseListQuery): CaseListPage => {
    const page = casePage(db, q ?? {});
    return {
      total: page.total,
      rows: page.rows.map((c) => ({
        ...cases.briefOf(c),
        projectRoot: c.project_root,
        incidentDate: c.incident_date,
        verdictShape: (c.verdict_shape as CaseListPage['rows'][number]['verdictShape']) ?? null,
        steps: c.steps,
        headline: c.headline,
      })),
    };
  });
  ipcMain.handle('settings:get', () => settings());
  ipcMain.handle('settings:put', (_e, patch: UiSettings) => saveSettings(patch));
  ipcMain.handle('app:info', (): AppInfo => appInfo());
  ipcMain.handle('app:revealDb', () => shell.showItemInFolder(path.join(app.getPath('userData'), 'inquestry.db')));
  // **只放 https**：这个口子的入参最终来自 renderer，而 `openExternal` 认得 file: 与各种
  // 自定义协议——放开等于把"点一下就能拉起本机任意程序"接到了界面上
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https:\/\//i.test(url)) return shell.openExternal(url);
    console.error('[main] 拒绝打开非 https 链接', url);
  });
  ipcMain.handle('case:snapshot', () => snapshot());
  ipcMain.handle('case:excerpt', (_e, callId: string, anchor: string | null) =>
    current()?.excerpt(callId, anchor) ?? '(没有选中的调查)',
  );

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('before-quit', () => cases.closeAll());

  // 开发期自检：无人值守跑一轮并截图，用于在没有人盯着屏幕时验证 UI
  // 三个开关任一存在就挂这段自检：导出那条兜底不该依赖一个跟它无关的截图变量
  // （只设 `INQUESTRY_EXPORT_MD` 时它压根不会跑，而日志与文档都说它跑了）
  if (
    process.env.INQUESTRY_SHOT ||
    process.env.INQUESTRY_SHOT_REPORT ||
    process.env.INQUESTRY_EXPORT_MD ||
    process.env.INQUESTRY_EXPORT_IMG
  ) {
    const shots = process.env.INQUESTRY_SHOT ? process.env.INQUESTRY_SHOT.split(',') : [];
    win?.webContents.once('did-finish-load', async () => {
     try {
      if (process.env.INQUESTRY_AUTOSTART) {
        // 无人值守时替人立一次案，好让整条链路能自己跑完
        createCase({
          // 探针也要给工作区：起点是必填项，缺了它这一条什么都立不起来
          projectRoot: process.env.INQUESTRY_AUTOSTART_ROOT || process.cwd(),
          question: process.env.INQUESTRY_AUTOSTART,
          agent: { backend: 'claude', model: null, effort: null },
          takeover: false,
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
      // 系统时间线现在属于报告屏（D21），拍它就是拍报告。
      // **点不到入口要出声**：`?.click()` 静默跳过的话，拍出来的是工作区，
      // 而文件名与日志都说这是报告——一张认错了的截图比没有更糟
      if (process.env.INQUESTRY_SHOT_REPORT) {
        // **先等界面到位再摸它**：单独设这个变量时（不带 INQUESTRY_SHOT）这里是
        // `did-finish-load` 后第一件事，比第一份快照还早——报告屏与 .toreport
        // 谁都还没画出来。不等的话表现是"进不去报告屏"，而两者只是还没渲染出来
        const entered: string = await win!.webContents.executeJavaScript(ENTER_WORKSPACE);
        if (entered !== 'ok') throw new Error(`[shot] 进不去工作区（${entered}）：报告的入口长在那一屏上`);
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
        // 等不到就抛；否则文件名和日志都说这是报告，而里面是工作区
        const before = (await win!.webContents.capturePage()).toPNG();
        // 收尾之后界面会自己翻到报告屏（ui.md §6），那时不用点
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
        const receipt: string | null = await win!.webContents.executeJavaScript(exportProbe('.exportmd'));
        if (receipt === null) throw new Error('[export] 进不去报告屏，或那儿没有导出按钮');
        if (!receipt.startsWith('已导出到')) throw new Error(`[export] 界面没给出成功回执：${receipt}`);
        // 回执说成功、盘上却没有东西，是这条链路唯一还骗得过人的失败方式
        if (!statSync(process.env.INQUESTRY_EXPORT_MD).size) throw new Error('[export] 落盘的是个空文件');
        console.log('[export]', receipt);
      }
      // 长图同样**从界面按钮按下去**：renderer → preload → main → 离屏窗口 → 裁图 → 写盘 → 回执。
      // 纯函数那一侧（分页）由 spike:image 兜着，这里验的是那一条按不下去就没人知道的链路
      if (process.env.INQUESTRY_EXPORT_IMG) {
        // **按下之前记一个时刻**：上一轮留在盘上的图会让这一段变成一条空检查——
        // 文件在、尺寸也对，而这一次导出可能压根没跑（实测：漏掉上面那句"关掉旧回执"时，
        // 探针读到的是 Markdown 那条回执，随即去核一张旧图，两条断言都过得去）
        const pressedAt = Date.now();
        const receipt: string | null = await win!.webContents.executeJavaScript(
          exportProbe('.exportimg'),
        );
        if (receipt === null) throw new Error('[image] 进不去报告屏，或那儿没有导出长图的按钮');
        if (!receipt.startsWith('已导出到')) throw new Error(`[image] 界面没给出成功回执：${receipt}`);
        // **回执说成功、图却不对**是这条链路唯一还骗得过人的失败方式。按盘上那张图的
        // 像素尺寸核，不看回执：@2x 那一条尤其要在真 app 里验——`capturePage()` 的倍率
        // 跟着显示器走，在 1x 机器上会静默少掉一半分辨率，而图看起来"只是小了点"。
        //
        // 高度这一侧不在这儿设阈值：**一份短报告本来就该出一张矮图**（这个库里就有一个
        // 几乎空的调查，2076px）。"截了半张"由 `capturePage()` 拿量出来的矩形当场核，
        // 这里只认它是不是一张读得出尺寸的 PNG
        // 第一张要么是 `<target>`（单页），要么是 `<target>-1`（分了页；**走生产那个命名函数**，
        // 别在这儿照抄一遍规则）。
        //
        // ⚠️ **按"这次导出之后才写的"挑，不能按"哪个文件在"挑**：上一轮导过单页、这一轮分了页时，
        // 旧的 `<target>` 按设计留在原地，"谁在就挑谁"必然挑中它——于是一次成功的导出被
        // 报成失败（旧图的 mtime 当然早于按钮按下那一刻），而本轮真正的第一页压根没被核过
        const target = process.env.INQUESTRY_EXPORT_IMG;
        const fresh = [target, pageFile(target, 0, 2)].filter(
          (f) => existsSync(f) && statSync(f).mtimeMs >= pressedAt,
        );
        // 一个都没有 = 回执说成功、盘上却没有这次写的东西，是这条链路唯一还骗得过人的失败方式
        if (!fresh.length) throw new Error(`[image] 这次导出之后写出来的图一张都没有：${target}`);
        const first = fresh[0]!;
        const png = await readFile(first);
        const size = pngSize(png);
        if (size.w !== IMG_WIDTH * IMG_SCALE) {
          throw new Error(`[image] 导出的图是 ${size.w}px 宽，应为 ${IMG_WIDTH * IMG_SCALE}px（@2x）`);
        }
        if (size.h % IMG_SCALE !== 0 || size.h === 0) {
          throw new Error(`[image] 导出的图 ${size.h}px 高，不是 @2x 的整数倍`);
        }
        console.log('[image]', receipt, `${first} ${size.w}x${size.h}`);
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
            answer: '(操作员：这条没跑，换个写法)',
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
