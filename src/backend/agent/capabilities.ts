/**
 * 新建排查面板要列的模型与思考强度（D19 能力协商）。
 *
 * 不写死一张表：backend 自己报得出来的东西就问它要。问不到才退回内置表，
 * 并让 UI 明说这是兜底 —— 假装知道比承认不知道更糟（effort 尤其：
 * 模型不支持却给个开关，用户拧了一整轮才发现没生效）。
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { IntakeOptions, ModelOption } from '../../shared/ipc.js';

/** 探测要 spawn 一次 CLI。装了但没登录时它会卡在那儿，所以必须有上限。 */
const PROBE_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 缓存里一行模型的形状版本。🔴 **给 `ModelOption` 加字段就要 +1。**
 *
 * 缓存一命中就直接返回、且回的 `probed` 是 true，所以旧形状会原样顶上最多 24 小时，
 * 界面上没有任何地方看得出来——加了 `resolvedModel` 那次就是这么栽的：代码对了、
 * 新装的机器也对，只有老库上的下拉一整天不显示版本号。
 */
const CACHE_VERSION = 2;

/** 兜底表。只列别名，避免把具体版本号写死在源码里 —— 那才是真正会烂的东西。 */
const FALLBACK_MODELS: ModelOption[] = [
  { value: 'opus', label: 'Opus', description: '最强，贵', efforts: ['low', 'medium', 'high'] },
  { value: 'sonnet', label: 'Sonnet', description: '默认档', efforts: ['low', 'medium', 'high'] },
  { value: 'haiku', label: 'Haiku', description: '快而便宜，适合先扫一遍', efforts: [] },
];

export const BACKENDS: IntakeOptions['backends'] = [
  { value: 'claude', label: 'Claude', enabled: true },
  { value: 'codex', label: 'Codex', enabled: false, note: '未接入' },
];

type Cache = { v?: number; at: number; models: ModelOption[] };

/** 写一份缓存。与 {@link cacheHit} 成对——版本戳只在这一处打，漏打的表现是每次开面板都重探。 */
export function cacheBlob(models: ModelOption[], now: number): string {
  return JSON.stringify({ v: CACHE_VERSION, at: now, models } satisfies Cache);
}

/**
 * 这份缓存能不能直接当答案用；不能就回 null，由调用方去重探。
 *
 * **版本与 TTL 是两回事，不能合成一条**：过期只是旧，形状对不上是少了整整一列，
 * 而两者在界面上长得一模一样（见 {@link CACHE_VERSION}）。
 */
export function cacheHit(raw: string | null, now: number): ModelOption[] | null {
  const c = parseCache(raw);
  return c && c.v === CACHE_VERSION && now - c.at < CACHE_TTL_MS ? c.models : null;
}

/**
 * 缓存进 `ui_settings`：探测代价是一次进程 spawn，不该每次开新建排查面板都付。
 * 读写用回调传进来，这个模块不认识 DB。
 */
export async function loadModelOptions(io: {
  read: () => string | null;
  write: (v: string) => void;
}): Promise<{ models: ModelOption[]; probed: boolean }> {
  const raw = io.read();
  const hit = cacheHit(raw, Date.now());
  if (hit) return { models: hit, probed: true };

  const probed = await probeModels();
  if (probed) {
    io.write(cacheBlob(probed, Date.now()));
    return { models: probed, probed: true };
  }
  // 命中不了才轮到它：可能是过期，也可能是形状旧
  const cached = parseCache(raw);
  // 探测失败就退回旧缓存，**旧形状的也照收**：那上面的模型是真问出来的，
  // 只是少了后来才加的那几个字段，而内置表连模型都是猜的
  return cached ? { models: cached.models, probed: true } : { models: FALLBACK_MODELS, probed: false };
}

async function probeModels(): Promise<ModelOption[] | null> {
  const q = query({ prompt: '', options: { settingSources: [] } });
  try {
    const list = await withTimeout(q.supportedModels(), PROBE_TIMEOUT_MS);
    return list.map((m) => ({
      value: m.value,
      label: m.displayName || m.value,
      resolvedModel: m.resolvedModel,
      description: m.description ?? '',
      efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
    }));
  } catch {
    return null;
  } finally {
    q.close();
  }
}

function parseCache(raw: string | null): Cache | null {
  try {
    const v = raw ? (JSON.parse(raw) as Cache) : null;
    return v?.models?.length ? v : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), ms)),
  ]);
}
