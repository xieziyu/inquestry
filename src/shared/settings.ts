/**
 * 应用级设置（设置屏 / ui.md §8.5）。
 *
 * **与 `case_ui_state` 分开**：那一份是"某次调查当时选的什么"，冻在它自己身上；
 * 这一份是"下次新建调查从哪儿起步"。合在一起的话，改一次默认模型会把历史调查
 * 记录的那个模型一起改掉，而报告里要标"这一步是哪个模型跑的"。
 *
 * 三个限流值原先写死在源码里（`case-runner.ts` 的 `GATE_TIMEOUT_MS`、
 * `case-registry.ts` 的 `MAX_LIVE_CASES` / `MAX_LOADED_CASES`）。搬出来之后
 * **必须夹逼**：这几个值填 0 都不会报错，只会让工具安静地不工作
 * —— 闸门 0 秒 = 每次调用当场自动放行、在跑上限 0 = 一个调查也跑不起来。
 */

import type { AgentChoice } from './ipc.js';

export type UiSettings = {
  /** 新建调查面板的预填。改这里不动任何已经建好的调查。 */
  intake: {
    agent: AgentChoice;
    /** 权限模式初值：`true` = 全程接管。 */
    takeover: boolean;
  };
  limits: {
    /** ②档闸门的倒计时。接管档不吃这个值——那一档故意没有超时兜底（ui.md §4）。 */
    gateTimeoutMs: number;
    /** 同时 spawn 出进程的调查数。 */
    maxLiveCases: number;
    /** 载入内存的调查数。 */
    maxLoadedCases: number;
  };
};

export const DEFAULT_UI_SETTINGS: UiSettings = {
  intake: {
    agent: { backend: 'claude', model: null, effort: null },
    takeover: false,
  },
  limits: {
    gateTimeoutMs: 3 * 60 * 1000,
    maxLiveCases: 3,
    maxLoadedCases: 12,
  },
};

/**
 * 每个限流值的上下界。**下界不是 0**，理由见文件头。
 *
 * 上界挡的是另一头：闸门等一天等于①档，而①档的"永远等下去"是它自己那一档明写的语义，
 * 不该由一个填过头的数字模仿出来。
 */
export const LIMIT_BOUNDS = {
  gateTimeoutMs: { min: 30_000, max: 60 * 60 * 1000 },
  maxLiveCases: { min: 1, max: 8 },
  maxLoadedCases: { min: 1, max: 50 },
} as const;

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/**
 * 把库里读来的那坨（可能是上个版本写的、可能被人手改坏了）收成一份能用的设置。
 *
 * 🔴 **`maxLoaded` 必须 ≥ `maxLive`**，这一条是跨字段的，单独夹逼每一个夹不出来：
 * 载入上限比在跑上限还小时，限流会把刚 spawn 起来的调查当场降级掉——
 * 表现是点了「开始排查」什么都不发生，而两个数字各自都在自己的合法区间里。
 */
export function normalizeSettings(raw: unknown): UiSettings {
  const o = (raw ?? {}) as Partial<UiSettings>;
  const intake = (o.intake ?? {}) as Partial<UiSettings['intake']>;
  const agent = (intake.agent ?? {}) as Partial<AgentChoice>;
  const limits = (o.limits ?? {}) as Partial<UiSettings['limits']>;

  const maxLiveCases = clamp(
    limits.maxLiveCases,
    LIMIT_BOUNDS.maxLiveCases.min,
    LIMIT_BOUNDS.maxLiveCases.max,
    DEFAULT_UI_SETTINGS.limits.maxLiveCases,
  );
  const maxLoadedCases = clamp(
    limits.maxLoadedCases,
    LIMIT_BOUNDS.maxLoadedCases.min,
    LIMIT_BOUNDS.maxLoadedCases.max,
    DEFAULT_UI_SETTINGS.limits.maxLoadedCases,
  );

  return {
    intake: {
      agent: {
        backend: agent.backend === 'codex' ? 'codex' : 'claude',
        model: typeof agent.model === 'string' ? agent.model : null,
        effort: typeof agent.effort === 'string' ? agent.effort : null,
      },
      takeover: intake.takeover === true,
    },
    limits: {
      gateTimeoutMs: clamp(
        limits.gateTimeoutMs,
        LIMIT_BOUNDS.gateTimeoutMs.min,
        LIMIT_BOUNDS.gateTimeoutMs.max,
        DEFAULT_UI_SETTINGS.limits.gateTimeoutMs,
      ),
      maxLiveCases,
      maxLoadedCases: Math.max(maxLoadedCases, maxLiveCases),
    },
  };
}
