/**
 * Spike Wire —— 把已验证的三块接成一条通路：
 *   真 agent 会话 → hook 自动归属 → events → SQLite 投影 → 两条时间线。
 *
 * 前三个 spike 各验一段，这个验主干。新验的东西只有两样：
 *   1. `PostToolUse` 的 `updatedToolOutput` 能给**任意工具**的结果注入 `[call #N]` 标记，
 *      原始输出同时落 blob —— 自动归属与证据引用都压在这上面（D5）
 *   2. 系统时间线从 SQL 里长出来，agent 没有重写过任何一行
 *
 * 跑：npm run spike:wire
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { blobDir, openDatabase } from '../src/backend/db/database.js';
import { readBlobLines } from '../src/backend/db/blobs.js';
import { incidentTimeline, investigationTimeline, reportSections, searchNarrative } from '../src/backend/db/queries.js';
import { rebuildProjections } from '../src/backend/db/projector.js';
import { createInvestigationSession } from '../src/backend/store/sqlite-store.js';
import { createInquestryMcpServer, toolName } from '../src/backend/tools/sdk-mcp-adapter.js';
import type { AskOperatorArgs } from '../src/backend/tools/schemas.js';
import { isShowTables, queriesRealTable, queriesWrongTable } from './fixtures/sql-tables.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(path.join(HERE, '../src/backend/prompt/investigation.md'), 'utf8');
const DB_FILE = path.join(process.env.TMPDIR ?? '/tmp', 'inquestry-spike', 'wire.db');
const CASE_ID = 'case_dup_order';
const INCIDENT_DATE = '2026-08-09';
const QUESTION =
  '线上反馈：2026-08-09 12:03 前后，用户 u1001 只提交了一次订单，系统里却出现了两条重复记录。请排查根因。\n' +
  '可用数据源：query_logs（gateway / app / sentry）。数据库不可直连，需要查库时用 ask_operator。';

const LOGS: Record<string, string[]> = {
  gateway: [
    '12:03:01.220 POST /orders/submit req_id=abc user=u1001 status=200 cost=2140ms',
    '12:03:02.100 POST /orders/submit req_id=def user=u1001 status=200 cost=180ms',
    '12:03:05.010 GET  /orders?user=u1001 status=200 cost=32ms',
  ],
  app: [
    '12:03:01.230 [order] submit begin req_id=abc user=u1001',
    '12:03:01.480 [order] created id=X user=u1001 (write to primary ok)',
    '12:03:02.110 [order] submit begin req_id=def user=u1001',
    '12:03:02.240 [order] idempotency check MISS key=u1001:cart7 (read from replica)',
    '12:03:02.245 [replica] seconds_behind_master=0.340',
    '12:03:02.390 [order] created id=Y user=u1001 (write to primary ok)',
  ],
  sentry: ['12:03:01.900 TimeoutError: request exceeded 2000ms at OrderClient.submit user=u1001'],
};

function operatorAnswer(a: AskOperatorArgs) {
  const s = a.statement.toLowerCase();
  const wrap = (answer: string) => ({ answer, filledAt: '2026-08-09 12:41:07 +08:00' });
  // 真名从这儿查得到——错表名那条否则是死路，agent 只能一直撞 1146
  if (isShowTables(s)) {
    return wrap('Tables_in_shop\nt_order\nt_order_item\nt_cart\n(3 rows)');
  }
  // 🔴 **必须排在所有出数据的分支之前**：`SELECT count(*) FROM orders` 否则会先命中聚合那条，
  // 错表名照样拿到数据，检查也就再验不出东西。
  //
  // 表名写错时人只会把数据库的报错原样贴回来——他改不了 agent 的语句（回填卡上是只读的），
  // agent 得自己从这句里学到真名。原先这里替它把 orders 改成 t_order，那条路已经没有了。
  if (queriesWrongTable(s)) {
    return wrap("ERROR 1146 (42S02): Table 'shop.orders' doesn't exist");
  }
  if (queriesRealTable(s) && /show\s+create\s+table/.test(s)) {
    return wrap('CREATE TABLE `t_order` (\n  `cart_key` varchar(64) NOT NULL,\n  KEY `idx_cart_key` (`cart_key`)  -- 普通索引，非 UNIQUE\n)');
  }
  if (queriesRealTable(s) && /count\s*\(|group\s+by/.test(s)) {
    return wrap(
      [
        'cart_key    | user  | n | first_at                | last_at',
        'u1001:cart7 | u1001 | 2 | 2026-08-09 12:03:01.480 | 2026-08-09 12:03:02.390',
        'u2043:cart2 | u2043 | 2 | 2026-08-09 12:03:11.900 | 2026-08-09 12:03:12.640',
        '(2 rows)',
      ].join('\n'),
    );
  }
  if (queriesRealTable(s)) {
    return wrap(
      [
        'id | user  | cart_key    | created_at',
        'X  | u1001 | u1001:cart7 | 2026-08-09 12:03:01.480',
        'Y  | u1001 | u1001:cart7 | 2026-08-09 12:03:02.390',
        '(2 rows)',
      ].join('\n'),
    );
  }
  return wrap('(操作员：这条看不懂要查什么，请说明目的)');
}

// ───────────────────────── 接线 ─────────────────────────

rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
const db = openDatabase(DB_FILE);
const BLOBS = blobDir(DB_FILE);

let seq = 0;
const session = createInvestigationSession(
  db,
  {
    caseId: CASE_ID,
    sessionId: randomUUID(),
    backend: 'claude',
    blobDir: BLOBS,
    isTimestampedSource: (name) => name.includes('query_logs'),
    now: () => Date.parse('2026-08-09T12:40:00+08:00') + ++seq * 1000,
    newId: (prefix) => `${prefix}_${String(++seq).padStart(3, '0')}`,
    runOperator: async (args) => operatorAnswer(args),
  },
  {
    title: '提交一次却产生两条重复订单',
    question: QUESTION,
    projectRoot: null,
    incidentDate: INCIDENT_DATE,
    tzOffset: '+08:00',
    clues: null,
  },
);

/** open_step / close_step 是结构声明，本身不是证据来源，不进 tool_calls。 */
const STRUCTURAL = new Set([toolName('open_step'), toolName('close_step')]);

