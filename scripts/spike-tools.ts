/**
 * Spike Tools —— 让真 agent 排查一个玩具事故，验**遵从性**（overview §9.2）。
 *
 * 前两个 spike 验的是「能不能做到」，这个验的是「这套设计到底成不成立」：
 * overview §8.2 把「agent 填 direction 敷衍」列为头号风险，只有真跑一次才能证伪。
 *
 * 观测：
 *   1. 是否每个方向都先 open_step，且 direction 是可证伪命题（不是「我要进一步分析」）
 *   2. close_step 是否挂了证据，callRef 是否指得回真实调用
 *   3. occurredAt 填充率 —— 事故时间线的唯一来源，最容易被略过
 *   4. ask_operator 是否先写 expect；语句被人改写后是否学到真实 schema
 *   5. 结案前是否出现 impact / leftover 两个固定 step
 *   6. 收到 close_step 的 warnings 后是否会补
 *
 * 跑：npm run spike:tools
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { createInquestryMcpServer, toolName } from '../src/backend/tools/sdk-mcp-adapter.js';
import type { InvestigationStore } from '../src/backend/tools/definitions.js';
import type { AskOperatorArgs, CloseStepArgs, OpenStepArgs } from '../src/backend/tools/schemas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(path.join(HERE, '../src/backend/prompt/investigation.md'), 'utf8');
const MAX_TURNS = 40;

// ───────────────────────── 玩具事故的数据源 ─────────────────────────

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
  sentry: [
    '12:03:01.900 TimeoutError: request exceeded 2000ms at OrderClient.submit user=u1001 release=3.14.2',
  ],
};

/**
 * 人工回填的模拟。表名 orders 会「被人改成 t_order」，用来验 §5.1① 的回传是否让 agent 学到真实 schema。
 *
 * 其余语句按形状粗略应答。**不能一律回 `(0 rows)`** —— 上一轮就是这么写的，
 * agent 当场识破「0 行与已确认事实矛盾」并把整个影响面判成回填失效，
 * 说明假数据自相矛盾时它不会将就，但那一轮的影响面 step 也就废了。
 */
