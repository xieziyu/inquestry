/**
 * 时间基准：把日志里的时间串补齐成绝对时刻。
 *
 * **单独一个模块是为了让投影器也能用它**——改基准那条事件要按新基准把已落库的
 * `occurred_at_ms` 重算一遍，而投影器不能反过来依赖 store（那是一个环）。
 */

/** 解析日志时间串只需要这两项。`cases` 上那两列就是它的持久化形态。 */
export type TimeBase = {
  incidentDate: string;
  tzOffset: string;
};

/** 基准日期是谁定的。`intake` = 建单那一刻按本机日期猜的，还没有人或 agent 确认过。 */
export type TimeBaseSource = 'intake' | 'agent' | 'operator';

/** 只有时分秒、既无日期也无时区的串——补齐它要用掉整个基准。 */
const TIME_ONLY = /^(\d{1,2}):(\d{2}):(\d{2})(\.\d{1,3})?$/;

export function isTimeOnly(raw: string | undefined | null): boolean {
  return !!raw && TIME_ONLY.test(raw.trim());
}

/**
 * 日志时间串大多既无日期也无时区，必须靠 case 的基准日期与时区补齐；
 * 原始串照样存进 `occurred_at_raw`，解析错了才有得回溯（data-model.md §2）。
 *
 * **带日期的串只补时区**——所以换基准日期时全表重跑是安全的：这一档算出来的
 * 是同一个 ms，只有纯时分秒那些会跟着动。
 */
export function parseOccurredAt(raw: string | undefined | null, ctx: TimeBase) {
  if (!raw) return { ms: null };
  const s = raw.trim();
  const candidate = TIME_ONLY.test(s)
    ? `${ctx.incidentDate}T${s.padStart(8, '0')}${ctx.tzOffset}`
    : /[zZ]|[+-]\d{2}:?\d{2}$/.test(s)
      ? s.replace(' ', 'T')
      : `${s.replace(' ', 'T')}${ctx.tzOffset}`;
  const ms = Date.parse(candidate);
  return { ms: Number.isNaN(ms) ? null : ms };
}
