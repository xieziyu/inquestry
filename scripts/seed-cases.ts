/**
 * 往开发库里塞几份假调查，只为了看界面。**不是自检**——它什么都不断言。
 *
 * 走的是真写路径（append `events` + `applyEvent`），所以塞进去的东西经得起一次重放；
 * 直接 INSERT 投影表的话，下次升级重放完这些调查就空了。
 *
 * 跑：`npm run seed`（它把 better-sqlite3 的 ABI 一并切好，别自己拼 tsx）。
 * 换库：`npm run seed -- <db 路径>`，默认是 app 的 userData 那份。
 * 工作区目录默认全是仓库根，想有区分度给 `INQUESTRY_SEED_ROOTS=/a,/b`。
 *
 * 重复跑是安全的：case id 全是写死的，重跑先把它们连事件带投影删干净再重建。
 *
 * 每份专攻一类界面状态，改这里之前先看各自头上那段说明——**它们不是随机数据，
 * 是照着"哪些分支平时看不到"挑的**：五种 verdict_shape 各一份，收尾三档各一份，
 * 而 `case_seed_upload` 是唯一 `open` 且定稿闸通着的那份（定稿确认块只有它按得出来）。
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { storeBlob } from '../src/backend/db/blobs.js';
import { blobDir, openDatabase } from '../src/backend/db/database.js';
import type { DomainEvent } from '../src/backend/db/events.js';
import { applyEvent } from '../src/backend/db/projector.js';
import { parseOccurredAt } from '../src/backend/db/timebase.js';

/** 仓库根。**从脚本自己的位置算，不用 `process.cwd()`**——从别的目录调用它时后者是错的。 */
const REPO = path.resolve(fileURLToPath(import.meta.url), '../..');

/**
 * app 的 `userData`，按平台展开。
 *
 * **这里只能重算一份，不能调 `app.getPath('userData')`**：那要一个起来的 Electron app，
 * 而这个脚本跑在裸 node 上。三条分支抄的是 Electron 的规则，目录名取 `productName`。
 * 对不上的表现是"跑完了，但 app 里什么都没有"——两边各写各的库，谁都不报错。
 */
function userData(): string {
  const name = 'Inquestry';
  if (process.platform === 'darwin') return path.join(homedir(), 'Library/Application Support', name);
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData/Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), name);
}

const dbFile = process.argv[2] ?? path.join(userData(), 'inquestry.db');
const dir = blobDir(dbFile);

const TZ = '+08:00';
const T = (s: string) => Date.parse(`${s}${TZ}`);

/**
 * 各份调查的工作区目录（`cases.project_root`）。
 *
 * 默认全指向仓库自己：**它必须是真存在的目录**——重开一份还开着的调查会拿它当
 * agent 的 cwd，指到一个不存在的路径上，那一轮起不来，而失败点离这里很远。
 * 想让列表上那一栏有点区分度就给 `INQUESTRY_SEED_ROOTS`，逗号分隔，按顺序取；
 * 给少了就循环用，一个不给就全是仓库根。
 */
const ROOTS = (process.env.INQUESTRY_SEED_ROOTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const root = (i: number) => (ROOTS.length ? ROOTS[i % ROOTS.length]! : REPO);

const db = openDatabase(dbFile);

// ─────────────────────────── 写入面 ───────────────────────────

/** 与 `sqlite-store.emitTo` 同形：事件先落 `events`，再由同一个投影器 apply。 */
function emit(caseId: string, sessionId: string | null, ev: DomainEvent) {
  db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO events (case_id,session_id,type,payload,created_at) VALUES (?,?,?,?,?)`)
      .run(caseId, sessionId, ev.type, JSON.stringify(ev.payload), (ev.payload as { at?: number }).at ?? Date.now());
    // 投影认的 seq 就是刚落下那条事件的 seq（同 `emitTo`）——假数据也得经得起一次重放
    applyEvent(db, ev, { blobDir: dir, caseId, seq: Number(lastInsertRowid) });
  })();
}

/**
 * 把一个 case 连事件带投影抹掉，好让这个脚本能反复跑。
 *
 * 两张 FTS 表不吃外键的 CASCADE，得按 case_id 自己删——留着的话重跑一次，
 * 跨案检索就把同一句话翻出两条。`blobs` 是全局内容寻址的，不动它（磁盘上那几份留着无害）。
 */
function wipe(caseId: string) {
  db.transaction(() => {
    db.prepare(`DELETE FROM narrative_fts WHERE case_id=?`).run(caseId);
    db.prepare(`DELETE FROM payload_fts WHERE case_id=?`).run(caseId);
    db.prepare(`DELETE FROM events WHERE case_id=?`).run(caseId);
    db.prepare(`DELETE FROM cases WHERE id=?`).run(caseId);
  })();
}

function blob(caseId: string, text: string, at: number, mime = 'text/plain'): string {
  const b = storeBlob(dir, text, mime);
  emit(caseId, null, { type: 'blob.stored', payload: { ...b, at } });
  return b.sha256;
}

function uiState(caseId: string, value: { agent: unknown; takeover: boolean }) {
  db.prepare(
    `INSERT INTO case_ui_state (case_id,value) VALUES (?,?)
     ON CONFLICT(case_id) DO UPDATE SET value=excluded.value`,
  ).run(caseId, JSON.stringify(value));
}

type CallSpec = {
  id: string;
  session: string;
  step: string;
  tool: string;
  input: unknown;
  at: number;
  /** 缺省 = 还没收（`pending`）。 */
  output?: string;
  endAt?: number;
  status?: 'done' | 'failed' | 'denied' | 'abandoned';
  gate?: 'auto' | 'auto_deny' | 'allow' | 'rewrite' | 'deny' | 'timeout';
  origin?: 'agent' | 'operator';
  agentId?: string;
  /** rewrite 那一档：闸门改过参数，改写后的语句要一起回传给 agent。 */
  gatedInput?: unknown;
  gatedAt?: number;
};

function call(caseId: string, c: CallSpec): string | null {
  emit(caseId, c.session, {
    type: 'toolcall.started',
    payload: {
      callId: c.id,
      sessionId: c.session,
      stepId: c.step,
      agentId: c.agentId,
      toolName: c.tool,
      origin: c.origin ?? 'agent',
      input: JSON.stringify(c.input),
      inputRewritten: false,
      gateDecision: c.gate ?? 'auto',
      at: c.at,
    },
  });
  // 闸门后于 PreToolUse 落定的那一路：判决单独补一条（两者到达顺序不保证）
  if (c.gatedInput !== undefined) {
    emit(caseId, c.session, {
      type: 'toolcall.gated',
      payload: {
        callId: c.id,
        decision: 'rewrite',
        input: JSON.stringify(c.gatedInput),
        at: c.gatedAt ?? c.at + 400,
      },
    });
  }
  if (c.output === undefined) return null;
  const sha = blob(caseId, c.output, c.endAt ?? c.at);
  emit(caseId, c.session, {
    type: 'toolcall.completed',
    payload: { callId: c.id, outputSha256: sha, status: c.status ?? 'done', at: c.endAt ?? c.at + 1200 },
  });
  return sha;
}

type EvidenceSpec = {
  id: string;
  step: string;
  call: string;
  claim: string;
  observedAt: number;
  raw?: string;
  actor?: string;
  anchor?: string;
  /** 与 `anchor` 不同 = 行号被按内容校正过（`locateEvidence`）。UI 高亮用的是这一个。 */
  resolved?: string;
  kind?: 'lines' | 'jsonpath' | 'whole';
  source?: 'auto' | 'operator' | 'agent';
  incidentDate: string;
};

function evidence(caseId: string, e: EvidenceSpec) {
  emit(caseId, null, {
    type: 'evidence.attached',
    payload: {
      evidenceId: e.id,
      stepId: e.step,
      callId: e.call,
      anchorKind: e.kind ?? 'lines',
      anchor: e.anchor ?? null,
      anchorResolved: e.resolved ?? e.anchor ?? null,
      claim: e.claim,
      observedAt: e.observedAt,
      occurredAtMs: e.raw ? parseOccurredAt(e.raw, { incidentDate: e.incidentDate, tzOffset: TZ }).ms : null,
      occurredAtRaw: e.raw ?? null,
      occurredSource: e.source ?? 'auto',
      actor: e.actor ?? null,
    },
  });
}

// ─────────────────────────── 假日志 ───────────────────────────

/** 带行首序号的日志正文：`locateEvidence` 要校正的行号偏移就是这么来的。 */
function numbered(lines: string[], from = 1): string {
  return lines.map((l, i) => `${String(from + i).padStart(4, ' ')} | ${l}`).join('\n');
}

function filler(n: number, at: (i: number) => string): string[] {
  return Array.from({ length: n }, (_, i) => at(i));
}

const GW_LOG = numbered([
  '=== gw-access  2026-08-13 12:00:00 ~ 12:10:00  service=payment-callback ===',
  ...filler(38, (i) => {
    const ms = 12 * 3600 + 2 * 60 + i;
    const hh = String(Math.floor(ms / 3600)).padStart(2, '0');
    const mm = String(Math.floor((ms % 3600) / 60)).padStart(2, '0');
    const ss = String(ms % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}.${String(100 + i).padStart(3, '0')} POST /pay/callback 200 tid=T20260813${1000 + i} rt=${18 + (i % 40)}ms upstream=alipay`;
  }),
  '12:03:01.220 POST /pay/callback 200 tid=T20260813C7741 rt=21ms upstream=alipay retry=0',
  '12:03:01.887 POST /pay/callback 200 tid=T20260813C7741 rt=19ms upstream=alipay retry=1',
  '12:03:02.104 POST /pay/callback 200 tid=T20260813C7741 rt=23ms upstream=alipay retry=2',
  '12:03:02.109 WARN  gateway retry budget exhausted for tid=T20260813C7741 (3/3)',
  ...filler(24, (i) => {
    const ss = String(4 + (i % 50)).padStart(2, '0');
    return `12:03:${ss}.${String(200 + i).padStart(3, '0')} POST /pay/callback 200 tid=T20260813${2000 + i} rt=${17 + (i % 30)}ms upstream=wechat`;
  }),
  '12:03:05.310 ERROR account.credit duplicated tid=T20260813C7741 uid=88213 amount=4900 seq=3',
  '12:03:05.402 INFO  balance after credit uid=88213 balance=14700 (expected 4900)',
  ...filler(20, (i) => `12:0${4 + (i % 5)}:${String(10 + i).padStart(2, '0')}.000 POST /pay/callback 200 tid=T20260813${3000 + i} rt=${20 + (i % 12)}ms`),
]);

const CODE_SNIPPET = numbered([
  'export async function handleCallback(req: CallbackReq) {',
  '  const order = await orders.byTradeId(req.tradeId)',
  '  if (!order) throw new NotFound(req.tradeId)',
  '',
  '  // TODO(2025-11): 这里本来要先占一把幂等锁，等风控那边的 key 规范定下来再补',
  '  await accounts.credit(order.uid, order.amount, { note: req.tradeId })',
  '  await orders.markPaid(order.id)',
  '  return { ok: true }',
  '}',
]);

const MYSQL_JSON = JSON.stringify(
  {
    query: 'select uid, sum(amount) amt, count(*) n from ledger where trade_id = ? group by uid',
    params: ['T20260813C7741'],
    rows: [{ uid: 88213, amt: 14700, n: 3 }],
    elapsedMs: 12,
    server: 'rds-pay-01 (replica)',
  },
  null,
  2,
);

const DENY_NOTE = [
  '这条被拒了：目标是生产库，且是写语句。',
  '想确认入账条数就走只读从库，或者让我把 trade_id 给你、你自己在控制台跑一次。',
].join('\n');