function operatorAnswer(a: AskOperatorArgs): { answer: string; statement: string; executedAt?: string } {
  const statement = /\border(s)?\b/i.test(a.statement) && !/t_order/i.test(a.statement)
    ? a.statement.replace(/\border(s)?\b/gi, 't_order')
    : a.statement;
  const s = statement.toLowerCase();
  const at = '2026-08-09 12:41:07 +08:00';
  const wrap = (answer: string) => ({ statement, answer, executedAt: at });

  if (/show\s+create\s+table/.test(s)) {
    return wrap(
      [
        'CREATE TABLE `t_order` (',
        '  `id` varchar(32) NOT NULL,',
        '  `user` varchar(32) NOT NULL,',
        '  `cart_key` varchar(64) NOT NULL,',
        '  `created_at` datetime(3) NOT NULL,',
        '  PRIMARY KEY (`id`),',
        '  KEY `idx_cart_key` (`cart_key`)      -- 注意：普通索引，不是 UNIQUE',
        ') ENGINE=InnoDB',
      ].join('\n'),
    );
  }
  if (/idempotency_keys/.test(s)) {
    return wrap("ERROR 1146 (42S02): Table 'shop.idempotency_keys' doesn't exist");
  }
  if (/replica_lag|seconds_behind_master/.test(s)) {
    return wrap(
      [
        'ts                      | seconds_behind_master',
        '2026-08-09 12:02:00     | 0.012',
        '2026-08-09 12:03:00     | 0.340',
        '2026-08-09 12:04:00     | 0.290',
        '(3 rows)',
      ].join('\n'),
    );
  }
  if (/count\s*\(|group\s+by/.test(s)) {
    return wrap(
      [
        'cart_key      | user  | n | first_at                | last_at',
        'u1001:cart7   | u1001 | 2 | 2026-08-09 12:03:01.480 | 2026-08-09 12:03:02.390',
        'u2043:cart2   | u2043 | 2 | 2026-08-09 12:03:11.900 | 2026-08-09 12:03:12.640',
        'u1188:cart9   | u1188 | 2 | 2026-08-09 12:07:44.120 | 2026-08-09 12:07:45.010',
        '(3 rows)',
      ].join('\n'),
    );
  }
  if (/from\s+t_order/.test(s)) {
    return wrap(
      [
        'id | user  | cart_key    | created_at',
        'X  | u1001 | u1001:cart7 | 2026-08-09 12:03:01.480',
        'Y  | u1001 | u1001:cart7 | 2026-08-09 12:03:02.390',
        '(2 rows)',
      ].join('\n'),
    );
  }
  return wrap('(操作员：这条我看不懂要查什么，请换个写法或说明目的)');
}

// ───────────────────────── 记录用的 store ─────────────────────────

type StepRec = {
  id: string;
  ordinal: number;
  kind: string;
  direction: string;
  calls: { n: number; tool: string; brief: string; empty: boolean }[];
  closed?: CloseStepArgs;
  warnings?: string[];
};

const steps: StepRec[] = [];
const asks: AskOperatorArgs[] = [];
let current: StepRec | undefined;

/** 自带时间戳、能自动抽出 occurredAt 的数据源（overview §4.3）。人工回填与 schema 查询不在其列。 */
const TIMESTAMPED_SOURCES = new Set(['query_logs']);

/** agent 会照抄工具正文里的 `[call #1]` 标记，"call #1" 与 "#1" 都得认。 */
const refNum = (ref: string) => Number(String(ref).match(/\d+/)?.[0] ?? NaN);

/** 每次工具调用在当前 step 内的编号 —— 正式实现里由 PostToolUse hook 注入，这里手工模拟。 */
function registerCall(tool: string, brief: string, empty = false): number {
  if (!current) {
    current = { id: 'st_unclassified', ordinal: 0, kind: 'unclassified', direction: '', calls: [] };
    steps.push(current);
  }
  const n = current.calls.length + 1;
  current.calls.push({ n, tool, brief, empty });
  return n;
}

const store: InvestigationStore = {
  async openStep(args: OpenStepArgs) {
    const rec: StepRec = {
      id: `st${steps.filter((s) => s.ordinal > 0).length + 1}`,
      ordinal: steps.filter((s) => s.ordinal > 0).length + 1,
      kind: args.kind ?? 'normal',
      direction: args.direction,
      calls: [],
    };
    steps.push(rec);
    current = rec;
    return { stepId: rec.id, ordinal: rec.ordinal };
  },

  async closeStep(args: CloseStepArgs) {
    const rec = steps.find((s) => s.id === args.stepId);
    const warnings: string[] = [];
    if (!rec) return { warnings: [`未知 stepId ${args.stepId}`] };

    if (args.status !== 'inconclusive' && args.evidence.length === 0) {
      warnings.push('这个结论没有任何证据，无法被复核。请补 evidence 后重新 close。');
    }
    for (const e of args.evidence) {
      const call = rec.calls.find((c) => c.n === refNum(e.callRef));
      if (!call) {
        warnings.push(`callRef ${e.callRef} 在本 step 内不存在（本步共 ${rec.calls.length} 次调用）。`);
        continue;
      }
      // 只对**自带时间戳、且本次确实有命中**的调用要求 occurredAt。
      // 一刀切会逼 agent 往 schema 事实、聚合结论、零命中这类没有事件时间的证据里
      // 塞查询执行时间——第一轮就这么污染了事故时间线。
      if (TIMESTAMPED_SOURCES.has(call.tool) && !call.empty && !e.occurredAt) {
        warnings.push(`证据「${e.claim.slice(0, 20)}…」来自 ${call.tool} 却缺 occurredAt，事故时间线会断在这里。`);
      }
    }
    rec.closed = args;
    rec.warnings = warnings;
    if (current?.id === rec.id) current = undefined;
    return { warnings };
  },

  async askOperator(args: AskOperatorArgs) {
    asks.push(args);
    registerCall('ask_operator', args.statement.slice(0, 60));
    return operatorAnswer(args);
  },
};

// ───────────────────────── 跑 ─────────────────────────

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
        const n = registerCall('query_logs', `${args.source} ${args.keyword ?? ''}`, lines.length === 0);
        const body = lines.map((l, i) => `${String(i + 1).padStart(3)} | ${l}`).join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `[call #${n}] source=${args.source} 共 ${lines.length} 行\n${body || '(无匹配)'}`,
            },
          ],
        };
      },
    ),
  ],
});

async function* prompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content:
        '线上反馈：2026-08-09 12:03 前后，用户 u1001 只提交了一次订单，系统里却出现了两条重复记录。请排查根因。\n' +
        '可用数据源：query_logs（gateway / app / sentry 三种日志）。数据库不可直连，需要查库时用 ask_operator。',
    },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}

const ALLOWED = new Set([
  toolName('open_step'),
  toolName('close_step'),
  toolName('ask_operator'),
  'mcp__datasource__query_logs',
]);

async function run() {
  const q = query({
    prompt: prompt(),
    options: {
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PROMPT },
      maxTurns: MAX_TURNS,
      permissionMode: 'default',
      mcpServers: { inquestry: createInquestryMcpServer(store), datasource: dataSource },
      canUseTool: async (name) =>
        ALLOWED.has(name)
          ? { behavior: 'allow' as const, updatedInput: undefined as never }
          : {
              behavior: 'deny' as const,
              message: `本次排查只能用 query_logs 与 open_step / close_step / ask_operator，不要用 ${name}。`,
            },
    },
  });

  let final = '';
  for await (const msg of q) {
    if (msg.type === 'result') final = 'result' in msg ? String(msg.result ?? '') : '';
  }
  return final;
}

