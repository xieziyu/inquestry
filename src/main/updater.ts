import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateStatus } from '../shared/update.js';
import { isReleaseChannel } from './channel.js';

// electron-updater 是 CJS，具名 import 在 ESM 产物下会拿到 undefined，只能默认导入后解构
const { autoUpdater } = electronUpdater;

/** 启动后延迟首查：让窗口先画出来，别和冷启动抢带宽。 */
const FIRST_CHECK_DELAY_MS = 8_000;
/** 常驻期间的复查间隔。 */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdaterDeps {
  /** 状态变化推给所有窗口 */
  onStatus: (status: UpdateStatus) => void;
  /** 装更新前收掉全部运行时（与退出时那套同一份）。 */
  cleanup: () => void;
}

export interface Updater {
  getStatus(): UpdateStatus;
  check(): void;
  install(): void;
}

/**
 * electron-updater 的薄封装。渠道是 electron-builder 在打包时写进 app-update.yml 的
 * GitHub Releases，所以这里不碰 setFeedURL。
 *
 * 默认后台下载 + 退出时安装：用户什么都不做也能升级，设置屏那行只是让他能提前重启。
 * 非正式渠道（`isReleaseChannel`）停在 unsupported，它们没有 app-update.yml。
 */
export function createUpdater({ onStatus, cleanup }: UpdaterDeps): Updater {
  const supported = isReleaseChannel();
  let status: UpdateStatus = { phase: supported ? 'idle' : 'unsupported' };

  function set(next: UpdateStatus): void {
    status = next;
    onStatus(next);
  }

  if (!supported) {
    return {
      getStatus: () => status,
      check: () => undefined,
      install: () => undefined,
    };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ phase: 'current' }));
  autoUpdater.on('update-available', (info) =>
    set({ phase: 'downloading', version: info.version, percent: 0 }),
  );
  autoUpdater.on('download-progress', (p) => {
    // version 只在 update-available 里给，进度事件没有，沿用当前档里的
    const version = status.phase === 'downloading' ? status.version : '';
    set({ phase: 'downloading', version, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => set({ phase: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => set({ phase: 'error', message: err.message }));

  function check(): void {
    // 已经下好了就别再查：再查一轮会把 ready 冲回 checking，用户那颗「立即重启」按钮就没了
    if (status.phase === 'ready' || status.phase === 'downloading') return;
    void autoUpdater.checkForUpdates().catch((e: unknown) => {
      set({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, RECHECK_INTERVAL_MS);

  return {
    getStatus: () => status,
    check,
    install() {
      if (status.phase !== 'ready') return;
      // 先收会话再交给 Squirrel：quitAndInstall 立刻走退出流程，
      // 那之后 spawn 出来的 claude 子进程没人管，会成为孤儿活到用户手动 kill。
      // （closeAll 幂等，quitAndInstall 触发的 before-quit 再跑一遍也无妨。）
      cleanup();
      autoUpdater.quitAndInstall();
    },
  };
}
