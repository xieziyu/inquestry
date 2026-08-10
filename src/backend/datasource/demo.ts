/**
 * 演示数据源。
 *
 * 真实用法是继承用户已有的 skill / MCP（overview §2 的「白送能力」），
 * 但那要求装机环境齐备；这个玩具事故让 app 装上就能跑通一整条链路。
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const DEMO_INCIDENT_DATE = '2026-08-09';

export const DEMO_QUESTION =
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

export const DEMO_TOOL = 'mcp__datasource__query_logs';

export function createDemoDataSource() {
  return createSdkMcpServer({
    name: 'datasource',
    version: '0.1.0',
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
          return {
            content: [
              { type: 'text' as const, text: `source=${args.source} 共 ${lines.length} 行\n${body || '(无匹配)'}` },
            ],
          };
        },
      ),
    ],
  });
}

/** 给操作员的建议答案 —— UI 上预填，人可以改，模拟真实回填。 */
export function suggestOperatorAnswer(statement: string): string {
  const s = statement.toLowerCase();
  if (/show\s+create\s+table/.test(s)) {
    return 'CREATE TABLE `t_order` (\n  `cart_key` varchar(64) NOT NULL,\n  KEY `idx_cart_key` (`cart_key`)  -- 普通索引，非 UNIQUE\n)';
  }
  if (/count\s*\(|group\s+by/.test(s)) {
    return [
      'cart_key    | user  | n | first_at                | last_at',
      'u1001:cart7 | u1001 | 2 | 2026-08-09 12:03:01.480 | 2026-08-09 12:03:02.390',
      'u2043:cart2 | u2043 | 2 | 2026-08-09 12:03:11.900 | 2026-08-09 12:03:12.640',
      '(2 rows)',
    ].join('\n');
  }
  if (/from\s+t_order|from\s+order/.test(s)) {
    return [
      'id | user  | cart_key    | created_at',
      'X  | u1001 | u1001:cart7 | 2026-08-09 12:03:01.480',
      'Y  | u1001 | u1001:cart7 | 2026-08-09 12:03:02.390',
      '(2 rows)',
    ].join('\n');
  }
  return '';
}