// ───────────────────────── 评分 ─────────────────────────

/** 「无法被推翻」的空洞 direction 的典型措辞。 */
const VAGUE = /(进一步|详细|深入)?(分析|查看|检查|排查|了解|确认一下|看看)(一下)?(日志|情况|数据库|问题|接口)?$/;
const FALSIFIABLE_MARK = /(怀疑|是否|导致|因为|说明|假设|应该是|不是)/;

function report(final: string) {
  const real = steps.filter((s) => s.ordinal > 0);
  const closed = real.filter((s) => s.closed);
  const allEvidence = closed.flatMap((s) => s.closed!.evidence);
  const logEvidence = closed.flatMap((s) =>
    s.closed!.evidence.filter((e) => {
      const c = s.calls.find((x) => x.n === refNum(e.callRef));
      return c && TIMESTAMPED_SOURCES.has(c.tool) && !c.empty;
    }),
  );
  const withOccurred = logEvidence.filter((e) => e.occurredAt);
  const badRefs = closed.flatMap((s) =>
    s.closed!.evidence.filter((e) => !s.calls.some((c) => c.n === refNum(e.callRef))),
  );
  // leftover 是汇总，本就不是假设（提示词里明说了），不参与可证伪性判定
  const vague = real
    .filter((s) => s.kind !== 'leftover')
    .filter((s) => VAGUE.test(s.direction.trim()) || !FALSIFIABLE_MARK.test(s.direction));
  const needEvidence = closed.filter((s) => s.closed!.status !== 'inconclusive');
  const noEvidence = needEvidence.filter((s) => s.closed!.evidence.length === 0);
  const learnedSchema = asks.slice(1).some((a) => /t_order/i.test(a.statement));

  const checks: [string, boolean, string][] = [
    ['1. 每个方向都先 open_step，且全部 close', real.length > 0 && closed.length === real.length, `${closed.length}/${real.length} 已关闭；未归类调用 ${steps.find((s) => s.ordinal === 0)?.calls.length ?? 0} 次`],
    ['2. direction 是可证伪命题，不是空洞措辞', vague.length === 0, vague.length ? `疑似空洞 ${vague.length} 条：${vague.map((s) => `「${s.direction}」`).join('、')}` : '全部含明确假设'],
    ['3. 非 inconclusive 的结论都挂了证据', noEvidence.length === 0, `共 ${allEvidence.length} 条证据；缺证据的 step ${noEvidence.length} 个`],
    ['4. callRef 指得回真实调用', badRefs.length === 0, badRefs.length ? `无效引用 ${badRefs.length} 条：${badRefs.map((e) => e.callRef).join(',')}` : '全部有效'],
    ['5. 有命中的日志类调用，证据都填了 occurredAt', logEvidence.length > 0 && withOccurred.length === logEvidence.length, `${withOccurred.length}/${logEvidence.length}`],
    ['6. ask_operator 写了 expect，且学到了被改写的真实 schema', asks.length > 0 && asks.every((a) => a.expect?.length > 5) && (asks.length === 1 || learnedSchema), `调用 ${asks.length} 次；后续语句用 t_order：${learnedSchema}`],
    ['7. 结案前出现 impact 与 leftover 两个固定 step', real.some((s) => s.kind === 'impact') && real.some((s) => s.kind === 'leftover'), `kind 分布：${JSON.stringify(real.reduce<Record<string, number>>((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {}))}`],
  ];

  console.log('\n===== Spike Tools 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }

  console.log('\n----- agent 实际产出的 step -----');
  for (const s of real) {
    const c = s.closed;
    console.log(`  #${s.ordinal} [${s.kind}${c ? '/' + c.status : '/未关闭'}] ${s.direction}`);
    console.log(`      calls: ${s.calls.map((x) => `#${x.n} ${x.tool}(${x.brief})`).join(' | ') || '无'}`);
    if (c) {
      console.log(`      verdict: ${c.verdict}`);
      for (const e of c.evidence) {
        console.log(`      · ${e.callRef} ${e.anchor ?? '-'} @${e.occurredAt ?? '缺 occurredAt'} ${e.actor ?? ''} :: ${e.claim}`);
      }
    }
    if (s.warnings?.length) console.log(`      ⚠ harness 回给 agent 的警告: ${s.warnings.join(' / ')}`);
  }

  console.log('\n----- 事故时间线（把 agent 填的 occurredAt 排一次序）-----');
  for (const e of allEvidence.filter((x) => x.occurredAt).sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)))) {
    console.log(`  ${e.occurredAt}  ${(e.actor ?? '?').padEnd(11)} ${e.claim}`);
  }

  console.log(`\n最终回复：${final.slice(0, 300)}`);
  return checks.every(([, ok]) => ok);
}

run()
  .then((final) => process.exit(report(final) ? 0 : 1))
  .catch((err) => {
    console.error('\nSpike Tools 崩了：', err);
    report('');
    process.exit(1);
  });