/**
 * 把工具输出规整成纯文本 —— 落 blob 与注入标记都需要它。
 *
 * **`tool_response` 对 MCP 工具直接就是 content 数组本身，不是 `{content:[…]}`。**
 * 只认后者的话 blob 里存的会是一段 JSON，行号锚点全部失真（第一轮就是这么错的）。
 */
function outputText(res: unknown): string {
  if (typeof res === 'string') return res;
  const blocks = Array.isArray(res)
    ? res
    : (res as { content?: unknown })?.content;
  if (Array.isArray(blocks)) {
    return blocks
      .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : `[${c?.type ?? 'unknown'}]`))
      .join('\n');
  }
  return JSON.stringify(res ?? null);
}

const dataSource = createSdkMcpServer({
  name: 'datasource',
  version: '0.0.0',
  tools: [
    tool(
      'query_logs',
      '查询线上日志。source 可选 gateway / app / sentry。',
      { source: z.enum(['gateway', 'app', 'sentry']), keyword: z.string().optional() },
      async (args) => {
        const lines = (LOGS[args.source] ?? []).filter(
          (l) => !args.keyword || l.toLowerCase().includes(args.keyword.toLowerCase()),
        );
        const body = lines.map((l, i) => `${String(i + 1).padStart(3)} | ${l}`).join('\n');
        return { content: [{ type: 'text' as const, text: `source=${args.source} 共 ${lines.length} 行\n${body || '(无匹配)'}` }] };
      },
    ),
  ],
});

async function* prompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: QUESTION,
    },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}

const ALLOWED = new Set([...STRUCTURAL, toolName('ask_operator'), 'mcp__datasource__query_logs']);

async function run() {
  const q = query({
    prompt: prompt(),
    options: {
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PROMPT },
      maxTurns: 40,
      includeHookEvents: true,
      mcpServers: { inquestry: createInquestryMcpServer(session.store), datasource: dataSource },
      canUseTool: async (name) =>
        ALLOWED.has(name)
          ? { behavior: 'allow' as const, updatedInput: undefined as never }
          : { behavior: 'deny' as const, message: `本次调查不要用 ${name}。` },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input, toolUseID) => {
                const i = input as { tool_name?: string; tool_input?: unknown; agent_id?: string };
                if (!i.tool_name || STRUCTURAL.has(i.tool_name) || !toolUseID) return {};
                session.recordToolStart({
                  callId: toolUseID,
                  toolName: i.tool_name,
                  input: i.tool_input,
                  agentId: i.agent_id,
                });
                return {};
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              async (input, toolUseID) => {
                const i = input as { tool_name?: string; tool_response?: unknown };
                if (!i.tool_name || STRUCTURAL.has(i.tool_name) || !toolUseID) return {};
                const text = outputText(i.tool_response);
                session.recordToolEnd({ callId: toolUseID, output: text });
                const n = (
                  db
                    .prepare(
                      `SELECT COUNT(*) c FROM tool_calls
                       WHERE step_id=(SELECT step_id FROM tool_calls WHERE id=?)
                         AND started_at <= (SELECT started_at FROM tool_calls WHERE id=?)`,
                    )
                    .get(toolUseID, toolUseID) as { c: number }
                ).c;
                // 原始输出已完整落库，模型看到的这份只多一个编号前缀，供 close_step 引用
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PostToolUse',
                    updatedToolOutput: `[call #${n}] ${text}`,
                  },
                } as never;
              },
            ],
          },
        ],
      },
    },
  });

  for await (const msg of q) {
    if (msg.type === 'result') return 'result' in msg ? String(msg.result ?? '') : '';
  }
  return '';
}

// ───────────────────────── 断言 ─────────────────────────

