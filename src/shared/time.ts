/**
 * 本机时区的换算。main 与 renderer 共用一份：
 * 面板上显示的偏移和最终落库的偏移必须是同一个数，各算各的迟早会对不上。
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function todayLocal(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * 日期串的**日历日序号**（第几个 UTC 天），不是真日子就回 null。
 *
 * **两件事都靠它，所以合成一个**：
 *
 * - 那一天存不存在。`Date.parse` / `Date.UTC` **只拦得住 13 月，拦不住 2 月 30 日**——
 *   后者被静默挪到 3 月 2 日，而调用方拿回的还是原样那一串。它一旦成了基准日期，
 *   卡片上写着 2 月 30 日、所有纯时分秒的证据却落在 3 月 2 日（`parseOccurredAt`
 *   拼出来的串同样会被挪），两处都不报错。所以回写一遍逐项比。
 * - 两天差几天。**按 UTC 算，不按本机午夜**：跨夏令时的一个日历日是 23 或 25 小时，
 *   拿两个本机午夜的毫秒差去除 86400000 得不到整数，「差几天」在换季那几天就会多算
 *   一小时——刚好卡在上限那天的日期会被判成超界丢掉（`case-namer` 的 `checkDate`）。
 *   日历运算本来也不该扯上时区。
 */
export function dayNumber(d: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = Date.UTC(y, mo - 1, day);
  const back = new Date(at);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== day) return null;
  return at / 86_400_000;
}

/** 这一天真的存在吗。落库前那道闸只关心这个（`setCaseTimebase`）。 */
export function isRealDate(d: string): boolean {
  return dayNumber(d) !== null;
}

/** `getTimezoneOffset()` 的符号与 ISO 偏移相反，这里一次性掰正。 */
export function localTzOffset(at: Date = new Date()): string {
  const min = -at.getTimezoneOffset();
  return `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;
}

/**
 * 页脚水印上的生成时间。带偏移，否则跨时区转手之后没人知道这是谁的几点。
 *
 * **两种导出共用这一份**：同一次调查的 `.md` 与长图会被并排贴出来，
 * 两处各写一个格式的话，同一次导出看上去像是两个时间。
 */
export function exportStamp(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} ${localTzOffset(at)}`;
}