const TOP_LOG = numbered([
  'top - 10:41:02 up 61 days,  3:12,  1 user,  load average: 31.20, 28.44, 19.03',
  'Tasks: 412 total,  33 running, 379 sleeping',
  '%Cpu(s): 96.4 us,  2.1 sy,  0.0 ni,  0.4 id,  0.0 wa',
  'MiB Mem : 64268.0 total,  9120.5 free, 48211.2 used,  6936.3 buff/cache',
  '',
  '   PID USER   PR  NI    VIRT    RES  %CPU  %MEM  COMMAND',
  '  8123 app    20   0   12.4g   6.1g 782.0  9.7  java -jar recommend.jar',
  '  8124 app    20   0   12.4g   6.1g  61.3  9.7  java -jar recommend.jar',
  '  1042 root   20   0  1024m   88m   3.1   0.1  containerd',
]);

const CRASH_BY_VER = numbered([
  'app_ver  dt          crash_rate  sessions',
  '5.2.0    2026-08-08       0.31%   1204118',
  '5.2.0    2026-08-09       0.29%   1188402',
  '5.2.0    2026-08-10       0.44%   1210773',
  '5.2.0    2026-08-11       4.12%   1197560',
  '5.1.9    2026-08-10       0.38%    204551',
  '5.1.9    2026-08-11       5.07%    201338',
  '5.1.8    2026-08-11       0.35%     18220',
]);

const CRASH_BY_OS = numbered([
  'os_ver  device      n      pct',
  '26.1    iPhone XR   14882  30.1%',
  '26.1    iPhone 11   11204  22.6%',
  '26.1    iPhone X     9877  20.0%',
  '26.1    iPhone 12    5310  10.7%',
  '26.1    iPhone 14    4102   8.3%',
  '26.0    iPhone XR    2201   4.5%',
  '18.7    iPhone 11     980   2.0%',
  '26.1    iPhone 15     892   1.8%',
]);

const CRASH_HOURLY = numbered([
  'hour   os_ver  crash_rate   note',
  '(参考) 26.1 的 OTA 自 2026-08-10T21:00:00+08:00 起分批推送',
  '08:00  26.1         0.41%',
  '10:00  26.1         0.44%',
  '12:00  26.1         0.52%',
  '13:00  26.1         0.61%',
  '14:00  26.1         1.88%   ← 拐点',
  '15:00  26.1         2.94%',
  '16:00  26.1         3.71%',
  '17:00  26.1         4.30%',
  '18:00  26.1         4.92%',
  '18:00  26.0         0.37%',
]);

const CONN_POOL = numbered([
  'ts        pool        active  idle  waiting  max',
  '15:58:00  order-svc       31    69        0  100',
  '16:00:00  order-svc       88    12        4  100',
  '16:01:00  order-svc      100     0       47  100',
  '16:02:00  order-svc      100     0      212  100',
  '16:05:00  order-svc      100     0      604  100',
  '16:05:00  coupon-svc      12    38        0   50',
]);

const SLOW_LOG = numbered([
  '# Time: 2026-08-09T16:01:12+08:00  User: coupon@10.4.2.31',
  '# Query_time: 8.412  Lock_time: 0.000  Rows_examined: 2841903',
  'SELECT * FROM coupon_rule WHERE scene = ? AND status = 1 AND deleted_at IS NULL;',
  '# Time: 2026-08-09T16:01:13+08:00  User: coupon@10.4.2.31',
  '# Query_time: 8.377  Lock_time: 0.000  Rows_examined: 2841903',
  'SELECT * FROM coupon_rule WHERE scene = ? AND status = 1 AND deleted_at IS NULL;',
  '（16:00~16:10 内同一条语句出现 1841 次，平均 8.4s，全部来自 coupon-svc）',
]);

const CACHE_HIT = numbered([
  'ts        key_prefix          hit_rate  qps_origin',
  '13:00:00  coupon:rule:          99.24%          31',
  '14:00:00  coupon:rule:          99.19%          33',
  '14:20:00  coupon:rule:          62.10%         820   ← 发布开始',
  '14:30:00  coupon:rule:          12.04%        3914',
  '16:00:00  coupon:rule:          11.88%        4102',
]);

const KEY_DIFF = numbered([
  'commit 4f0c9ab  2026-08-09 14:12  feat(coupon): 规则支持按人群包区分',
  '--- a/src/coupon/cache.ts',
  '+++ b/src/coupon/cache.ts',
  '@@',
  '-const ruleKey = (scene: string) => `coupon:rule:${scene}`',
  '+const ruleKey = (scene: string, crowdId = "default") =>',
  '+  `coupon:rule:${scene}:${crowdId}`',
  '（旧 key 没有做兼容读，也没有预热；线上 240 万条旧 key 全部失效）',
]);

const EDGE_STATS = numbered([
  'node        region  uploads   ok      fail   ok_rate',
  'edge-sh-03  华东     181420   74745  106675   41.20%',
  'edge-sh-01  华东     176033  175930     103   99.94%',
  'edge-sh-02  华东     168911  168864      47   99.97%',
  'edge-bj-02  华北     203118  203071      47   99.98%',
  'edge-bj-01  华北     198774  198722      52   99.97%',
  'edge-gz-01  华南     154302  154261      41   99.97%',
  'edge-cd-01  西南      88190   88171      19   99.98%',
  '（共 12 个节点，其余 8 个均在 99.94%~99.98%；edge-sh-03 一个节点占了全部失败的 94.1%）',
]);

const EDGE_LOG = numbered([
  '13:02:11.400 edge-sh-03  PUT /avatar/88213.jpg  502  upstream=oss-shanghai  rt=30012ms',
  '13:02:11.884 edge-sh-03  ERROR dial tcp 10.20.4.7:443: i/o timeout (origin oss-shanghai)',
  '13:02:12.010 edge-sh-03  PUT /avatar/71904.jpg  502  upstream=oss-shanghai  rt=30008ms',
  '13:02:12.550 edge-sh-03  WARN  origin health check failed 14 times in a row, still routing',
  '13:02:19.220 edge-sh-01  PUT /avatar/33018.jpg  200  upstream=oss-shanghai  rt=214ms',
]);

const SDK_RETRY = numbered([
  'sdk_ver  attempts  median_retry  fail_after_3',
  '3.4.1           3           1.0x        6.02%',
  '3.4.0           3           1.0x        5.98%',
  '3.3.7           3           1.0x        6.11%',
  '（各版本的重试行为与失败率完全一致，且失败率与节点分布强相关、与版本无关）',
]);

const METRICS = numbered([
  'host           time      p99_ms  cpu_pct',
  'rec-canary-01  10:38:00      76       29',
  'rec-canary-01  10:39:00      78       31',
  'rec-canary-01  10:40:00     412       74',
  'rec-canary-01  10:41:00    2410       96',
  'rec-canary-02  10:40:00     388       71',
  'rec-canary-02  10:41:00    2377       95',
  'rec-prod-11    10:40:00      74       28',
  'rec-prod-11    10:41:00      75       28',
]);

const FLAME = numbered([
  'Sampling 30s, 4001 samples',
  '  62.8%  com.xyz.rec.FeatureCache.load(FeatureCache.java:214)',
  '  61.9%    java.util.regex.Pattern$Loop.match(Pattern.java:4785)',
  '  61.4%      java.util.regex.Pattern$GroupHead.match(Pattern.java:4809)',
  '   9.1%  com.xyz.rec.Ranker.score(Ranker.java:88)',
  '   4.4%  io.netty.channel.nio.NioEventLoop.run(NioEventLoop.java:503)',
]);

// ═══════════════════════════ Case A：已定稿的时序型 ═══════════════════════════
//
// 覆盖：跨两轮会话（序号从 1 重来）· 分叉与子 agent 泳道 · 五种 step 状态 ·
// 六种闸门判决 · 人工回填 · 被校正的锚点 · 基准日期被 agent 改过一天。

