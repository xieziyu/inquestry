/**
 * Spike DB —— 验数据模型能否支撑设计里最贵的四个承诺（overview §9.1）。
 *
 *   1. events 是真相：清空投影表后重放能重建出**逐字一致**的投影
 *   2. 两条时间线是两次不同的投影，且**顺序确实不同**（§1.4 的分水岭）
 *   3. 被推翻的结论留得住（superseded 链，D12）
 *   4. 跨 case 检索可用，且中文能搜到（FTS5 tokenizer 的坑）
 *
 * 用 overview §1.4 那个"为什么产生了两条重复记录"当样例。
 *
 * 跑：npm run spike:db
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

// schema 现在是 TS 常量不是 .sql 文件（打包后相对路径必然失效，见 ui.md §10）
import { SCHEMA_SQL } from '../src/backend/db/schema.js';

const CASE_ID = 'case_dup_record';
const T0 = Date.parse('2026-08-09T12:03:00.000+08:00');
const at = (s: number) => T0 + s * 1000;

type Event = { type: string; payload: Record<string, unknown>; createdAt: number };

/**
 * 投影器：写路径与重放路径**共用**这一个函数——否则"可重放"只是句口号。
 */
function apply(db: Database.Database, ev: Event) {
  const p = ev.payload as never as Record<string, string & number>;
  switch (ev.type) {
    case 'case.opened':
      // 基准日与时区是 schema v2 起的硬字段：没有它们 occurred_at_ms 落不成绝对时刻
      db.prepare(
        `INSERT INTO cases (id,title,status,incident_date,tz_offset,created_at,updated_at)
         VALUES (?,?,'open',?,?,?,?)`,
      ).run(CASE_ID, p.title, '2026-08-09', '+08:00', ev.createdAt, ev.createdAt);
      break;
    case 'session.started':
      db.prepare(
        `INSERT INTO sessions (id,case_id,backend,native_session_ref,status,started_at)
         VALUES (?,?,?,?,'live',?)`,
      ).run(p.id, CASE_ID, p.backend, p.nativeRef, ev.createdAt);
      break;
    case 'step.opened':
      db.prepare(
        `INSERT INTO steps (id,session_id,ordinal,kind,direction,status,t_start)
         VALUES (?,?,?,?,?,'open',?)`,
      ).run(p.id, p.sessionId, p.ordinal, p.kind ?? 'normal', p.direction, ev.createdAt);
      break;
    case 'step.closed':
      db.prepare(
        `UPDATE steps SET verdict_text=?, verdict_confidence=?, status=?, t_end=? WHERE id=?`,
      ).run(p.verdict, p.confidence, p.status, ev.createdAt, p.id);
      break;
    case 'step.superseded':
      db.prepare(`UPDATE steps SET status='superseded', superseded_by=? WHERE id=?`).run(p.by, p.id);
      break;
    case 'blob.stored':
      db.prepare(
        `INSERT OR IGNORE INTO blobs (sha256,size,mime,line_count,created_at) VALUES (?,?,?,?,?)`,
      ).run(p.sha256, p.size, p.mime, p.lineCount, ev.createdAt);
      db.prepare(`INSERT INTO payload_fts (sha256,case_id,text) VALUES (?,?,?)`).run(
        p.sha256,
        CASE_ID,
        p.text,
      );
      break;
    case 'toolcall.completed':
      db.prepare(
        `INSERT INTO tool_calls (id,session_id,step_id,tool_name,origin,input_json,
                                 input_rewritten,gate_decision,output_sha256,status,started_at,ended_at)
         VALUES (?,?,?,?,?,?,?,?,?,'done',?,?)`,
      ).run(
        p.id,
        p.sessionId,
        p.stepId,
        p.tool,
        p.origin ?? 'agent',
        p.input,
        p.rewritten ?? 0,
        p.gate ?? 'auto',
        p.sha256,
        ev.createdAt,
        ev.createdAt,
      );
      break;
    case 'evidence.attached':
      db.prepare(
        `INSERT INTO evidence_refs (id,step_id,tool_call_id,anchor_kind,anchor,claim,
                                    observed_at,occurred_at_ms,occurred_at_raw,occurred_source,actor)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        p.id,
        p.stepId,
        p.toolCallId,
        p.anchorKind ?? 'lines',
        p.anchor,
        p.claim,
        ev.createdAt,
        p.occurredAt,
        p.occurredRaw,
        p.occurredSource ?? 'auto',
        p.actor,
      );
      db.prepare(
        `INSERT INTO narrative_fts (ref_id,ref_kind,case_id,text) VALUES (?,'evidence',?,?)`,
      ).run(p.id, CASE_ID, p.claim);
      break;
    default:
      throw new Error(`未知事件类型: ${ev.type}`);
  }
}

function record(db: Database.Database, log: Event[], ev: Event) {
  db.prepare(`INSERT INTO events (case_id,session_id,type,payload,created_at) VALUES (?,?,?,?,?)`).run(
    CASE_ID,
    (ev.payload.sessionId as string) ?? null,
    ev.type,
    JSON.stringify(ev.payload),
    ev.createdAt,
  );
  apply(db, ev);
  log.push(ev);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** 排查顺序与事件真实发生顺序**故意错开**——这正是两条时间线要证明的东西。 */
function seed(db: Database.Database): Event[] {
  const log: Event[] = [];
  const S = 'sess_1';
  const e = (type: string, payload: Record<string, unknown>, tSec: number) =>
    record(db, log, { type, payload, createdAt: at(tSec) });

  e('case.opened', { title: '提交一次却产生两条重复记录' }, 0);
  e('session.started', { id: S, backend: 'claude', nativeRef: 'uuid-aaa' }, 1);

  const appLog = ['12:03:02.240 read replica miss id=X', 'replica lag 340ms'].join('\n');
  const gwLog = '12:03:01.220 POST /submit req_id=abc 200';

  // ── step 1：走错的方向，后面被推翻
  e('step.opened', { id: 'st1', sessionId: S, ordinal: 1, direction: '怀疑前端重复提交：按钮没防抖导致点了两次' }, 10);
  e('blob.stored', { sha256: sha(gwLog), size: gwLog.length, mime: 'text/plain', lineCount: 1, text: gwLog }, 11);
  e('toolcall.completed', { id: 'tc1', sessionId: S, stepId: 'st1', tool: 'query_logs', input: '{"q":"/submit"}', sha256: sha(gwLog) }, 12);
  e(
    'evidence.attached',
    { id: 'ev1', stepId: 'st1', toolCallId: 'tc1', anchor: '1-1', claim: '网关只收到一次用户点击提交', occurredAt: at(1.22), occurredRaw: '12:03:01.220', actor: 'gateway' },
    13,
  );
  e('step.closed', { id: 'st1', verdict: '前端只提交了一次，不是防抖问题', confidence: 0.9, status: 'refuted' }, 14);

  // ── step 2：查写入路径。这一步查到的两条证据，在事故线上一头一尾
  e('step.opened', { id: 'st2', sessionId: S, ordinal: 2, direction: '怀疑服务端写入被重试：同一请求写了两次' }, 20);
  e(
    'evidence.attached',
    { id: 'ev2', stepId: 'st2', toolCallId: 'tc1', anchor: '1-1', claim: '主库写入成功 id=X', occurredAt: at(1.48), occurredRaw: '12:03:01.480', occurredSource: 'operator', actor: 'db-primary' },
    21,
  );
  e(
    'evidence.attached',
    { id: 'ev3', stepId: 'st2', toolCallId: 'tc1', anchor: '1-1', claim: '写入第二条 id=Y', occurredAt: at(2.39), occurredRaw: '12:03:02.390', occurredSource: 'operator', actor: 'db-primary' },
    22,
  );
  e('step.closed', { id: 'st2', verdict: '确实写了两次，第二次来自客户端重试', confidence: 0.85, status: 'confirmed' }, 23);

  // ── step 3：真因。最早发生的事件之一，却是最后才查到
  e('step.opened', { id: 'st3', sessionId: S, ordinal: 3, direction: '怀疑主从复制延迟：重试时读从库未命中，于是又写了一条' }, 30);
  e('blob.stored', { sha256: sha(appLog), size: appLog.length, mime: 'text/plain', lineCount: 2, text: appLog }, 31);
  e('toolcall.completed', { id: 'tc2', sessionId: S, stepId: 'st3', tool: 'query_logs', input: '{"q":"replica"}', rewritten: 1, gate: 'rewrite', sha256: sha(appLog) }, 32);
  e(
    'evidence.attached',
    { id: 'ev4', stepId: 'st3', toolCallId: 'tc2', anchor: '1-2', claim: '服务端读从库未命中 id=X，主从复制延迟 340ms', occurredAt: at(2.24), occurredRaw: '12:03:02.240', actor: 'app' },
    33,
  );
  e(
    'evidence.attached',
    { id: 'ev5', stepId: 'st3', toolCallId: 'tc2', anchor: '1-1', claim: '客户端 2s 超时未收到响应', occurredAt: at(1.9), occurredRaw: '12:03:01.900', actor: 'client' },
    34,
  );
  e(
    'evidence.attached',
    { id: 'ev6', stepId: 'st3', toolCallId: 'tc2', anchor: '1-1', claim: '客户端自动重试', occurredAt: at(2.1), occurredRaw: '12:03:02.100', actor: 'client' },
    35,
  );
  e('step.closed', { id: 'st3', verdict: '根因：主从复制延迟 340ms，重试请求读从库未命中，幂等判断失效', confidence: 0.95, status: 'confirmed' }, 36);
  e('step.superseded', { id: 'st1', by: 'st3' }, 37);

  // ── 结案前的两个强制节点（§6.2）
  e('step.opened', { id: 'st4', sessionId: S, ordinal: 4, kind: 'impact', direction: '量化影响面：多少用户、多长窗口' }, 40);
  e('step.closed', { id: 'st4', verdict: '11 分钟窗口内 37 个用户受影响，共 41 条重复记录', confidence: 0.8, status: 'confirmed' }, 41);
  e('step.opened', { id: 'st5', sessionId: S, ordinal: 5, kind: 'leftover', direction: '为什么客户端超时阈值是 2s，与服务端 P99 是否匹配' }, 45);
  e('step.closed', { id: 'st5', verdict: '未查清：客户端配置来源不明', confidence: 0.3, status: 'inconclusive' }, 46);

  return log;
}

// ─────────────────────────── 断言 ───────────────────────────

function fingerprint(db: Database.Database) {
  const dump = (sql: string) => JSON.stringify(db.prepare(sql).all());
  return sha(
    [
      dump('SELECT * FROM cases ORDER BY id'),
      dump('SELECT * FROM sessions ORDER BY id'),
      dump('SELECT * FROM steps ORDER BY id'),
      dump('SELECT * FROM tool_calls ORDER BY id'),
      dump('SELECT * FROM evidence_refs ORDER BY id'),
      dump('SELECT * FROM blobs ORDER BY sha256'),
    ].join('|'),
  );
}

const INVESTIGATION_TIMELINE = `
  SELECT s.ordinal, s.status, s.direction, s.verdict_text, s.superseded_by,
         (SELECT COUNT(*) FROM tool_calls tc WHERE tc.step_id = s.id) AS calls
  FROM steps s WHERE s.session_id = ? ORDER BY s.ordinal`;

const INCIDENT_TIMELINE = `
  SELECT e.occurred_at_raw, e.actor, e.claim, e.step_id, e.tool_call_id
  FROM evidence_refs e
  JOIN steps st ON st.id = e.step_id
  JOIN sessions se ON se.id = st.session_id
  WHERE se.case_id = ? AND e.occurred_at_ms IS NOT NULL
  ORDER BY e.occurred_at_ms`;

function main() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const log = seed(db);

  const checks: [string, boolean, string][] = [];

  // 1. 重放一致性
  const before = fingerprint(db);
  db.exec(`DELETE FROM evidence_refs; DELETE FROM tool_calls; DELETE FROM steps;
           DELETE FROM sessions; DELETE FROM cases; DELETE FROM blobs;
           DELETE FROM narrative_fts; DELETE FROM payload_fts;`);
  const replay = db.transaction(() => {
    for (const row of db.prepare(`SELECT type,payload,created_at FROM events ORDER BY seq`).all() as {
      type: string;
      payload: string;
      created_at: number;
    }[]) {
      apply(db, { type: row.type, payload: JSON.parse(row.payload), createdAt: row.created_at });
    }
  });
  replay();
  const after = fingerprint(db);
  checks.push([
    `1. events 重放重建投影（${log.length} 条事件）`,
    before === after,
    before === after ? `指纹一致 ${before.slice(0, 12)}…` : `不一致：${before.slice(0, 12)} vs ${after.slice(0, 12)}`,
  ]);

  // 2. 两条时间线顺序不同
  const inv = db.prepare(INVESTIGATION_TIMELINE).all('sess_1') as { ordinal: number }[];
  const inc = db.prepare(INCIDENT_TIMELINE).all(CASE_ID) as { occurred_at_raw: string; step_id: string; claim: string; actor: string }[];
  const discoveryOrder = inc.map((r) => r.step_id);
  const isSorted = discoveryOrder.every((v, i, a) => i === 0 || a[i - 1]! <= v);
  checks.push([
    '2. 事故时间线的顺序 ≠ 排查顺序',
    inc.length === 6 && !isSorted,
    `事故线 ${inc.length} 行，其证据的来源 step 序列 = [${discoveryOrder.join(', ')}]（若单调递增就说明样例没构造出错位）`,
  ]);

  // 3. superseded 链
  const sup = db
    .prepare(`SELECT id, status, superseded_by FROM steps WHERE superseded_by IS NOT NULL`)
    .all() as { id: string; status: string; superseded_by: string }[];
  checks.push([
    '3. 被推翻的结论留得住（D12）',
    sup.length === 1 && sup[0]!.status === 'superseded' && sup[0]!.superseded_by === 'st3',
    JSON.stringify(sup),
  ]);

  // 4. 检索：中文走 narrative_fts(trigram)，英文日志走 payload_fts(unicode61)
  const cn = db
    .prepare(`SELECT ref_id FROM narrative_fts WHERE narrative_fts MATCH ?`)
    .all('"主从复制"') as unknown[];
  const cnShort = db
    .prepare(`SELECT ref_id FROM narrative_fts WHERE narrative_fts MATCH ?`)
    .all('"延迟"') as unknown[];
  const en = db.prepare(`SELECT sha256 FROM payload_fts WHERE payload_fts MATCH ?`).all('replica') as unknown[];
  checks.push([
    '4. 跨 case 检索：中文 ≥3 字命中、英文日志命中',
    cn.length === 1 && en.length === 1,
    `中文"主从复制"→${cn.length} 命中；中文"延迟"(2字)→${cnShort.length} 命中（trigram 的已知下限）；英文 replica→${en.length}`,
  ]);

  // 5. 报告投影（§6.1）
  const rootCause = db
    .prepare(`SELECT verdict_text FROM steps WHERE status='confirmed' AND kind='normal' ORDER BY ordinal DESC LIMIT 1`)
    .get() as { verdict_text: string } | undefined;
  const impact = db.prepare(`SELECT verdict_text FROM steps WHERE kind='impact'`).get() as { verdict_text: string } | undefined;
  const leftover = db.prepare(`SELECT verdict_text FROM steps WHERE status='inconclusive'`).all() as unknown[];
  checks.push([
    '5. 报告四栏可投影（根因/影响面/遗留疑点/走错的分支）',
    Boolean(rootCause && impact) && leftover.length === 1 && sup.length === 1,
    `根因="${rootCause?.verdict_text.slice(0, 24)}…" 影响面=有 遗留=${leftover.length} 被推翻=${sup.length}`,
  ]);

  console.log('\n===== Spike DB 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }

  console.log('\n----- 排查时间线（ORDER BY ordinal）-----');
  for (const r of inv as { ordinal: number; status: string; direction: string; calls: number; superseded_by: string | null }[]) {
    const mark = r.status === 'superseded' ? '✗' : r.status === 'confirmed' ? '✓' : '·';
    console.log(`  ${mark} #${r.ordinal} [${r.status}${r.superseded_by ? `→${r.superseded_by}` : ''}] ${r.direction}  (${r.calls} calls)`);
  }

  console.log('\n----- 事故时间线（ORDER BY occurred_at_ms，同一批数据的另一次投影）-----');
  for (const r of inc) {
    console.log(`  ${r.occurred_at_raw}  ${String(r.actor).padEnd(11)} ${r.claim}   [来自 ${r.step_id}]`);
  }

  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

main();
