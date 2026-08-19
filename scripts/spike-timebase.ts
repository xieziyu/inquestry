/**
 * Spike Timebase —— 验基准日期这一带（D11 / D27，ui.md §8.1）。
 *
 * 基准日期决定「只有时分秒的日志时间串落在哪一天」，而系统时间线就是对 `occurred_at_ms`
 * 的一次 ORDER BY。这一带**每一条错法都是静默的**——报告照旧显示原始串（`12:41:07`），
 * 错的是排序键，导出之前没有任何东西看得出来。所以要验的是：
 *
 *   1. **改基准要把已落库的证据一起改。** 只改 `cases.incident_date` 的话，改之前落的证据
 *      留在旧那天、之后落的在新那天，同一条时间线上两段错开一整天
 *   2. **带日期的串不能被改基准碰。** 它走的是「只补时区」那一档；跟着挪的话，
 *      本来对的那些反而错了
 *   3. **落证据时的基准要现读。** 会话是在改基准之前开的，闭包里那份 intake 已经过期——
 *      这一条与 1 是**同一个错位的两半**，只验一半会以为修好了
 *   4. **重放要复现同样的结果。** 投影是可 truncate 重建的，重建出来的 ms 与写入时不一致，
 *      `events` 就不再是真相
 *   5. **未确认态要关得掉、也要提醒得出来。** agent 确认「就是建单那天」时日期没变，
 *      但那同样是一次确认——落不下来的话提醒永远关不掉
 *   6. **推断日期的三道闸。** 未来的日期一定是推错的，而它落进去之后所有证据都排到未来，
 *      报告看着完全正常
 *
 * 不起真会话：要验的都是 harness 侧的记账与投影，与模型无关。
 *
 * 跑：npm run rebuild:node && npm run spike:timebase
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { blobDir, openDatabase, type Db } from '../src/backend/db/database.js';
import { rebuildProjections } from '../src/backend/db/projector.js';
import { isTimeOnly, parseOccurredAt } from '../src/backend/db/timebase.js';
import {
  createInvestigationSession,
  readTimeBase,
  setCaseTimebase,
  type CaseIntake,
  type SessionContext,
} from '../src/backend/store/sqlite-store.js';
import { checkDate, parseFacts, timebaseFrom } from '../src/main/case-namer.js';

const checks: [string, boolean, string][] = [];

/** 临时换个时区跑一小段。夏令时那条只有在有 DST 的时区才现形，本机（+08:00）永远看不见它。 */
const withTz = <T,>(tz: string, fn: () => T): T => {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
};
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

const INTAKE_DAY = '2026-08-15';
const REAL_DAY = '2026-08-14';
const DAY_MS = 86_400_000;

const intake: CaseIntake = {
  title: '订单查不到',
  question: '昨晚十一点多开始，下单之后订单列表里查不到',
  projectRoot: null,
  incidentDate: INTAKE_DAY,
  tzOffset: '+08:00',
  clues: null,
};

let db: Db;
let blobs: string;
let seq = 0;

const ctx = (caseId: string) => ({ caseId, blobDir: blobs, now: () => Date.now() });

/** `isTimestampedSource` 一律 true：这一带要验的正是带时间戳那条路。 */
function sessionCtx(caseId: string, sessionId: string): SessionContext {
  let n = 0;
  return {
    caseId,
    sessionId,
    backend: 'claude',
    blobDir: blobs,
    isTimestampedSource: () => true,
    now: () => Date.now(),
    newId: (prefix) => `${prefix}_${sessionId}_${++n}`,
    runOperator: async () => ({ answer: '', statement: '' }),
  };
}

type Session = ReturnType<typeof createInvestigationSession>;

/**
 * 在**给定的会话里**跑一步带证据的调查。`occurredAt` 原样进 `occurred_at_raw`。
 *
 * 会话由调用方传进来而不是这里现开：③ 要验的正是「会话开在改基准之前」，
 * 每步都新开一个会话的话，`openCase` 每次都从库里重读一遍 intake，
 * 闭包里那份自然永远是新的——那条检查就永远绿，无论落证据时读的是哪一份。
 */