function seedPaymentCase() {
  const C = 'case_seed_pay';
  wipe(C);

  const s1 = 'ses_pay_1';
  const s2 = 'ses_pay_2';
  const D = '2026-08-13'; // agent 改过之后的基准
  const chat = (at: number, role: 'user' | 'assistant' | 'system', text: string, session: string | null = null) =>
    emit(C, session, { type: 'chat.appended', payload: { lineId: `ch_${at}`, sessionId: session, role, text, at } });

  emit(C, null, {
    type: 'case.opened',
    payload: {
      caseId: C,
      title: '昨晚 12:03 前后有用户余额被重复入账，客服收到 3 起投诉',
      question:
        '昨晚 12:03 前后有用户余额被重复入账，客服收到 3 起投诉。其中一个是 uid=88213，' +
        '订单 T20260813C7741 只付了 49 元，账上加了三次共 147 元。' +
        '支付回调走的是 gw-access 网关 → payment-callback 服务 → ledger 表。想知道是谁重复了、为什么没被挡住。',
      projectRoot: root(0),
      // 建单是第二天早上，所以这一刻落的是 08-14——它是错的，而且不会有任何报错
      incidentDate: '2026-08-14',
      tzOffset: TZ,
      clues: null,
      at: T('2026-08-14T09:10:00'),
    },
  });
  emit(C, null, {
    type: 'case.renamed',
    payload: { caseId: C, title: '支付回调重复入账', source: 'agent', at: T('2026-08-14T09:10:40') },
  });
  // 读完问题后把基准挪回事发那天：已落库的 occurred_at_ms 会被整体重算一遍
  emit(C, null, {
    type: 'case.timebase_set',
    payload: { caseId: C, incidentDate: D, source: 'agent', at: T('2026-08-14T09:10:50') },
  });

  chat(T('2026-08-14T09:11:00'), 'system', '已新建调查，基准日期按你说的定在 2026-08-13。');

  // ── 第一轮会话 ──────────────────────────────────────────────
  emit(C, s1, {
    type: 'session.started',
    payload: { sessionId: s1, caseId: C, backend: 'claude', nativeSessionRef: 'sess_9f2a11', model: 'opus', effort: 'high', at: T('2026-08-14T09:20:00') },
  });
  chat(T('2026-08-14T09:20:10'), 'user', '先确认到底是上游投了三次，还是我们自己入了三次账。', s1);

  // #1 主线：上游重复投递？——查完被自己否掉
  const st1 = 'st_pay_1';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st1, sessionId: s1, ordinal: 1, kind: 'normal', direction: '上游支付渠道对同一笔单重复投递了回调', at: T('2026-08-14T09:20:30') },
  });
  call(C, { id: 'tc_pay_1', session: s1, step: st1, tool: 'aliyun-sls-log-query', at: T('2026-08-14T09:20:40'), endAt: T('2026-08-14T09:21:02'), output: GW_LOG, input: { logstore: 'gw-access', query: 'service: payment-callback and tid: T20260813C7741', from: '2026-08-13 12:00:00', to: '2026-08-13 12:10:00' } });
  // 闸门后于 PreToolUse 落定的那一路：started 先带着 auto 落，判决由随后那条 gated 改写
  call(C, { id: 'tc_pay_2', session: s1, step: st1, tool: 'Bash', at: T('2026-08-14T09:21:20'), endAt: T('2026-08-14T09:21:26'), gatedInput: { command: "curl -s 'https://ops.internal/api/pay/callback-log?tid=T20260813C7741&limit=50'" }, input: { command: "curl -s 'https://ops.internal/api/pay/callback-log?tid=T20260813C7741'" }, output: '{"upstream":"alipay","delivered":1,"deliveredAt":"2026-08-13T12:03:01+08:00","ackedAt":"2026-08-13T12:03:01+08:00"}', });

  // anchor ≠ resolved 的那条：agent 报的行号来自它看到的正文（自带一套行首序号），
  // 与 blob 的物理行差了两行，`locateEvidence` 按内容把它校正到 40
  evidence(C, { incidentDate: D, id: 'ev_pay_1', step: st1, call: 'tc_pay_1', claim: '同一 tid 在 900ms 内进了三次 /pay/callback，第二、三次带 retry=1 / retry=2', observedAt: T('2026-08-14T09:21:10'), raw: '12:03:01.220', actor: 'gw-access', anchor: '38', resolved: '40' });
  evidence(C, { incidentDate: D, id: 'ev_pay_2', step: st1, call: 'tc_pay_1', claim: '网关自己打了「retry budget exhausted 3/3」，说明这三次都是网关补发的', observedAt: T('2026-08-14T09:21:12'), raw: '12:03:02.109', actor: 'gw-access', anchor: '43' });
  evidence(C, { incidentDate: D, id: 'ev_pay_3', step: st1, call: 'tc_pay_2', claim: '上游只投递了一次并且当场 ack，重复不在渠道那边', observedAt: T('2026-08-14T09:22:00'), raw: '2026-08-13T12:03:01+08:00', actor: 'alipay', kind: 'jsonpath', anchor: '$.delivered' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st1, status: 'refuted', verdict: '上游只投了一次。三次回调是我们自己的网关在 200 都已经返回之后又补发的，方向不对。', confidence: 0.9, at: T('2026-08-14T09:24:00') },
  });

  // #2 主线：MQ 重复消费？——后来被第二轮会话的结论顶掉
  const st2 = 'st_pay_2';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st2, sessionId: s1, ordinal: 2, kind: 'normal', direction: 'ledger 的写入方是 MQ 消费者，位点回退导致重复消费', at: T('2026-08-14T09:24:30') },
  });
  // 被自动拒的那一档：人根本没被问到（分类器按后果判的）
  call(C, { id: 'tc_pay_3', session: s1, step: st2, tool: 'Bash', at: T('2026-08-14T09:24:50'), endAt: T('2026-08-14T09:24:51'), gate: 'auto_deny', status: 'denied', input: { command: 'mysql -h rds-pay-01 -e "update ledger set amount=0 where trade_id=\'T20260813C7741\'"' }, output: DENY_NOTE });
  // 人自己拒的那一档，与上面那条必须在轨道上分得开
  call(C, { id: 'tc_pay_4', session: s1, step: st2, tool: 'Bash', at: T('2026-08-14T09:25:30'), endAt: T('2026-08-14T09:26:10'), gate: 'deny', status: 'denied', input: { command: 'kafka-consumer-groups --reset-offsets --group ledger-writer --to-earliest --execute' }, output: '这条我拒了：别动线上位点。要看重复只读 ledger 表就够了。' });
  call(C, { id: 'tc_pay_5', session: s1, step: st2, tool: 'Bash', at: T('2026-08-14T09:26:40'), endAt: T('2026-08-14T09:26:58'), gate: 'allow', input: { command: 'kafka-consumer-groups --describe --group ledger-writer' }, output: 'GROUP          TOPIC        PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG\nledger-writer  pay.settled  0          88213441        88213441        0\nledger-writer  pay.settled  1          88104120        88104120        0' });
  evidence(C, { incidentDate: D, id: 'ev_pay_4', step: st2, call: 'tc_pay_5', claim: '消费位点没有回退，两个分区 LAG 都是 0', observedAt: T('2026-08-14T09:27:00'), actor: 'kafka', anchor: '2-3' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st2, status: 'inconclusive', verdict: '位点看着是正常的，但只看当前值证不了昨晚没回退过，先挂着。', confidence: 0.4, at: T('2026-08-14T09:27:20') },
  });

  chat(T('2026-08-14T09:28:00'), 'user', '别在 MQ 上耗了，回调是同步 HTTP 打进来的，直接看 handleCallback 那段代码。', s1);

  // #3 兜底步：#2 收了之后 agent 还没声明下一个方向就先查了两下，harness 就地开一个把调用接住。
  // **真实形态是永远 open、0 条证据、没有结论**——agent 拿不到它的 stepId，`close_step` 无从调用。
  // 一度在这儿补了 close + verdict，那份数据在两个屏上都是假的：舞台会给它一张有结论的卡，
  // 而报告的「遗留问题」按 status 取、不看 kind，于是它混进了那一节
  const st3 = 'st_pay_3';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st3, sessionId: s1, ordinal: 3, kind: 'unclassified', direction: null, at: T('2026-08-14T09:28:20') },
  });
  call(C, { id: 'tc_pay_6', session: s1, step: st3, tool: 'Read', at: T('2026-08-14T09:28:25'), endAt: T('2026-08-14T09:28:27'), input: { file_path: 'src/pay/handleCallback.ts' }, output: CODE_SNIPPET });
  // 超时自动放行的那一档
  call(C, { id: 'tc_pay_7', session: s1, step: st3, tool: 'Grep', at: T('2026-08-14T09:28:40'), endAt: T('2026-08-14T09:31:45'), gate: 'timeout', input: { pattern: 'idempot', path: 'src/pay' }, output: 'src/pay/README.md:12: 幂等键规范见风控那边的 RFC-2211（未定稿）' });

  // #4 挂在 #1 下面的分叉
  const st4 = 'st_pay_4';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st4, sessionId: s1, ordinal: 4, kind: 'normal', parentStepId: st1, direction: '网关补发是因为它没收到 200（连接被提前关掉）', at: T('2026-08-14T09:32:30') },
  });
  call(C, { id: 'tc_pay_8', session: s1, step: st4, tool: 'aliyun-sls-log-query', at: T('2026-08-14T09:32:40'), endAt: T('2026-08-14T09:33:10'), input: { logstore: 'k8s-log', query: 'service: payment-callback and tid: T20260813C7741' }, output: numbered(['12:03:01.241 payment-callback  handleCallback start tid=T20260813C7741', '12:03:01.269 payment-callback  credit ok uid=88213 amount=4900', '12:03:01.271 payment-callback  respond 200 (took 30ms)', '12:03:01.905 payment-callback  handleCallback start tid=T20260813C7741', '12:03:01.933 payment-callback  credit ok uid=88213 amount=4900', '12:03:02.130 payment-callback  handleCallback start tid=T20260813C7741', '12:03:02.158 payment-callback  credit ok uid=88213 amount=4900']) });
  evidence(C, { incidentDate: D, id: 'ev_pay_5', step: st4, call: 'tc_pay_8', claim: '服务端三次都完整跑完并各自返回了 200，不是连接被掐断', observedAt: T('2026-08-14T09:33:20'), raw: '12:03:01.271', actor: 'payment-callback', anchor: '3' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st4, status: 'confirmed', verdict: '网关的重试是「读超时」触发的：它的读超时设成了 500ms，而当时 P99 已经到 620ms。三次都真的执行了。', confidence: 0.78, remediation: '把网关对 payment-callback 的读超时从 500ms 调到 2s，并且只对幂等接口开启自动重试。', at: T('2026-08-14T09:36:00') },
  });

  // 子 agent 泳道：lane key = 起它那次调用的 tool_use_id，兜底步由 harness 建，最后 converged
  const laneCall = 'tc_pay_9';
  call(C, { id: laneCall, session: s1, step: st4, tool: 'Task', at: T('2026-08-14T09:36:20'), endAt: T('2026-08-14T09:41:00'), input: { description: '查历史上有没有同类工单', prompt: '在工单系统里找 2025 年至今所有「重复入账」的工单，列出处理结论。' }, output: '找到 4 张同类工单，其中 3 张的结论都是「网关重试 + 无幂等」。' });
  const stLane = 'st_pay_lane';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: stLane, sessionId: s1, ordinal: 5, kind: 'unclassified', direction: null, parentStepId: st4, lane: laneCall, at: T('2026-08-14T09:36:30') },
  });
  call(C, { id: 'tc_pay_10', session: s1, step: stLane, tool: 'WebFetch', agentId: 'agent_7c31', at: T('2026-08-14T09:37:00'), endAt: T('2026-08-14T09:37:40'), input: { url: 'https://tickets.internal/search?q=重复入账' }, output: 'TK-20250311 重复入账（已关闭）：网关重试 + 服务无幂等\nTK-20250702 重复入账（已关闭）：同上\nTK-20251119 重复扣款（已关闭）：客户端重复提交\nTK-20260204 重复入账（已关闭）：网关重试 + 服务无幂等' });
  evidence(C, { incidentDate: D, id: 'ev_pay_6', step: stLane, call: 'tc_pay_10', claim: '过去 18 个月同样的事发生过三次，每次的结论都是「网关重试 + 服务端无幂等」', observedAt: T('2026-08-14T09:38:00'), actor: 'tickets' });
  emit(C, s1, {
    type: 'lane.converged',
    payload: { stepId: stLane, lane: laneCall, outcome: 'completed', summary: '四张同类工单里有三张的根因写的就是「网关重试 + 服务端无幂等」，且都没有留下代码改动。', at: T('2026-08-14T09:41:10') },
  });

  chat(T('2026-08-14T09:42:00'), 'assistant', '重复来自我们自己：网关读超时补发了两次，而 handleCallback 没有幂等保护。下一轮我去确认 ledger 里到底落了几条。', s1);
  emit(C, s1, { type: 'session.ended', payload: { sessionId: s1, status: 'ended', at: T('2026-08-14T10:05:00') } });

  // ── 第二轮会话：ordinal 从 1 重来，轨道上要标出断点 ──────────
  emit(C, s2, {
    type: 'session.started',
    payload: { sessionId: s2, caseId: C, backend: 'claude', nativeSessionRef: 'sess_a04c73', model: 'sonnet', effort: 'medium', at: T('2026-08-14T14:30:00') },
  });
  chat(T('2026-08-14T14:30:20'), 'user', '接着查。ledger 里那三条是不是都真的落库了？走只读从库查，别碰主库。', s2);

  const st5 = 'st_pay_5';
  emit(C, s2, {
    type: 'step.opened',
    payload: { stepId: st5, sessionId: s2, ordinal: 1, kind: 'normal', direction: 'handleCallback 没有幂等保护，三次回调各写了一条 ledger', at: T('2026-08-14T14:30:40') },
  });
  // 人工回填：`ask_operator` 的产物与自动查询同构落表，只差 origin 一列
  call(C, { id: 'tc_pay_11', session: s2, step: st5, tool: 'ask_operator', origin: 'operator', at: T('2026-08-14T14:31:00'), endAt: T('2026-08-14T14:36:20'), input: { statement: 'select uid, sum(amount) amt, count(*) n from ledger where trade_id = ? group by uid', why: '生产库我这边连不上，只有你能在只读控制台上跑', expect: '同一 trade_id 的入账条数与总额', env: 'rds-pay-01 只读从库' }, output: MYSQL_JSON });
  evidence(C, { incidentDate: D, id: 'ev_pay_7', step: st5, call: 'tc_pay_11', claim: 'ledger 里同一个 trade_id 落了 3 条、共 147 元，与投诉金额完全对上', observedAt: T('2026-08-14T14:36:30'), raw: '2026-08-13 12:03:05.310', actor: 'ledger', kind: 'jsonpath', anchor: '$.rows[0]', source: 'operator' });
  evidence(C, { incidentDate: D, id: 'ev_pay_8', step: st5, call: 'tc_pay_1', claim: '网关在第三次之后打了 duplicated 的 ERROR，但只是记了一笔，没有阻断', observedAt: T('2026-08-14T14:38:00'), raw: '12:03:05.310', actor: 'gw-access', anchor: '66', resolved: '68' });
  emit(C, s2, {
    type: 'step.closed',
    payload: {
      stepId: st5,
      status: 'confirmed',
      verdict: '根因：handleCallback 里的幂等锁从 2025-11 起就只是一条 TODO。网关读超时补发的两次回调因此各自完整执行，ledger 落了三条。',
      confidence: 0.94,
      shape: 'sequence',
      expected: '同一 trade_id 无论回调几次，ledger 只应落一条、账上只加 49 元。',
      actual: '三次回调各写了一条 ledger，账上加了 147 元，且没有任何一层拦下第二、三次。',
      remediation: '① handleCallback 入口按 trade_id 抢一把 Redis 幂等锁（TTL 10 分钟），拿不到就直接返回上一次的结果；② ledger 表给 trade_id 加唯一索引兜底；③ 网关读超时 500ms → 2s。三条都做，①②互为兜底。',
      at: T('2026-08-14T14:40:00'),
    },
  });
  // 这一步一落，第一轮那条 MQ 猜想就该划掉
  emit(C, s2, { type: 'step.superseded', payload: { stepId: st2, by: st5 } });

  // 影响面：定稿前的强制节点
  const st6 = 'st_pay_6';
  emit(C, s2, {
    type: 'step.opened',
    payload: { stepId: st6, sessionId: s2, ordinal: 2, kind: 'impact', direction: '这次重复入账波及多少笔、多少钱', at: T('2026-08-14T14:41:00') },
  });
  call(C, { id: 'tc_pay_12', session: s2, step: st6, tool: 'ask_operator', origin: 'operator', at: T('2026-08-14T14:41:20'), endAt: T('2026-08-14T14:47:40'), input: { statement: "select count(*) n, sum(amount) amt from (select trade_id from ledger where created_at between '2026-08-13 00:00' and '2026-08-14 00:00' group by trade_id having count(*) > 1) t", why: '要一天内所有重复的单，不只是投诉的那三笔', expect: '重复单数与多入账总额' }, output: JSON.stringify({ rows: [{ n: 17, amt: 61300 }], note: '17 笔重复，多入账 613.00 元，涉及 14 个 uid' }, null, 2) });
  evidence(C, { incidentDate: D, id: 'ev_pay_9', step: st6, call: 'tc_pay_12', claim: '事发当天共 17 笔重复入账、多入账 613 元、涉及 14 个用户', observedAt: T('2026-08-14T14:48:00'), actor: 'ledger', kind: 'jsonpath', anchor: '$.rows[0]', source: 'operator' });
  emit(C, s2, {
    type: 'step.closed',
    payload: {
      stepId: st6,
      status: 'confirmed',
      verdict: '2026-08-13 全天 17 笔重复入账，多入账 613.00 元，涉及 14 个 uid。只有 3 个用户来投诉，其余 11 个尚未察觉，需要主动冲正。',
      confidence: 0.9,
      // 产出物：这次调查真正要交出去的东西。**名单落在影响面这一步上**——
      // 「要冲正的是这几个人」本来就属于影响面，而选择器不认 kind（见 queries.effectiveRoster）。
      // 载荷里是 JSON 串，与 `closeStep` 落的一模一样（events.ts 里那段）
      roster: JSON.stringify({
        label: '需要主动冲正的用户',
        idKind: 'uid',
        complete: false,
        basis: '按 2026-08-13 全天 ledger 里同 trade_id 重复的记录聚合；跨天的重复没查',
        items: [
          { id: 'u_10032', note: '已投诉' },
          { id: 'u_10077', note: '已投诉' },
          { id: 'u_10412', note: '已投诉' },
          { id: 'u_10588' },
          { id: 'u_11204' },
          { id: 'u_11390' },
          { id: 'u_11877' },
          { id: 'u_12043' },
          { id: 'u_12561' },
          { id: 'u_12904' },
          { id: 'u_13115' },
          { id: 'u_13470' },
          { id: 'u_13802' },
          { id: 'u_14166' },
        ],
      }),
      metrics: JSON.stringify([
        { label: '重复入账笔数', value: '17 笔', bound: 'exact', basis: '2026-08-13 全天，按 trade_id 去重后统计' },
        { label: '多入账金额', value: '613.00 元', bound: 'exact', basis: '同上' },
        { label: '涉及用户', value: '14', bound: 'exact', basis: '同上；其中 3 个已投诉' },
        { label: '幂等锁缺失时长', value: '9 个月', bound: 'lower', basis: 'TODO 是 2025-11 提交的，更早的版本没查' },
      ]),
      at: T('2026-08-14T14:49:00'),
    },
  });

  // 遗留问题：哪怕是空的也要出现
  const st7 = 'st_pay_7';
  emit(C, s2, {
    type: 'step.opened',
    payload: { stepId: st7, sessionId: s2, ordinal: 3, kind: 'leftover', direction: '这一轮没查清、留给下一次的', at: T('2026-08-14T14:50:00') },
  });
  emit(C, s2, {
    type: 'step.closed',
    payload: { stepId: st7, status: 'inconclusive', verdict: '① P99 为什么在 12:03 冲到 620ms 没查（当时正好在跑一次全量特征刷新，只是时间上对得上）；② 网关的自动重试是哪一版加上去的，配置仓库里没有对应的提交。', confidence: 0.5, at: T('2026-08-14T14:52:00') },
  });

  chat(T('2026-08-14T14:53:00'), 'assistant', '影响面和遗留问题都收了，可以定稿。形态我按时序型声明了——三次回调的先后顺序就是这次故障的主体。', s2);
  chat(T('2026-08-14T14:55:00'), 'user', '行，定稿。', s2);

  emit(C, s2, { type: 'session.ended', payload: { sessionId: s2, status: 'ended', at: T('2026-08-14T15:00:00') } });
  emit(C, null, { type: 'case.verdict_decided', payload: { caseId: C, shape: 'sequence', at: T('2026-08-14T15:05:00') } });
  emit(C, null, { type: 'case.status_changed', payload: { caseId: C, status: 'closed', at: T('2026-08-14T15:05:10') } });

  uiState(C, { agent: { backend: 'claude', model: 'opus', effort: 'high' }, takeover: false });
}

