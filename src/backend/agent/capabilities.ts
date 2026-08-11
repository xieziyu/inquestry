/**
 * 立案面板要列的模型与思考强度（D19 能力协商）。
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

type Cache = { at: number; models: ModelOption[] };

/**
 * 缓存进 `ui_settings`：探测代价是一次进程 spawn，不该每次开立案面板都付。
 * 读写用回调传进来，这个模块不认识 DB。
 */
export async function loadModelOptions(io: {
  read: () => string | null;
  write: (v: string) => void;
}): Promise<{ models: ModelOption[]; probed: boolean }> {
  const cached = parseCache(io.read());
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { models: cached.models, probed: true };

  const probed = await probeModels();
  if (probed) {
    io.write(JSON.stringify({ at: Date.now(), models: probed } satisfies Cache));
    return { models: probed, probed: true };
  }
  // 探测失败但有旧缓存时用旧的：过期的真实列表也强过内置猜测
  return cached ? { models: cached.models, probed: true } : { models: FALLBACK_MODELS, probed: false };
}

async function probeModels(): Promise<ModelOption[] | null> {
  const q = query({ prompt: '', options: { settingSources: [] } });
  try {
    const list = await withTimeout(q.supportedModels(), PROBE_TIMEOUT_MS);
    return list.map((m) => ({
      value: m.value,
      label: m.displayName || m.value,
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