async function work(session: Session, direction: string, occurredAt: string) {
  const n = ++seq;
  const { stepId } = await session.store.openStep({ direction });
  const callId = `call_${n}`;
  session.recordToolStart({ callId, toolName: 'mcp__datasource__query_logs', input: { q: 'order' } });
  session.recordToolEnd({ callId, output: `命中 1 条\n${occurredAt} order not found\n(end)` });
  const out = await session.store.closeStep({
    stepId,
    status: 'confirmed',
    verdict: `${occurredAt} 查不到订单`,
    confidence: 0.8,
    evidence: [{ callRef: '#1', anchor: '2', claim: `${occurredAt} 的那一条`, occurredAt }],
  });
  return { stepId, warnings: out.warnings };
}

/** 一条证据当前落成的绝对毫秒。 */
function msOf(raw: string): number | null {
  const row = db
    .prepare(`SELECT occurred_at_ms m FROM evidence_refs WHERE occurred_at_raw=?`)
    .get(raw) as { m: number | null } | undefined;
  return row?.m ?? null;
}

async function main() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-timebase-')), 'inquestry.db');
  db = openDatabase(file);
  blobs = blobDir(file);

  // ── ① 建单落 intake，两条证据一纯时分秒一带日期 ─────────────────────────
  //
  // **这一个会话要一直开到 ③**：真实情况就是这样——agent 是在会话里读完问题才回填基准的，
  // 而它开会话时捕获的那份 intake 停在建单那一刻
  const live = createInvestigationSession(db, sessionCtx('case_t', 'sess_live'), intake);
  const first = await work(live, '订单写入是否成功', '23:47:01');
  await work(live, '网关有没有丢请求', `${REAL_DAY} 23:52:30`);

  check(
    '建单那一刻的基准标成未确认',
    readTimeBase(db, 'case_t')?.source === 'intake',
    `source=${readTimeBase(db, 'case_t')?.source}（建单只能按本机当天猜）`,
  );
  check(
    '未确认 + 纯时分秒 → 当场提醒 agent 写全日期',
    first.warnings.some((w) => w.includes('基准日期') && w.includes(INTAKE_DAY)),
    first.warnings.join(' | ') || '（一条 warning 都没有：这条错法事后没有任何东西看得出来）',
  );

  const beforeTimeOnly = msOf('23:47:01');
  const beforeDated = msOf(`${REAL_DAY} 23:52:30`);
  check(
    '落库时纯时分秒按建单那天算，带日期的按它自己那天算',
    beforeTimeOnly === Date.parse(`${INTAKE_DAY}T23:47:01+08:00`) &&
      beforeDated === Date.parse(`${REAL_DAY}T23:52:30+08:00`),
    `时分秒=${beforeTimeOnly} 带日期=${beforeDated}`,
  );
  // 这一步正是「基准猜错了会怎样」：两条本该相隔 5 分钟的证据被排开了近一天，
  // 而系统时间线只按 occurred_at_ms 排
  check(
    '猜错基准的表现：两条相隔 5 分钟的证据被排开了一天（改之前先立此存照）',
    beforeTimeOnly !== null && beforeDated !== null && beforeTimeOnly - beforeDated > 23 * 3600_000,
    `相差 ${(((beforeTimeOnly ?? 0) - (beforeDated ?? 0)) / 3600_000).toFixed(1)} 小时`,
  );

  // ── ② 改基准：已落库的跟着走 ────────────────────────────────────────────
  const moved = setCaseTimebase(db, ctx('case_t'), REAL_DAY, 'agent');
  check('改基准落成了一条事件', moved && readTimeBase(db, 'case_t')?.incidentDate === REAL_DAY,
    `moved=${moved} 现基准=${readTimeBase(db, 'case_t')?.incidentDate}`);

  const afterTimeOnly = msOf('23:47:01');
  const afterDated = msOf(`${REAL_DAY} 23:52:30`);
  check(
    '纯时分秒那条跟着退回一天',
    afterTimeOnly === Date.parse(`${REAL_DAY}T23:47:01+08:00`) &&
      beforeTimeOnly !== null &&
      afterTimeOnly !== null &&
      beforeTimeOnly - afterTimeOnly === DAY_MS,
    `${beforeTimeOnly} → ${afterTimeOnly}（差 ${(((beforeTimeOnly ?? 0) - (afterTimeOnly ?? 0)) / DAY_MS).toFixed(2)} 天）`,
  );
  check(
    '带日期那条一动不动——它压根不经过基准',
    afterDated === beforeDated,
    `${beforeDated} → ${afterDated}`,
  );
  check(
    '改完之后两条回到相隔 5 分 29 秒',
    afterDated !== null && afterTimeOnly !== null && afterDated - afterTimeOnly === 329_000,
    `相差 ${(((afterDated ?? 0) - (afterTimeOnly ?? 0)) / 60_000).toFixed(2)} 分钟`,
  );

  // ── ③ 改基准之后新落的证据用新基准 ─────────────────────────────────────
  //
  // 这一条与 ② 是同一个错位的两半：会话在 `createInvestigationSession` 时捕获过一份 intake，
  // 落证据时若用那份捕获值，改基准之前的被重算了、之后的还按旧基准算——
  // 只验 ② 会以为已经修好了。**用的是 ① 那个还开着的会话**（`live`）
  const later = await work(live, '重试是不是把失败吞了', '23:55:12');
  live.endSession();
  check(
    '改基准之后新落的证据也用新基准（不是会话开场捕获的那份）',
    msOf('23:55:12') === Date.parse(`${REAL_DAY}T23:55:12+08:00`),
    `落成 ${msOf('23:55:12')}，期望 ${Date.parse(`${REAL_DAY}T23:55:12+08:00`)}`,
  );
  check(
    '基准确认过之后，那条提醒不再发',
    !later.warnings.some((w) => w.includes('基准日期')),
    later.warnings.join(' | ') || '（没有 warning，对）',
  );

  // ── ④ 重放要复现同一份结果 ─────────────────────────────────────────────
  rebuildProjections(db, { blobDir: blobs });
  check(
    '重放之后基准与所有 occurred_at_ms 一模一样',
    readTimeBase(db, 'case_t')?.incidentDate === REAL_DAY &&
      readTimeBase(db, 'case_t')?.source === 'agent' &&
      msOf('23:47:01') === afterTimeOnly &&
      msOf('23:55:12') === Date.parse(`${REAL_DAY}T23:55:12+08:00`) &&
      msOf(`${REAL_DAY} 23:52:30`) === afterDated,
    `基准=${readTimeBase(db, 'case_t')?.incidentDate}/${readTimeBase(db, 'case_t')?.source}，` +
      `时分秒=${msOf('23:47:01')}，新落=${msOf('23:55:12')}，带日期=${msOf(`${REAL_DAY} 23:52:30`)}`,
  );

  // ── ⑤ 确认「就是建单那天」也要落得下来 ─────────────────────────────────
  createInvestigationSession(db, sessionCtx('case_same', 'sess_same'), intake).endSession();
  const confirmedSame = setCaseTimebase(db, ctx('case_same'), INTAKE_DAY, 'agent');
  check(
    '日期没变但确认过了：事件照落，未确认态关掉',
    confirmedSame && readTimeBase(db, 'case_same')?.source === 'agent',
    `落没落=${confirmedSame} source=${readTimeBase(db, 'case_same')?.source}` +
      '（只比日期的话它落不下来，那条提醒就永远关不掉）',
  );
  check(
    '同一个日期同一个来源再落一次是空操作',
    setCaseTimebase(db, ctx('case_same'), INTAKE_DAY, 'agent') === false,
    '否则界面每次都要为一次没有变化的写再推一轮快照',
  );

  // ── ⑥ 纯函数：串的分档与推断日期的三道闸 ───────────────────────────────
  check(
    '只有时分秒的才算"要用掉整个基准"',
    isTimeOnly('12:03:01.220') && isTimeOnly('9:03:01') && !isTimeOnly('2026-08-14 23:59:01') &&
      !isTimeOnly('12:03') && !isTimeOnly(null),
    '这条判断有两个用处（提醒 agent、说明重算为什么可以全表跑），错了两处一起错',
  );
  check(
    '带日期无时区的串只补时区，不碰基准日期',
    parseOccurredAt('2026-08-14 23:59:01', { incidentDate: '2000-01-01', tzOffset: '+08:00' }).ms ===
      Date.parse('2026-08-14T23:59:01+08:00'),
    '这正是"改基准可以全表重跑"的前提',
  );
  check(
    '未来的日期一律丢掉',
    checkDate('2026-08-16', INTAKE_DAY) === null && checkDate(INTAKE_DAY, INTAKE_DAY) === INTAKE_DAY,
    '查的是已经发生的事；未来的基准会把所有证据排到未来，而报告看着完全正常',
  );
  check(
    '太久以前的也丢掉（多半是把日志里别的年份当成了事故日）',
    checkDate('2025-03-02', INTAKE_DAY) === null && checkDate(REAL_DAY, INTAKE_DAY) === REAL_DAY,
    `${checkDate('2025-03-02', INTAKE_DAY)} / ${checkDate(REAL_DAY, INTAKE_DAY)}`,
  );
  check(
    '格式不对、或模型压根没给，都当没推断出来',
    checkDate('2026/08/14', INTAKE_DAY) === null && checkDate('昨天', INTAKE_DAY) === null,
    '沿用建单当天并标成未确认，好过落一个解析不了的值',
  );
  check(
    '换季那几天不多算一小时：刚好卡在上限那天照旧收得下',
    withTz('America/New_York', () => checkDate('2026-10-31', '2026-11-30') === '2026-10-31') &&
      withTz('America/New_York', () => checkDate('2026-10-30', '2026-11-30') === null),
    '拿两个本机午夜的毫秒差去除 86400000，跨秋季回拨那次得到 30.0417，' +
      '第 30 天会被当成超界丢掉，而模型推的日期就此整段作废',
  );
  check(
    '不存在的日子一律丢掉（格式是对的，日子是假的）',
    checkDate('2026-02-30', INTAKE_DAY) === null &&
      checkDate('2026-04-31', INTAKE_DAY) === null &&
      setCaseTimebase(db, ctx('case_same'), '2026-02-30', 'agent') === false &&
      readTimeBase(db, 'case_same')?.incidentDate === INTAKE_DAY,
    'Date.parse 只拦得住 13 月：2 月 30 日会被静默挪到 3 月 2 日，' +
      '卡片上写一天、所有纯时分秒的证据落在另一天，两边都不报错',
  );
  check(
    '模型输出：裹了代码块也读得出来',
    parseFacts('```json\n{"title":"订单查不到","incidentDate":"2026-08-14"}\n```', INTAKE_DAY)
      ?.incidentDate === REAL_DAY,
    '说了不要代码块它还是会给，而外面那对反引号会让 JSON.parse 直接失败',
  );
  check(
    '模型输出：解析不了就整个作废，不从半截文本里捞标题',
    parseFacts('抱歉，我需要更多信息', INTAKE_DAY) === null,
    '标题捞错了只是难看，基准日期捞错了整条时间线静默错位，而两件是同一段输出',
  );
  check(
    '模型输出：incidentDate 给 null 时不瞎填',
    parseFacts('{"title":"订单查不到","incidentDate":null}', INTAKE_DAY)?.incidentDate === null,
    '「问题里没说」与「就是今天」是两件事，前者由调用方决定沿用建单当天',
  );
  check(
    '模型输出：给了个用不了的日期，整段作废，不当成「它说没有」',
    parseFacts('{"title":"订单查不到","incidentDate":"2026-08-25"}', INTAKE_DAY) === null &&
      parseFacts('{"title":"订单查不到","incidentDate":"2026/08/14"}', INTAKE_DAY) === null &&
      parseFacts('{"title":"订单查不到","incidentDate":20260814}', INTAKE_DAY) === null,
    '推错了日期还把「未确认」关掉，等于两道网一起没了',
  );
  check(
    '模型输出：漏答日期只丢日期那一项，标题照留',
    parseFacts('{"title":"订单查不到"}', INTAKE_DAY)?.title === '订单查不到' &&
      parseFacts('{"title":"订单查不到"}', INTAKE_DAY)?.incidentDate === undefined,
    '漏答不是答，不该关掉「未确认」；但标题是另一问，为它陪葬只会让列表上留一句截断的原文',
  );
  check(
    '只有「答了」才落基准日期：漏答与问不出来都不落，答了说不准才沿用建单当天',
    timebaseFrom(null, INTAKE_DAY) === null &&
      timebaseFrom({ title: null }, INTAKE_DAY) === null &&
      timebaseFrom({ title: null, incidentDate: null }, INTAKE_DAY) === INTAKE_DAY &&
      timebaseFrom({ title: null, incidentDate: REAL_DAY }, INTAKE_DAY) === REAL_DAY,
    '拒答 / 超时 / spawn 失败 / 漏答也落的话，界面上那条「未确认」就被一个没人签过的确认关掉了',
  );

  console.log('\n===== Spike Timebase 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }
  console.log(`\n临时库：${file}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

void main();