// ═══════════════════════════ Case B：还开着的状态型 ═══════════════════════════
//
// 覆盖：还开着的 step · 上一个进程遗留的 abandoned 调用 · 失败的工具调用 ·
// 失败收口的支线 · 崩掉的会话 · 基准日期还停在 intake（界面要标它没被确认过）·
// 影响面 / 遗留问题都还缺（定稿闸拦着）· 形态由 agent 声明成 state，报告只能预览。

function seedCpuCase() {
  const C = 'case_seed_cpu';
  wipe(C);

  const s1 = 'ses_cpu_1';
  const D = '2026-08-15';
  const chat = (at: number, role: 'user' | 'assistant' | 'system', text: string, session: string | null = null) =>
    emit(C, session, { type: 'chat.appended', payload: { lineId: `chc_${at}`, sessionId: session, role, text, at } });

  emit(C, null, {
    type: 'case.opened',
    payload: {
      caseId: C,
      title: '灰度那两台机器今早 10:40 起 CPU 一直打满',
      question:
        '灰度那两台机器（rec-canary-01/02）今早 10:40 起 CPU 一直打满，接口 P99 从 80ms 涨到 2.4s。' +
        '同一时间全量机器完全正常。昨晚灰度上过一版推荐服务，但回滚之后 CPU 也没降下来。',
      projectRoot: root(1),
      incidentDate: D,
      tzOffset: TZ,
      clues: null,
      at: T('2026-08-15T10:52:00'),
    },
  });
  // 这一份**故意不发 timebase_set**：`incident_date_source` 停在 intake，界面上那个「还没确认过」要看得见
  emit(C, null, {
    type: 'case.renamed',
    payload: { caseId: C, title: '灰度机 CPU 打满', source: 'agent', at: T('2026-08-15T10:52:30') },
  });
  chat(T('2026-08-15T10:52:40'), 'system', '已新建调查。基准日期按本机当天填的（2026-08-15），还没有人确认过。');

  emit(C, s1, {
    type: 'session.started',
    payload: { sessionId: s1, caseId: C, backend: 'claude', nativeSessionRef: 'sess_c1d0f4', model: 'sonnet', effort: 'high', at: T('2026-08-15T10:53:00') },
  });
  chat(T('2026-08-15T10:53:10'), 'user', '回滚都不管用，所以八成不是那版代码本身。先看是谁在吃 CPU。', s1);

  // #1 已证实，且它就是根因候选：声明了 state 形态与应然/实然
  const st1 = 'st_cpu_1';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st1, sessionId: s1, ordinal: 1, kind: 'normal', direction: 'CPU 全被推荐服务的某一段热点代码吃掉了', at: T('2026-08-15T10:53:30') },
  });
  call(C, { id: 'tc_cpu_1', session: s1, step: st1, tool: 'Bash', at: T('2026-08-15T10:53:40'), endAt: T('2026-08-15T10:53:44'), gate: 'allow', input: { command: 'ssh rec-canary-01 "top -b -n1 | head -20"' }, output: TOP_LOG });
  call(C, { id: 'tc_cpu_2', session: s1, step: st1, tool: 'Bash', at: T('2026-08-15T10:54:00'), endAt: T('2026-08-15T10:54:36'), input: { command: 'ssh rec-canary-01 "async-profiler -d 30 -e cpu 8123"' }, output: FLAME });
  call(C, { id: 'tc_cpu_metrics', session: s1, step: st1, tool: 'cls-log-query', at: T('2026-08-15T10:55:10'), endAt: T('2026-08-15T10:55:30'), input: { query: 'host: rec-canary-* | select __time__, p99, cpu_pct order by __time__', from: '2026-08-15 10:20:00', to: '2026-08-15 11:00:00' }, output: METRICS });
  // 时间串就在第 1 行的 top 头上，所以锚点要连头一起框进来——只框第 7 行的话，
  // 高亮的那一段里根本没有它自己声称的那个时刻
  evidence(C, { incidentDate: D, id: 'ev_cpu_1', step: st1, call: 'tc_cpu_1', claim: 'recommend.jar 单进程占 782% CPU，整机 us 96.4%，其余进程都在个位数', observedAt: T('2026-08-15T10:53:50'), raw: '10:41:02', actor: 'rec-canary-01', anchor: '1-7' });
  evidence(C, { incidentDate: D, id: 'ev_cpu_2', step: st1, call: 'tc_cpu_2', claim: '火焰图里 62.8% 的样本落在 FeatureCache.load 里的正则匹配上', observedAt: T('2026-08-15T10:55:00'), actor: 'async-profiler', anchor: '2-4' });
  evidence(C, { incidentDate: D, id: 'ev_cpu_4', step: st1, call: 'tc_cpu_metrics', claim: 'CPU 与 P99 是同一分钟一起跳的：10:40 之前 P99 78ms、CPU 31%，10:41 就到 2.4s / 96%', observedAt: T('2026-08-15T10:55:40'), raw: '10:40:00', actor: 'rec-canary-01', anchor: '3-5' });
  evidence(C, { incidentDate: D, id: 'ev_cpu_5', step: st1, call: 'tc_cpu_metrics', claim: '同一时刻全量机 rec-prod-11 的 P99 与 CPU 都没动，问题只在灰度这两台上', observedAt: T('2026-08-15T10:55:45'), raw: '10:41:00', actor: 'rec-prod-11', anchor: '9' });
  emit(C, s1, {
    type: 'step.closed',
    payload: {
      stepId: st1,
      status: 'confirmed',
      verdict: 'CPU 全被 FeatureCache.load 里的一条正则吃掉了：它在每次 load 时对整份特征名单做回溯匹配，而灰度机的名单是全量机的 40 倍。',
      confidence: 0.86,
      shape: 'state',
      expected: 'FeatureCache 每次 load 只该对新增的特征名做匹配，耗时与增量成正比（全量机上 3ms）。',
      actual: '它对整份名单重新匹配一遍，且那条正则有嵌套量词，在灰度机 12 万条的名单上单次要 4.2s——而 load 每 5s 触发一次，等于永远在跑。',
      remediation: '先把灰度机的特征名单裁回全量机同量级（临时止血）；正则改成不带嵌套量词的写法，或者干脆换成前缀树。回滚之所以不管用，是因为那份超大名单是昨晚灰度时写进配置中心的，代码回了、配置没回。',
      at: T('2026-08-15T10:58:00'),
    },
  });

  // #2 还开着：轨道上要有一条「进行中」
  const st2 = 'st_cpu_2';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st2, sessionId: s1, ordinal: 2, kind: 'normal', parentStepId: st1, direction: '那份 12 万条的特征名单是昨晚灰度时写进配置中心的', at: T('2026-08-15T10:58:30') },
  });
  // 真跑失败的一次：查不到东西的原因常常是它压根没跑成
  call(C, { id: 'tc_cpu_3', session: s1, step: st2, tool: 'Bash', at: T('2026-08-15T10:58:40'), endAt: T('2026-08-15T10:59:12'), status: 'failed', input: { command: 'ssh rec-canary-02 "curl -s http://config-center/api/history?key=rec.feature.allowlist"' }, output: 'curl: (28) Operation timed out after 30001 milliseconds with 0 bytes received\nssh: exit status 28' });
  // 上一个进程留下的 pending，启动清扫时改判 abandoned
  call(C, { id: 'tc_cpu_4', session: s1, step: st2, tool: 'ask_operator', origin: 'operator', at: T('2026-08-15T10:59:30'), endAt: T('2026-08-15T11:02:00'), status: 'abandoned', input: { statement: '在配置中心上导出 rec.feature.allowlist 最近 3 天的变更记录', why: '配置中心的 API 从这台机器连不通', expect: '谁在什么时候把名单从 3000 条改成 12 万条' }, output: '（这次挂起没等到回答：app 重启，上一个进程里的 Promise 没了）' });

  // 一条失败收口的支线
  const laneCall = 'tc_cpu_5';
  call(C, { id: laneCall, session: s1, step: st2, tool: 'Task', at: T('2026-08-15T11:02:30'), endAt: T('2026-08-15T11:06:00'), status: 'failed', input: { description: '翻配置中心的审计日志', prompt: '找出 rec.feature.allowlist 这个 key 最近 7 天的所有写入，带上操作人。' }, output: 'subagent 中途退出：审计日志接口要 SSO，子 agent 拿不到凭据。' });
  const stLane = 'st_cpu_lane';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: stLane, sessionId: s1, ordinal: 3, kind: 'unclassified', direction: null, parentStepId: st2, lane: laneCall, at: T('2026-08-15T11:02:40') },
  });
  call(C, { id: 'tc_cpu_6', session: s1, step: stLane, tool: 'WebFetch', agentId: 'agent_b920', at: T('2026-08-15T11:03:00'), endAt: T('2026-08-15T11:03:20'), status: 'failed', input: { url: 'https://config.internal/audit?key=rec.feature.allowlist' }, output: 'HTTP 302 → https://sso.internal/login?redirect=...' });
  emit(C, s1, {
    type: 'lane.converged',
    payload: { stepId: stLane, lane: laneCall, outcome: 'failed', summary: '没拿到审计日志：接口跳 SSO 登录，我这边没有凭据。这条要人来查。', at: T('2026-08-15T11:06:10') },
  });

  // #3 被否掉的方向
  const st3 = 'st_cpu_3';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st3, sessionId: s1, ordinal: 4, kind: 'normal', direction: 'CPU 打满是因为灰度机的实例规格比全量机小', at: T('2026-08-15T11:07:00') },
  });
  call(C, { id: 'tc_cpu_7', session: s1, step: st3, tool: 'Bash', at: T('2026-08-15T11:07:10'), endAt: T('2026-08-15T11:07:14'), input: { command: 'ssh rec-canary-01 "nproc && free -g" && ssh rec-prod-11 "nproc && free -g"' }, output: 'rec-canary-01: 16\nrec-canary-01: total 62  used 47  free 8\nrec-prod-11: 16\nrec-prod-11: total 62  used 21  free 38' });
  evidence(C, { incidentDate: D, id: 'ev_cpu_3', step: st3, call: 'tc_cpu_7', claim: '灰度机与全量机都是 16C/64G，规格完全一样', observedAt: T('2026-08-15T11:07:30'), actor: 'rec-canary-01', anchor: '1-4' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st3, status: 'refuted', verdict: '规格一模一样，两边都是 16C/64G。差的是那份名单的量级，不是机器。', confidence: 0.95, at: T('2026-08-15T11:08:00') },
  });

  chat(T('2026-08-15T11:08:30'), 'assistant', '根因基本清楚了：代码回滚了，但昨晚写进配置中心的那份 12 万条名单没回。还差谁改的它——配置中心的审计日志要 SSO，我拿不到。', s1);
  chat(T('2026-08-15T11:09:00'), 'user', '我去问一下配置中心那边。你先别停，把影响面算出来。', s1);

  // 会话是崩掉的（凭据过期那一路），界面要给重开的入口；影响面与遗留问题都还没有，定稿闸拦着
  emit(C, s1, { type: 'session.ended', payload: { sessionId: s1, status: 'crashed', at: T('2026-08-15T11:20:00') } });

  uiState(C, { agent: { backend: 'claude', model: 'sonnet', effort: 'high' }, takeover: true });
}

