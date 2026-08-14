/**
 * 本机时区的换算。main 与 renderer 共用一份：
 * 面板上显示的偏移和最终落库的偏移必须是同一个数，各算各的迟早会对不上。
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function todayLocal(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** `getTimezoneOffset()` 的符号与 ISO 偏移相反，这里一次性掰正。 */
export function localTzOffset(at: Date = new Date()): string {
  const min = -at.getTimezoneOffset();
  return `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;
}

/**
 * 页脚水印上的生成时间。带偏移，否则跨时区转手之后没人知道这是谁的几点。
 *
 * **两种导出共用这一份**：同一次排查的 `.md` 与长图会被并排贴出来，
 * 两处各写一个格式的话，同一次导出看上去像是两个时间。
 */
export function exportStamp(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} ${localTzOffset(at)}`;
}