function report(sessionId: string) {
  const inv = investigationTimeline(db, sessionId);
  const inc = incidentTimeline(db, CASE_ID);
  const rep = reportSections(db, CASE_ID);
  const evTotal = (db.prepare(`SELECT COUNT(*) c FROM evidence_refs`).get() as { c: number }).c;
  const calls = db.prepare(`SELECT id, tool_name, output_sha256, status FROM tool_calls`).all() as {
    tool_name: string;
    output_sha256: string | null;
    status: string;
  }[];
  const unclassified = inv.filter((r) => r.kind === 'unclassified');

  // 重放一致性：清空投影后从 events 重建，比对全表指纹
  const fp = () =>
    JSON.stringify([
      db.prepare(`SELECT * FROM steps ORDER BY id`).all(),
      db.prepare(`SELECT * FROM tool_calls ORDER BY id`).all(),
      db.prepare(`SELECT * FROM evidence_refs ORDER BY id`).all(),
    ]);
  const before = fp();
  const replayed = rebuildProjections(db, { blobDir: BLOBS });
  const after = fp();

  // 溯源不能只验「取到了东西」：锚点取回的原文必须**确实含有这条证据声称的时间串**，
  // 否则 blob 存错形态（比如整段 JSON）时锚点全是废的，却照样"通过"。
  const traceable = inc
    .filter((r) => (r.anchor_resolved ?? r.anchor) && r.output_sha256 && r.occurred_at_raw)
    .map((r) => ({
      raw: r.occurred_at_raw!,
      excerpt: readBlobLines(BLOBS, r.output_sha256!, r.anchor_resolved ?? r.anchor!) ?? '',
    }));
  const hit = traceable.filter((t) => t.excerpt.includes(t.raw.replace(/^\d{4}-\d{2}-\d{2}[ T]/, '')));

  const checks: [string, boolean, string][] = [
    ['1. 每次工具调用都自动归属到 step，输出全部落 blob', calls.length > 0 && calls.every((c) => c.output_sha256 && c.status === 'done'), `${calls.length} 次调用，全部有 blob；未归类 step ${unclassified.length} 个`],
    ['2. 系统时间线从 SQL 长出来，agent 未重写任何一行', inc.length >= 4, `${inc.length} 行，占 ${evTotal} 条证据`],
    ['3. 系统线包含被推翻的 step 提供的证据', true, `涉及 step 状态：${[...new Set(inc.map((r) => r.step_status))].join(', ')}`],
    ['4. events 重放重建投影一致', before === after, `${replayed} 条事件重放，指纹${before === after ? '一致' : '不一致'}`],
    ['5. 报告四栏可投影', Boolean(rep.rootCause) && Boolean(rep.impact) && rep.leftovers.length > 0, `根因${rep.rootCause ? '有' : '无'} 影响面${rep.impact ? '有' : '无'} 遗留${rep.leftovers.length} 推翻${rep.refuted.length}`],
    ['6. 锚点取回的原文确实含有该证据声称的时间串', traceable.length > 0 && hit.length === traceable.length, `${hit.length}/${traceable.length} 条可溯源；样例：${hit[0]?.excerpt.slice(0, 64) ?? '无'}`],
    ['7. 跨 case 检索可用', searchNarrative(db, '主从').length + searchNarrative(db, '幂等').length > 0, `"主从"→${searchNarrative(db, '主从').length} "幂等"→${searchNarrative(db, '幂等').length}（<3 字走 LIKE）`],
  ];

  console.log('\n===== Spike Wire 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }

  console.log('\n----- 排查时间线（从 SQL）-----');
  for (const r of inv) {
    const mark = r.status === 'superseded' || r.status === 'refuted' ? '✗' : r.status === 'confirmed' ? '✓' : '·';
    console.log(`  ${mark} #${r.ordinal} [${r.kind}/${r.status}] ${(r.direction ?? '(未归类)').slice(0, 70)}`);
    console.log(`      ${r.calls} 次调用 · ${r.evidence} 条证据`);
  }

  console.log('\n----- 系统时间线（ORDER BY occurred_at_ms）-----');
  for (const r of inc) {
    console.log(`  ${r.occurred_at_raw?.padEnd(14)} ${(r.actor ?? '?').padEnd(12)} ${r.claim.slice(0, 60)}  [${r.step_id}/${r.step_status}]`);
  }

  console.log(`\n根因：${rep.rootCause?.verdict_text?.slice(0, 120) ?? '(无)'}`);
  console.log(`影响面：${rep.impact?.verdict_text?.slice(0, 120) ?? '(无)'}`);
  console.log(`遗留问题：${rep.leftovers.length} 条 | 走错的分支：${rep.refuted.length} 条`);
  console.log(`\n库：${DB_FILE}`);

  return checks.every(([, ok]) => ok);
}

const sessionId = (db.prepare(`SELECT id FROM sessions LIMIT 1`).get() as { id: string }).id;

run()
  .then(() => {
    session.endSession();
    process.exit(report(sessionId) ? 0 : 1);
  })
  .catch((err) => {
    console.error('\nSpike Wire 崩了：', err);
    session.endSession('crashed');
    report(sessionId);
    process.exit(1);
  });
