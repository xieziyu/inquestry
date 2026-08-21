/**
 * 时间基准：把日志里的时间串补齐成绝对时刻，以及它在界面上怎么写。
 *
 * **单独一个模块是为了让投影器也能用它**——改基准那条事件要按新基准把已落库的
 * `occurred_at_ms` 重算一遍，而投影器不能反过来依赖 store（那是一个环）。
 * 放在 shared 是因为 renderer 也要用：显示写法与解析规则是同一件事的两半，
 * 各写一份的话「这串算哪一天」两处迟早对不上，而对不上时不报错。
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

/**
 * 证据时间戳在界面上的写法：`2026-08-19T00:00:00+08:00` → `08-19 00:00:00`。
 *
 * 时区在这儿是噪声——**整个 app 的时刻都按 case 的基准时区读**（它写在信息卡上），
 * 每条证据再重复一遍只会把时间列撑到正文那边去。年份同理，但只在它与基准同年时省：
 * 一次调查照样会引用去年的日志，`12-31` 同时代表两个 12-31 是读不出来的歧义。
 *
 * 🔴 **重排不许改写证据说的时刻**，认不出来就原样出。三处会静默改写它：
 *   - `Date.parse` 只拦得住 13 月与 25 点，**2 月 30 日会被挪到 3 月 2 日**（同 `checkDate`）；
 *   - 只有时分秒的串补上日期，等于把可能还是猜的基准日期（`incidentDateSource === 'intake'`）
 *     当成事实写进证据；
 *   - `Date.parse` 对非 ISO 串还有一堆实现相关的兜底分支，读出来的东西没法预期。
 *     所以这里先按形状卡一道，不合形状的一律原样出。
 *
 * ⚠️ 换算落在**基准时区**，不是本机时区：同一份列表里时分秒那档按定义就在基准时区，
 * 带日期那档若按本机换算，两行会静默地处在两个时区里。
 */
export function formatOccurredAt(raw: string | undefined | null, ctx: TimeBase): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (isTimeOnly(s)) return s;
  const shape = ISO_ISH.exec(s);
  if (!shape) return s;
  if (!isRealDate(+shape[1]!, +shape[2]!, +shape[3]!)) return s;
  const { ms } = parseOccurredAt(s, ctx);
  const mins = offsetMinutes(ctx.tzOffset);
  if (ms === null || mins === null) return s;
  const t = new Date(ms + mins * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  // 换算过后的年份才是显示出来的那个：跨年那一刻换个时区就换一年
  const year = t.getUTCFullYear() === +ctx.incidentDate.slice(0, 4) ? '' : `${t.getUTCFullYear()}-`;
  // 毫秒看**原始串写没写**，不看算出来的值：`.000` 与压根没有小数位是两种精度，
  // 按值判的话前者会被静默降格成后者
  const sub = /\d{2}:\d{2}:\d{2}[.,]\d/.test(s) ? `.${p(t.getUTCMilliseconds(), 3)}` : '';
  return (
    `${year}${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}${sub}`
  );
}

/** 认得出来的形状：`YYYY-MM-DD` + 分隔 + `HH:MM:SS`，后面爱带什么带什么（小数秒、时区）。 */
const ISO_ISH = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;

/** 这一天真的存在吗。`Date.UTC` 会把不存在的日子往后挪，挪没挪得看它自己认不认。 */
function isRealDate(y: number, mo: number, d: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** `+08:00` → 480。认不出来时给 null，由调用方退回原始串。 */
function offsetMinutes(tz: string): number | null {
  if (/^[zZ]$/.test(tz.trim())) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz.trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