// ═══════════════════════════ Case C：归档的半程报告 ═══════════════════════════
//
// 覆盖：`aborted` 与它强制的 `open` 形态 · 报告顶上那句「第 N 步被人为终止」·
// 排除矩阵与遗留问题当主体 · 基准日期是人改的（`operator` 那一档）·
// 归档时被就地收掉的 in-flight 调用。
//
// 🔴 这一份**故意在库里留着一条已证实、还声明了 `chain` 的 step**：归档一律盖成 `open`，
// 报告因此没有根因栏，而 `snapshot.report.rootCause` 照样是有值的。
// 报告屏要是自己按"有就装"取那一栏，这份数据当场就能把它照出来。

function seedCrashCase() {
  const C = 'case_seed_crash';
  wipe(C);

  const s1 = 'ses_crash_1';
  const D = '2026-08-11';
  const chat = (at: number, role: 'user' | 'assistant' | 'system', text: string, session: string | null = null) =>
    emit(C, session, { type: 'chat.appended', payload: { lineId: `chx_${at}`, sessionId: session, role, text, at } });

  emit(C, null, {
    type: 'case.opened',
    payload: {
      caseId: C,
      title: 'iOS 5.2.0 的崩溃率从 0.3% 涨到 4.1%',
      question:
        'iOS 5.2.0 的崩溃率从 0.3% 涨到 4.1%，前天下午开始的。堆栈五花八门，看不出集中在哪一处。' +
        '5.2.0 是一周前全量的，中间没有发过热更新，服务端那几天也没有变更。想知道到底是什么变了。',
      // **故意留空**：`project_root` 这一列本来就可空（立这条规则之前的旧调查就是 NULL），
      // 而工作区与历史调查两屏各有一句「没有工作区」的兜底文案，没有这份数据谁都看不到它。
      // 挑归档那份是因为它已冻结、开不了新会话，空工作区因此没有任何运行时后果
      projectRoot: null,
      incidentDate: '2026-08-12',
      tzOffset: TZ,
      clues: null,
      at: T('2026-08-12T16:05:00'),
    },
  });
  emit(C, null, {
    type: 'case.renamed',
    payload: { caseId: C, title: 'iOS 崩溃率突增', source: 'agent', at: T('2026-08-12T16:05:30') },
  });
  // 基准日期这次是**人自己改的**：agent 从问题里读不出「前天」是哪天
  emit(C, null, {
    type: 'case.timebase_set',
    payload: { caseId: C, incidentDate: D, source: 'operator', at: T('2026-08-12T16:07:00') },
  });
  chat(T('2026-08-12T16:07:10'), 'system', '基准日期已改成 2026-08-11（你改的），这次调查已落库的时间串都按新基准重算过。');

  emit(C, s1, {
    type: 'session.started',
    payload: { sessionId: s1, caseId: C, backend: 'claude', nativeSessionRef: 'sess_31be08', model: 'opus', effort: 'max', at: T('2026-08-12T16:08:00') },
  });
  chat(T('2026-08-12T16:08:20'), 'user', '先别管堆栈，找一下这几天到底什么变了。', s1);

  // #1 被否：不是新版本
  const st1 = 'st_crash_1';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st1, sessionId: s1, ordinal: 1, kind: 'normal', direction: '崩溃是 5.2.0 这一版引进来的', at: T('2026-08-12T16:08:40') },
  });
  call(C, { id: 'tc_crash_1', session: s1, step: st1, tool: 'cls-log-query', at: T('2026-08-12T16:08:50'), endAt: T('2026-08-12T16:09:20'), input: { query: 'select app_ver, dt, crash_rate from crash_daily where dt >= "2026-08-04"' }, output: CRASH_BY_VER });
  // 按天聚合的行**没有"事发瞬间"**，所以它不带 occurredAt：硬填一个 `2026-08-11`
  // 只会解析失败落 NULL（纯日期串两条路都不认），系统时间线上照样没有它
  evidence(C, { incidentDate: D, id: 'ev_crash_1', step: st1, call: 'tc_crash_1', claim: '5.1.9 与 5.2.0 在 08-11 当天一起涨，5.1.9 的涨幅还更大', observedAt: T('2026-08-12T16:09:30'), actor: 'crash-daily', anchor: '6-9' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st1, status: 'refuted', verdict: '不是版本的事：5.1.9 和 5.2.0 在 08-11 一起涨，而 5.1.9 一个月没动过。', confidence: 0.93, at: T('2026-08-12T16:11:00') },
  });

  // #2 已证实，且声明了 chain —— 归档会把它连同这条声明一起盖掉
  const st2 = 'st_crash_2';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st2, sessionId: s1, ordinal: 2, kind: 'normal', direction: '崩溃只集中在某一小撮机型或系统版本上', at: T('2026-08-12T16:11:30') },
  });
  call(C, { id: 'tc_crash_2', session: s1, step: st2, tool: 'cls-log-query', at: T('2026-08-12T16:11:40'), endAt: T('2026-08-12T16:12:10'), input: { query: 'select os_ver, device, count(*) n from crash where dt = "2026-08-11" group by 1,2 order by n desc limit 10' }, output: CRASH_BY_OS });
  evidence(C, { incidentDate: D, id: 'ev_crash_2', step: st2, call: 'tc_crash_2', claim: '92% 的崩溃落在 iOS 26.1 上，而 26.1 是 08-10 推送的', observedAt: T('2026-08-12T16:12:20'), actor: 'crash', anchor: '2-4' });
  evidence(C, { incidentDate: D, id: 'ev_crash_3', step: st2, call: 'tc_crash_2', claim: 'A12 及更老的机型占了其中的 78%，新机几乎不崩', observedAt: T('2026-08-12T16:12:25'), actor: 'crash', anchor: '2-6' });
  call(C, { id: 'tc_crash_hourly', session: s1, step: st2, tool: 'cls-log-query', at: T('2026-08-12T16:12:40'), endAt: T('2026-08-12T16:13:05'), input: { query: 'select hour, os_ver, crash_rate from crash_hourly where dt = "2026-08-11" order by hour' }, output: CRASH_HOURLY });
  evidence(C, { incidentDate: D, id: 'ev_crash_6', step: st2, call: 'tc_crash_hourly', claim: 'iOS 26.1 的 OTA 是 08-10 21:00 开始推的', observedAt: T('2026-08-12T16:13:10'), raw: '2026-08-10T21:00:00+08:00', actor: 'apple-ota', anchor: '2' });
  evidence(C, { incidentDate: D, id: 'ev_crash_7', step: st2, call: 'tc_crash_hourly', claim: '崩溃率的拐点在 14:00，比 OTA 晚了 17 小时——正好是一轮自动更新铺开的时间', observedAt: T('2026-08-12T16:13:15'), raw: '14:00:00', actor: 'crash-hourly', anchor: '7' });
  evidence(C, { incidentDate: D, id: 'ev_crash_8', step: st2, call: 'tc_crash_hourly', claim: '到 18:00 已经涨到 4.9% 并且还在爬，没有回落的迹象', observedAt: T('2026-08-12T16:13:20'), raw: '18:00:00', actor: 'crash-hourly', anchor: '11' });
  emit(C, s1, {
    type: 'step.closed',
    payload: {
      stepId: st2,
      status: 'confirmed',
      // shape 在这儿是**真的声明过**的，报告最后一栏都没装它——归档那一下把形态盖成了 open
      shape: 'chain',
      verdict: '崩溃几乎全在 iOS 26.1 + A12 以下的机型上，而 26.1 是 08-10 开始推的，时间对得上。',
      confidence: 0.71,
      at: T('2026-08-12T16:14:00'),
    },
  });

  // #3 被 #4 顶掉
  const st3 = 'st_crash_3';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st3, sessionId: s1, ordinal: 3, kind: 'normal', parentStepId: st2, direction: '26.1 收紧了后台内存配额，我们被 jetsam 杀了', at: T('2026-08-12T16:14:30') },
  });
  call(C, { id: 'tc_crash_3', session: s1, step: st3, tool: 'Bash', at: T('2026-08-12T16:14:40'), endAt: T('2026-08-12T16:15:10'), gate: 'allow', input: { command: 'grep -c "JetsamEvent" ./crash-dumps/2026-08-11/*.ips' }, output: './crash-dumps/2026-08-11/batch-01.ips:3\n./crash-dumps/2026-08-11/batch-02.ips:1\n（共 1420 份 dump，含 JetsamEvent 的 4 份）' });
  evidence(C, { incidentDate: D, id: 'ev_crash_4', step: st3, call: 'tc_crash_3', claim: '1420 份 dump 里只有 4 份是 Jetsam，占比 0.3%，不足以解释 4.1%', observedAt: T('2026-08-12T16:15:20'), actor: 'crash-dumps', anchor: '3' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st3, status: 'inconclusive', verdict: '内存被杀只占 0.3%，方向不对但也没完全排除（dump 只抓到了一部分）。', confidence: 0.35, at: T('2026-08-12T16:16:00') },
  });

  const st4 = 'st_crash_4';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st4, sessionId: s1, ordinal: 4, kind: 'normal', parentStepId: st2, direction: '26.1 改了某个我们依赖的系统行为，触发了一处一直都在的隐患', at: T('2026-08-12T16:16:30') },
  });
  call(C, { id: 'tc_crash_4', session: s1, step: st4, tool: 'WebSearch', at: T('2026-08-12T16:16:40'), endAt: T('2026-08-12T16:17:30'), input: { query: 'iOS 26.1 release notes background URLSession behavior change' }, output: 'Apple 官方 release notes 只列了安全更新条目；开发者论坛有若干条「26.1 之后 URLSession 后台回调时序变了」的反馈，均无官方确认。' });
  // 归档那一下被就地收掉的调用：SDK 一 close，PostToolUse 永远不会来
  call(C, { id: 'tc_crash_5', session: s1, step: st4, tool: 'cls-log-query', at: T('2026-08-12T16:18:00'), endAt: T('2026-08-12T16:31:00'), status: 'abandoned', input: { query: 'select thread_name, count(*) from crash where dt = "2026-08-11" and os_ver = "26.1" group by 1' }, output: '（这一条没跑完：调查被归档，会话当场收掉了）' });
  emit(C, s1, {
    type: 'step.closed',
    payload: {
      stepId: st4,
      status: 'inconclusive',
      verdict: '查不动了：手上没有 26.1 的真机，堆栈符号化又缺 5.1.9 的 dSYM，只能到「时间上对得上」为止。',
      confidence: 0.3,
      at: T('2026-08-12T16:20:00'),
    },
  });
  emit(C, s1, { type: 'step.superseded', payload: { stepId: st3, by: st4 } });

  // #5 又一条被否的方向，让排除矩阵不止一行
  const st5 = 'st_crash_5';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st5, sessionId: s1, ordinal: 5, kind: 'normal', direction: '是上报侧的问题：崩溃没变多，只是采样率被调高了', at: T('2026-08-12T16:20:30') },
  });
  call(C, { id: 'tc_crash_6', session: s1, step: st5, tool: 'Read', at: T('2026-08-12T16:20:40'), endAt: T('2026-08-12T16:20:42'), input: { file_path: 'config/crash-report.yaml' }, output: numbered(['sampleRate: 1.0   # 2024-03 起一直是全量', 'uploadOnWifiOnly: false', 'maxDumpsPerDay: 5000']) });
  evidence(C, { incidentDate: D, id: 'ev_crash_5', step: st5, call: 'tc_crash_6', claim: '采样率从 2024-03 起就是 1.0，两年没动过', observedAt: T('2026-08-12T16:20:50'), actor: 'crash-report.yaml', anchor: '1' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st5, status: 'refuted', verdict: '采样率两年没动，涨的是真崩溃数不是上报量。', confidence: 0.88, at: T('2026-08-12T16:21:30') },
  });

  // 遗留问题收了，影响面**没有收** —— 归档不强制它，报告里那一栏因此是空的
  const st6 = 'st_crash_6';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st6, sessionId: s1, ordinal: 6, kind: 'leftover', direction: '这次停下来时还挂着的', at: T('2026-08-12T16:22:00') },
  });
  // 「下一步怎么查」在 leftover 步上：没查出来时，"下一步先加哪些观测"才是该留下的东西
  emit(C, s1, {
    type: 'step.closed',
    payload: {
      stepId: st6,
      status: 'inconclusive',
      verdict: '① iOS 26.1 到底改了什么没有定论，只有论坛的零散反馈；② 缺 5.1.9 的 dSYM，那一版的堆栈至今没符号化；③ Jetsam 那条只是占比低，没有真正排除。',
      confidence: 0.4,
      remediation:
        '这次没定位到，下一轮先把观测补上：① 崩溃上报带上 os_ver 与 device 的组合维度（现在只能事后 group by，看不到趋势）；' +
        '② 把 5.1.9 起每一版的 dSYM 归档到构建产物里，现在只留最近三版；③ 借两台 A11/A12 的真机装 26.1 复现；' +
        '④ 给 URLSession 的后台回调加一圈埋点，先证伪或证实那条论坛说法。',
      at: T('2026-08-12T16:23:00'),
    },
  });

  chat(T('2026-08-12T16:24:00'), 'assistant', '目前只能说到「26.1 + 老机型」这一层，再往下要真机和 dSYM。要我继续找旁证吗？', s1);
  chat(T('2026-08-12T16:29:00'), 'user', '不查了，下午要发版救火。先归档，等拿到真机再说。', s1);

  emit(C, s1, { type: 'session.ended', payload: { sessionId: s1, status: 'ended', at: T('2026-08-12T16:30:00') } });
  chat(T('2026-08-12T16:30:05'), 'system', '调查已归档，还挂着的调用已就地收掉。证据一条没删，半程报告照旧能导。');
  // 归档强制 open：**盖掉 #2 上那条 chain 声明**，半程报告因此没有根因栏
  emit(C, null, { type: 'case.verdict_decided', payload: { caseId: C, shape: 'open', at: T('2026-08-12T16:30:10') } });
  emit(C, null, { type: 'case.status_changed', payload: { caseId: C, status: 'aborted', at: T('2026-08-12T16:30:20') } });

  uiState(C, { agent: { backend: 'claude', model: 'opus', effort: 'max' }, takeover: false });
}

// ═══════════════════════════ Case D：因果链型，已定稿 ═══════════════════════════
//
// 链条**按调查先后串**（`chainBody` 的注释：库里没有表达因果的字段，`parent_step_id`
// 说的是"在这一步之下细分"），所以根因必须是**最后**那条已证实的 step——它同时得是
// 置信度最高的那条，否则 `rootCause` 选的不是它，链条会在中间被截断。
//
// 最弱一环取置信度最低的那一环，这里是 #4（0.55）：故意让中间那一环最虚，
// 好让"最弱一环"指向一个真的该被追问的地方，而不是链条的头或尾。

function seedCouponCase() {
  const C = 'case_seed_coupon';
  wipe(C);

  const s1 = 'ses_coupon_1';
  const D = '2026-08-09';
  const chat = (at: number, role: 'user' | 'assistant' | 'system', text: string, session: string | null = null) =>
    emit(C, session, { type: 'chat.appended', payload: { lineId: `chc2_${at}`, sessionId: session, role, text, at } });

  emit(C, null, {
    type: 'case.opened',
    payload: {
      caseId: C,
      title: '下单接口今天下午 16:00 起大面积超时',
      question:
        '下单接口今天下午 16:00 起大面积超时，成功率从 99.9% 掉到 61%，一直没自愈。' +
        'order-svc 的日志里全是「获取连接超时」。DB 那边监控看着没什么异常，' +
        '今天只有优惠券服务在 14:20 发过一版。想知道这两件事有没有关系。',
      projectRoot: root(2),
      incidentDate: D,
      tzOffset: TZ,
      clues: null,
      at: T('2026-08-09T16:20:00'),
    },
  });
  emit(C, null, {
    type: 'case.renamed',
    payload: { caseId: C, title: '下单接口全量超时', source: 'agent', at: T('2026-08-09T16:20:30') },
  });
  emit(C, null, {
    type: 'case.timebase_set',
    payload: { caseId: C, incidentDate: D, source: 'agent', at: T('2026-08-09T16:20:40') },
  });

  emit(C, s1, {
    type: 'session.started',
    payload: { sessionId: s1, caseId: C, backend: 'claude', nativeSessionRef: 'sess_5ad217', model: 'opus', effort: 'high', at: T('2026-08-09T16:21:00') },
  });
  chat(T('2026-08-09T16:21:20'), 'user', '从「拿不到连接」这句往回推，别一上来就看优惠券。', s1);

  // 链条第 1 环
  const st1 = 'st_cp_1';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st1, sessionId: s1, ordinal: 1, kind: 'normal', direction: '超时的直接原因是 order-svc 拿不到 DB 连接', at: T('2026-08-09T16:21:40') },
  });
  call(C, { id: 'tc_cp_1', session: s1, step: st1, tool: 'cls-log-query', at: T('2026-08-09T16:21:50'), endAt: T('2026-08-09T16:22:20'), input: { query: 'select ts, pool, active, idle, waiting, max from conn_pool where dt = "2026-08-09" and ts >= "15:55"' }, output: CONN_POOL });
  evidence(C, { incidentDate: D, id: 'ev_cp_1', step: st1, call: 'tc_cp_1', claim: 'order-svc 的连接池在 16:01 打满并再没下来，等待队列一路涨到 604', observedAt: T('2026-08-09T16:22:30'), raw: '16:01:00', actor: 'order-svc', anchor: '4' });
  evidence(C, { incidentDate: D, id: 'ev_cp_2', step: st1, call: 'tc_cp_1', claim: 'coupon-svc 自己那个池只用了 12/50，它不是被自己撑死的', observedAt: T('2026-08-09T16:22:35'), raw: '16:05:00', actor: 'coupon-svc', anchor: '7' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st1, status: 'confirmed', verdict: 'order-svc 的连接池 16:01 打满且没有回落，超时是等连接等出来的，不是 DB 拒绝服务。', confidence: 0.82, at: T('2026-08-09T16:24:00') },
  });

  // 走岔的一条，最后被根因顶掉
  const st2 = 'st_cp_2';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st2, sessionId: s1, ordinal: 2, kind: 'normal', parentStepId: st1, direction: '有人在跑大批量脚本，连接被它占着', at: T('2026-08-09T16:24:30') },
  });
  call(C, { id: 'tc_cp_2', session: s1, step: st2, tool: 'Bash', at: T('2026-08-09T16:24:40'), endAt: T('2026-08-09T16:25:00'), gate: 'allow', input: { command: 'mysql -h rds-order-ro -e "select user, host, count(*) from information_schema.processlist group by 1,2"' }, output: 'user     host            n\ncoupon   10.4.2.31     47\norder    10.4.1.12     52\nadmin    10.4.9.2       1' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st2, status: 'inconclusive', verdict: '没有批量脚本，admin 只有 1 条连接。但 coupon 占了 47 条，比平时多，值得往下看。', confidence: 0.45, at: T('2026-08-09T16:26:00') },
  });

  // 被否的一条：排除矩阵要有内容
  const st3 = 'st_cp_3';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st3, sessionId: s1, ordinal: 3, kind: 'normal', direction: 'DB 本身变慢了（磁盘 / 主从延迟 / 锁竞争）', at: T('2026-08-09T16:26:30') },
  });
  call(C, { id: 'tc_cp_3', session: s1, step: st3, tool: 'cls-log-query', at: T('2026-08-09T16:26:40'), endAt: T('2026-08-09T16:27:10'), input: { query: 'select ts, qps, avg_latency_ms, iops, repl_delay_s from rds_metrics where dt = "2026-08-09"' }, output: numbered(['ts        qps    avg_ms  iops   repl_delay_s', '15:00:00  8412     1.2   3120            0', '16:00:00  8390     1.3   3080            0', '16:05:00  8377     1.4   3104            0']) });
  evidence(C, { incidentDate: D, id: 'ev_cp_3', step: st3, call: 'tc_cp_3', claim: 'DB 侧 QPS、平均延迟、IOPS、主从延迟四项在事发前后都没动', observedAt: T('2026-08-09T16:27:20'), raw: '16:05:00', actor: 'rds-order', anchor: '2-5' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st3, status: 'refuted', verdict: 'DB 没变慢：四项指标平的。慢的是某一类语句，不是这台库。', confidence: 0.9, at: T('2026-08-09T16:28:00') },
  });

  // 链条第 2 环 —— 最弱一环，故意只有 0.55
  const st4 = 'st_cp_4';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st4, sessionId: s1, ordinal: 4, kind: 'normal', parentStepId: st1, direction: '连接是被 coupon-svc 的某条慢查询长期占住的', at: T('2026-08-09T16:28:30') },
  });
  call(C, { id: 'tc_cp_4', session: s1, step: st4, tool: 'ask_operator', origin: 'operator', at: T('2026-08-09T16:28:50'), endAt: T('2026-08-09T16:33:40'), input: { statement: 'pt-query-digest /var/log/mysql/slow.log --since "2026-08-09 16:00:00"', why: '慢日志在 DB 机器上，我这边读不到', expect: '16:00 之后占用时间最长的语句及其来源' }, output: SLOW_LOG });
  evidence(C, { incidentDate: D, id: 'ev_cp_4', step: st4, call: 'tc_cp_4', claim: '同一条 coupon_rule 全表扫在 10 分钟里跑了 1841 次，每次 8.4s、扫 284 万行', observedAt: T('2026-08-09T16:34:00'), raw: '2026-08-09T16:01:12+08:00', actor: 'coupon-svc', anchor: '1-3', source: 'operator' });
  emit(C, s1, {
    type: 'step.closed',
    payload: {
      stepId: st4,
      status: 'confirmed',
      // 0.55：慢日志证明了这条语句在跑，但没有直接证明它占满了 order-svc 那个池——
      // 这一环是链条上最虚的一处，报告里的「最弱一环」指的就是它
      verdict: '连接确实被这条 8.4s 的全表扫占着。但 order-svc 与 coupon-svc 共用同一个 RDS 实例的连接上限，两者之间只有推断、没有直接证据。',
      confidence: 0.55,
      at: T('2026-08-09T16:36:00'),
    },
  });
  emit(C, s1, { type: 'step.superseded', payload: { stepId: st2, by: st4 } });

  // 链条第 3 环
  const st5 = 'st_cp_5';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st5, sessionId: s1, ordinal: 5, kind: 'normal', parentStepId: st4, direction: '那条全表扫是缓存没命中时的回源', at: T('2026-08-09T16:36:30') },
  });
  call(C, { id: 'tc_cp_5', session: s1, step: st5, tool: 'cls-log-query', at: T('2026-08-09T16:36:40'), endAt: T('2026-08-09T16:37:10'), input: { query: 'select ts, key_prefix, hit_rate, qps_origin from cache_stat where dt = "2026-08-09" and key_prefix = "coupon:rule:"' }, output: CACHE_HIT });
  evidence(C, { incidentDate: D, id: 'ev_cp_5', step: st5, call: 'tc_cp_5', claim: '命中率在 14:20 从 99.2% 断崖到 62%，半小时后稳定在 12%，回源 QPS 涨了 130 倍', observedAt: T('2026-08-09T16:37:20'), raw: '14:20:00', actor: 'redis-coupon', anchor: '4-5' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st5, status: 'confirmed', verdict: '缓存命中率 14:20 断崖式下跌到 12%，回源打在同一条没有索引的语句上。14:20 正是那次发布的时间。', confidence: 0.74, at: T('2026-08-09T16:39:00') },
  });

  // 链条末端 = 根因。置信度最高，所以 `rootCause` 选的就是它，链条不会被提前截断
  const st6 = 'st_cp_6';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st6, sessionId: s1, ordinal: 6, kind: 'normal', parentStepId: st5, direction: '14:20 那次发布改了缓存 key 的拼法，旧 key 全部失效', at: T('2026-08-09T16:39:30') },
  });
  call(C, { id: 'tc_cp_6', session: s1, step: st6, tool: 'Bash', at: T('2026-08-09T16:39:40'), endAt: T('2026-08-09T16:39:50'), input: { command: 'git log --since=2026-08-09 -p -- src/coupon/cache.ts' }, output: KEY_DIFF });
  evidence(C, { incidentDate: D, id: 'ev_cp_6', step: st6, call: 'tc_cp_6', claim: 'cache key 从 `coupon:rule:{scene}` 改成了 `{scene}:{crowdId}`，没有兼容读也没有预热', observedAt: T('2026-08-09T16:40:00'), raw: '2026-08-09 14:12:00', actor: 'git', anchor: '5-7' });
  emit(C, s1, {
    type: 'step.closed',
    payload: {
      stepId: st6,
      status: 'confirmed',
      shape: 'chain',
      verdict:
        '根因：4f0c9ab 给 cache key 加了 crowdId 段，240 万条旧 key 一次性全部失效。' +
        '没有兼容读、没有预热，于是命中率塌到 12% → 回源打在一条无索引的全表扫上 → 占满共用的 RDS 连接 → order-svc 拿不到连接。',
      confidence: 0.91,
      remediation:
        '① 立刻回滚 4f0c9ab 或加一层兼容读（新 key 未命中时回落旧 key），命中率会自己爬回来；' +
        '② 给 coupon_rule(scene, status, deleted_at) 建联合索引——这条语句本就不该是全表扫，它只是平时被缓存挡着；' +
        '③ order-svc 与 coupon-svc 分开连接池，不再共用 RDS 的连接上限；' +
        '④ 改缓存 key 的发布纳入 checklist，必须带兼容读或预热之一。',
      at: T('2026-08-09T16:44:00'),
    },
  });

  const st7 = 'st_cp_7';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st7, sessionId: s1, ordinal: 7, kind: 'impact', direction: '这次超时波及多少下单请求、多长时间', at: T('2026-08-09T16:45:00') },
  });
  call(C, { id: 'tc_cp_7', session: s1, step: st7, tool: 'cls-log-query', at: T('2026-08-09T16:45:10'), endAt: T('2026-08-09T16:45:40'), input: { query: 'select count(*) n, sum(if(status >= 500, 1, 0)) fail from access where service = "order-svc" and ts between "16:00" and "17:00"' }, output: JSON.stringify({ rows: [{ n: 512440, fail: 199853 }], window: '16:01 ~ 16:52', note: '按客单价均值 68 元估算，未完成下单约 1359 万元' }, null, 2) });
  evidence(C, { incidentDate: D, id: 'ev_cp_7', step: st7, call: 'tc_cp_7', claim: '51.2 万次下单请求里失败 19.9 万次，持续 51 分钟，估算未完成金额约 1359 万元', observedAt: T('2026-08-09T16:46:00'), actor: 'order-svc', kind: 'jsonpath', anchor: '$.rows[0]' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st7, status: 'confirmed', verdict: '16:01~16:52 共 51 分钟，51.2 万次下单请求失败 19.9 万次（38.9%），估算未完成金额约 1359 万元。优惠券领取受同一条语句拖累，同窗口失败 3.1 万次。', confidence: 0.85, at: T('2026-08-09T16:48:00') },
  });

  const st8 = 'st_cp_8';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st8, sessionId: s1, ordinal: 8, kind: 'leftover', direction: '这次没查清的', at: T('2026-08-09T16:49:00') },
  });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st8, status: 'inconclusive', verdict: '① 「coupon 占满了 order 的连接」只有推断没有直接证据（最弱一环），要复现得在预发上压一次；② 发布是 14:20，超时到 16:01 才爆——中间那 100 分钟缓存是怎么慢慢塌下去的没有细看。', confidence: 0.4, at: T('2026-08-09T16:50:00') },
  });

  chat(T('2026-08-09T16:52:00'), 'assistant', '链条通了：改 key → 缓存塌 → 回源全表扫 → 连接池打满 → 下单超时。最弱的一环是第三跳，那一步只有推断。', s1);
  chat(T('2026-08-09T17:10:00'), 'user', '够了，按因果链型定稿。', s1);

  emit(C, s1, { type: 'session.ended', payload: { sessionId: s1, status: 'ended', at: T('2026-08-09T17:15:00') } });
  emit(C, null, { type: 'case.verdict_decided', payload: { caseId: C, shape: 'chain', at: T('2026-08-09T17:16:00') } });
  emit(C, null, { type: 'case.status_changed', payload: { caseId: C, status: 'closed', at: T('2026-08-09T17:16:10') } });

  uiState(C, { agent: { backend: 'claude', model: 'opus', effort: 'high' }, takeover: false });
}

// ═══════════════════════ Case E：分布型，还开着且定稿闸是通的 ═══════════════════════
//
// **这一份是唯一按得出定稿确认块的**：`status='open'`，而 impact 与 leftover 两步都已收好，
// 所以 `closingGaps` 是空的——报告屏点「定稿」会直接落出确认块。
// 不按「确认定稿」什么都不会变；真按了就冻上了，重跑这个脚本能还原。
//
// 归因切分的主体是 `splitGroups`：**全部证据按 `actor` 归组、多的排前面**，
// 所以 actor 得真的压在一处才看得出"分布型"。另配一条没填 actor 的，好看到「未标注」那一组。

function seedUploadCase() {
  const C = 'case_seed_upload';
  wipe(C);

  const s1 = 'ses_upload_1';
  const D = '2026-08-15';
  const chat = (at: number, role: 'user' | 'assistant' | 'system', text: string, session: string | null = null) =>
    emit(C, session, { type: 'chat.appended', payload: { lineId: `chu_${at}`, sessionId: session, role, text, at } });

  emit(C, null, {
    type: 'case.opened',
    payload: {
      caseId: C,
      title: '今天下午头像上传大量失败，但只有一部分用户遇到',
      question:
        '今天下午 13:00 起头像上传大量失败，客服收到十几起。但奇怪的是复现不了——' +
        '我自己传了五次全成功，隔壁同事也没问题。整体成功率从 99.9% 掉到 94% 左右，' +
        '不是全挂但也不小。想知道到底是哪一撮人在失败。',
      projectRoot: root(3),
      incidentDate: D,
      tzOffset: TZ,
      clues: null,
      at: T('2026-08-15T13:05:00'),
    },
  });
  emit(C, null, {
    type: 'case.renamed',
    payload: { caseId: C, title: '头像上传部分失败', source: 'agent', at: T('2026-08-15T13:05:30') },
  });
  emit(C, null, {
    type: 'case.timebase_set',
    payload: { caseId: C, incidentDate: D, source: 'agent', at: T('2026-08-15T13:05:40') },
  });

  emit(C, s1, {
    type: 'session.started',
    payload: { sessionId: s1, caseId: C, backend: 'claude', nativeSessionRef: 'sess_e77b12', model: 'sonnet', effort: 'high', at: T('2026-08-15T13:06:00') },
  });
  chat(T('2026-08-15T13:06:20'), 'user', '复现不了这件事本身就是线索。先按各种维度切一刀，看失败压在哪一撮上。', s1);

  // 被否的一条：不是客户端版本
  const st1 = 'st_up_1';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st1, sessionId: s1, ordinal: 1, kind: 'normal', direction: '某个客户端 SDK 版本的重试逻辑有问题', at: T('2026-08-15T13:06:40') },
  });
  call(C, { id: 'tc_up_1', session: s1, step: st1, tool: 'cls-log-query', at: T('2026-08-15T13:06:50'), endAt: T('2026-08-15T13:07:20'), input: { query: 'select sdk_ver, attempts, median_retry, fail_after_3 from upload_stat where dt = "2026-08-15" group by sdk_ver' }, output: SDK_RETRY });
  evidence(C, { incidentDate: D, id: 'ev_up_1', step: st1, call: 'tc_up_1', claim: '三个在用的 SDK 版本重试行为与失败率完全一致，差异不在客户端', observedAt: T('2026-08-15T13:07:30'), actor: 'client-sdk', anchor: '2-4' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st1, status: 'refuted', verdict: '不是客户端：三个版本的失败率都是 6% 上下，一模一样。按版本切没有分层。', confidence: 0.86, at: T('2026-08-15T13:09:00') },
  });

  // 根因：分布型，主体就是这一刀切出来的分组
  const st2 = 'st_up_2';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st2, sessionId: s1, ordinal: 2, kind: 'normal', direction: '失败压在某一个 CDN 边缘节点上', at: T('2026-08-15T13:09:30') },
  });
  call(C, { id: 'tc_up_2', session: s1, step: st2, tool: 'cls-log-query', at: T('2026-08-15T13:09:40'), endAt: T('2026-08-15T13:10:20'), input: { query: 'select node, region, count(*) uploads, sum(ok) ok, ok/uploads ok_rate from upload_edge where dt = "2026-08-15" group by node order by ok_rate' }, output: EDGE_STATS });
  call(C, { id: 'tc_up_3', session: s1, step: st2, tool: 'cls-log-query', at: T('2026-08-15T13:10:40'), endAt: T('2026-08-15T13:11:10'), input: { query: 'node: edge-sh-03 and status >= 500 | select ts, path, status, upstream, rt' }, output: EDGE_LOG });
  // 归因切分按 actor 归组：culprit 那一组要真的压得住，才看得出"只在某一小撮上"
  evidence(C, { incidentDate: D, id: 'ev_up_2', step: st2, call: 'tc_up_2', claim: 'edge-sh-03 的上传成功率只有 41.2%，一个节点吃下了全部失败的 94.1%', observedAt: T('2026-08-15T13:10:30'), actor: 'edge-sh-03', anchor: '2' });
  evidence(C, { incidentDate: D, id: 'ev_up_3', step: st2, call: 'tc_up_3', claim: 'edge-sh-03 回源 oss-shanghai 一律 30s i/o timeout 后返回 502', observedAt: T('2026-08-15T13:11:20'), raw: '13:02:11.400', actor: 'edge-sh-03', anchor: '1-2' });
  evidence(C, { incidentDate: D, id: 'ev_up_4', step: st2, call: 'tc_up_3', claim: 'edge-sh-03 的 origin 健康检查已连续失败 14 次，但它仍在被调度器分配流量', observedAt: T('2026-08-15T13:11:25'), raw: '13:02:12.550', actor: 'edge-sh-03', anchor: '4' });
  evidence(C, { incidentDate: D, id: 'ev_up_5', step: st2, call: 'tc_up_2', claim: '同机房的 edge-sh-01 / edge-sh-02 都是 99.94% 以上，不是华东整个区域的问题', observedAt: T('2026-08-15T13:11:30'), actor: 'edge-sh-03', anchor: '3-4' });
  evidence(C, { incidentDate: D, id: 'ev_up_6', step: st2, call: 'tc_up_2', claim: '华北两个节点均在 99.97% 以上', observedAt: T('2026-08-15T13:11:35'), actor: 'edge-bj-02', anchor: '5-6' });
  evidence(C, { incidentDate: D, id: 'ev_up_7', step: st2, call: 'tc_up_2', claim: '华南 edge-gz-01 99.97%，与平时持平', observedAt: T('2026-08-15T13:11:40'), actor: 'edge-gz-01', anchor: '7' });
  // 这一条**故意不填 actor**：归因切分里会落进「未标注」那一组
  evidence(C, { incidentDate: D, id: 'ev_up_8', step: st2, call: 'tc_up_3', claim: '同一时刻 edge-sh-01 的同类请求 214ms 就回了 200，回源本身是通的', observedAt: T('2026-08-15T13:11:45'), raw: '13:02:19.220', anchor: '5' });
  emit(C, s1, {
    type: 'step.closed',
    payload: {
      stepId: st2,
      status: 'confirmed',
      shape: 'distribution',
      verdict: '失败几乎全压在 edge-sh-03 这一个边缘节点上：它回源 oss-shanghai 一律 30s 超时，而健康检查已连续失败 14 次却仍在被分配流量。复现不了是因为你和同事都没被调度到它。',
      confidence: 0.88,
      // 分布型的「干净组对照」就是这一对：一边是这一撮，一边是其余那些本该长什么样
      expected: '12 个边缘节点回源的是同一个 oss-shanghai，上传成功率应当一致——其余 11 个都在 99.94%~99.98%。健康检查连续失败的节点应当被摘出调度。',
      actual: 'edge-sh-03 成功率 41.2%，独占全部失败的 94.1%；健康检查连挂 14 次后它仍在接流量，摘除根本没有触发。',
      remediation:
        '① 立刻把 edge-sh-03 从调度里摘掉（手动置为 down），成功率会当场回到 99.9%；' +
        '② 查 edge-sh-03 到 oss-shanghai 的那条内网链路——同机房另两个节点是通的，问题在这一台或它那条路由上；' +
        '③ 真正该修的是摘除逻辑：健康检查连挂 14 次没有摘除，说明阈值或执行环节是断的，这才是"下次还会再来一遍"的地方。',
      at: T('2026-08-15T13:14:00'),
    },
  });

  // 还挂着的一条：为什么摘除没触发
  const st3 = 'st_up_3';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st3, sessionId: s1, ordinal: 3, kind: 'normal', parentStepId: st2, direction: '健康检查连挂 14 次为什么没有触发摘除', at: T('2026-08-15T13:14:30') },
  });
  call(C, { id: 'tc_up_4', session: s1, step: st3, tool: 'ask_operator', origin: 'operator', at: T('2026-08-15T13:14:50'), endAt: T('2026-08-15T13:19:20'), input: { statement: '导出 CDN 调度器 health-check 的配置与最近一次摘除记录', why: 'CDN 控制台在内网，我这边打不开', expect: '摘除阈值、检查间隔，以及最近一次真正摘除节点是什么时候' }, output: 'threshold: 20 consecutive failures\ninterval: 30s\nlast_eviction: 2025-12-04T11:20:00+08:00\n（阈值 20 次 × 30s = 10 分钟才会摘；上一次真正摘除是 8 个月前）' });
  evidence(C, { incidentDate: D, id: 'ev_up_9', step: st3, call: 'tc_up_4', claim: '摘除阈值是连续 20 次，而 30s 一次——要 10 分钟才摘得掉，这次只连挂到 14 次', observedAt: T('2026-08-15T13:19:30'), actor: 'cdn-scheduler', anchor: '1-2', source: 'operator' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st3, status: 'inconclusive', verdict: '阈值确实定得偏松（20 次 × 30s = 10 分钟），但这解释不了为什么它挂了几十分钟还在接流量——摘除到底有没有跑过要看调度器日志，那个还没拿到。', confidence: 0.45, at: T('2026-08-15T13:22:00') },
  });

  // 两个强制 step 都收好 —— 这是这一份"按得出定稿确认块"的全部条件
  const st4 = 'st_up_4';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st4, sessionId: s1, ordinal: 4, kind: 'impact', direction: '这次上传失败影响了多少人、多长时间', at: T('2026-08-15T13:23:00') },
  });
  call(C, { id: 'tc_up_5', session: s1, step: st4, tool: 'cls-log-query', at: T('2026-08-15T13:23:10'), endAt: T('2026-08-15T13:23:40'), input: { query: 'select count(distinct uid) users, count(*) fails, min(ts) from upload_edge where dt = "2026-08-15" and node = "edge-sh-03" and ok = 0' }, output: JSON.stringify({ rows: [{ users: 41207, fails: 106675, first_fail: '12:58:40', still_ongoing: true }] }, null, 2) });
  evidence(C, { incidentDate: D, id: 'ev_up_10', step: st4, call: 'tc_up_5', claim: '4.1 万个用户、10.7 万次上传失败，从 12:58 起至今仍在继续', observedAt: T('2026-08-15T13:23:50'), raw: '12:58:40', actor: 'edge-sh-03', kind: 'jsonpath', anchor: '$.rows[0]' });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st4, status: 'confirmed', verdict: '12:58 起至今（尚未结束）4.1 万个用户受影响、10.7 万次上传失败。被调度到 edge-sh-03 的用户里约 59% 传不上去，其余节点的用户完全无感——所以客服只收到十几起。', confidence: 0.9, at: T('2026-08-15T13:25:00') },
  });

  const st5 = 'st_up_5';
  emit(C, s1, {
    type: 'step.opened',
    payload: { stepId: st5, sessionId: s1, ordinal: 5, kind: 'leftover', direction: '还没查清的', at: T('2026-08-15T13:26:00') },
  });
  emit(C, s1, {
    type: 'step.closed',
    payload: { stepId: st5, status: 'inconclusive', verdict: '① edge-sh-03 到 oss-shanghai 那条链路为什么断，同机房另两台是通的，还没拿到网络侧的数据；② 摘除逻辑到底有没有跑过，缺调度器日志；③ 上一次真正摘除是 8 个月前，这套机制是不是一直就没生效过，没查。', confidence: 0.4, at: T('2026-08-15T13:27:00') },
  });

  chat(T('2026-08-15T13:28:00'), 'assistant', '影响面和遗留问题都收了，定稿闸是通的。形态我按分布型声明了——这次故障的主体就是那一刀切出来的分组。', s1);
  chat(T('2026-08-15T13:29:00'), 'user', '先别定稿，等运维把 edge-sh-03 摘了确认成功率回来再说。', s1);

  // **不发 verdict_decided / status_changed**：这一份要留在 open 上，定稿那一下留给你自己点
  emit(C, s1, { type: 'session.ended', payload: { sessionId: s1, status: 'ended', at: T('2026-08-15T13:35:00') } });

  uiState(C, { agent: { backend: 'claude', model: 'sonnet', effort: 'high' }, takeover: false });
}

seedPaymentCase();
seedCpuCase();
seedCrashCase();
seedCouponCase();
seedUploadCase();

const summary = db
  .prepare(
    `SELECT c.id, c.title, c.status, c.verdict_shape AS shape, c.incident_date_source AS src,
            (SELECT COUNT(*) FROM sessions WHERE case_id=c.id) AS sessions,
            (SELECT COUNT(*) FROM steps s JOIN sessions se ON se.id=s.session_id WHERE se.case_id=c.id) AS steps,
            (SELECT COUNT(*) FROM tool_calls t JOIN sessions se ON se.id=t.session_id WHERE se.case_id=c.id) AS calls,
            (SELECT COUNT(*) FROM events WHERE case_id=c.id) AS events
     FROM cases c ORDER BY c.updated_at`,
  )
  .all();
console.table(summary);
console.log(`\n库：${dbFile}\nblob：${dir}`);

db.close();
