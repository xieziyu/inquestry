/**
 * Spike A —— 在裸 Node 里验 Claude backend 的**协议能力**（overview §9.0）。
 *
 * 只验能力，不验运行环境；Electron main 内的 PATH / 打包 / 签名是 Spike B。
 *
 * 验五条，任何一条不成立整套设计要改形：
 *   1. 不带 ANTHROPIC_API_KEY 也能跑通 —— 走订阅（D3）
 *   2. canUseTool 的 `allow + updatedInput` 真能改写参数（tool handler 收到的是改后的值）
 *   3. canUseTool 的 `deny + message` **不中断 turn**，agent 就地换方向重调（D6，全设计最贵的一条）
 *   4. createSdkMcpServer 的进程内工具能被调到（ask_operator 的载体，§5）
 *   5. hook 事件能拿到 PreToolUse 及其 agent_id（tool call 自动归属 step 的兜底，§4.4）
 *
 * 跑：npm run spike:claude
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const PROBE_TOOL = 'mcp__inquestry__echo_probe';
const TIMEOUT_MS = 180_000;

/** 三个断言的观测点，由 tool handler / canUseTool / hook 各自写入。 */
const observed = {
  probeReceived: [] as string[],
  gateCalls: [] as { tool: string; text: unknown; decision: string }[],
  hookPreToolUse: [] as { tool: string; agentId: string | undefined }[],
  denyAndRetrySameTurn: false,
  initPayload: null as Record<string, unknown> | null,
  resultText: '',
  isError: false,
};

const probe = tool(
  'echo_probe',
  'Echo back the given text. Used only by the Inquestry spike.',
  { text: z.string().describe('any short text') },
  async (args) => {
    observed.probeReceived.push(args.text);
    return { content: [{ type: 'text' as const, text: `echoed: ${args.text}` }] };
  },
);

/**
 * 闸门脚本：第 1 次 deny + message（不带 interrupt），第 2 次 allow 并把参数改写成 CCC。
 * agent 若在同一 turn 里重调，说明 D6 成立。
 */
function makeGate() {
  let n = 0;
  return async (toolName: string, input: Record<string, unknown>) => {
    if (toolName !== PROBE_TOOL) {
      observed.gateCalls.push({ tool: toolName, text: undefined, decision: 'deny(other-tool)' });
      return { behavior: 'deny' as const, message: `本次 spike 只允许调用 ${PROBE_TOOL}。` };
    }
    n += 1;
    if (n === 1) {
      observed.gateCalls.push({ tool: toolName, text: input.text, decision: 'deny+message' });
      return {
        behavior: 'deny' as const,
        message: '参数不对：text 必须是 BBB。请立刻用 text="BBB" 重新调用一次这个工具。',
      };
    }
    observed.gateCalls.push({ tool: toolName, text: input.text, decision: 'allow+updatedInput' });
    if (n === 2) observed.denyAndRetrySameTurn = true;
    return { behavior: 'allow' as const, updatedInput: { text: 'CCC' } };
  };
}

async function* singleTurn(prompt: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}

async function run() {
  const hadApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  delete process.env.ANTHROPIC_API_KEY;

  const q = query({
    prompt: singleTurn(
      `调用 ${PROBE_TOOL} 工具，text 参数填 "AAA"。` +
        '如果工具调用被拒绝并给出了修正要求，就按要求在本轮内立刻重新调用一次。' +
        '成功后只回复 DONE 两个字，不要做任何别的事。',
    ),
    options: {
      // 未设时用 SDK 自带的那份二进制（node_modules 里 257MB 的 optionalDependency）；
      // 设为本机 ~/.local/bin/claude 可对比「自带 vs 用户已装」两条路径。
      ...(process.env.INQUESTRY_CLAUDE_BIN
        ? { pathToClaudeCodeExecutable: process.env.INQUESTRY_CLAUDE_BIN }
        : {}),
      // 隔离用户的 settings：spike 要的是确定性，用户的 MCP / skill 会带进几十个工具
      settingSources: [],
      permissionMode: 'default',
      canUseTool: makeGate(),
      includeHookEvents: true,
      mcpServers: {
        inquestry: createSdkMcpServer({ name: 'inquestry', version: '0.0.0', tools: [probe] }),
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const i = input as { tool_name?: string; agent_id?: string };
                observed.hookPreToolUse.push({ tool: i.tool_name ?? '?', agentId: i.agent_id });
                return {};
              },
            ],
          },
        ],
      },
    },
  });

  const timer = setTimeout(() => void q.interrupt?.(), TIMEOUT_MS);
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        observed.initPayload = msg as unknown as Record<string, unknown>;
      }
      if (msg.type === 'result') {
        observed.isError = msg.is_error;
        observed.resultText = 'result' in msg ? String(msg.result ?? '') : '';
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return { hadApiKey };
}

function report(hadApiKey: boolean) {
  const init = observed.initPayload ?? {};
  const checks: [string, boolean, string][] = [
    [
      '1. 无 ANTHROPIC_API_KEY 跑通（走订阅）',
      !observed.isError && observed.resultText.length > 0,
      hadApiKey ? '注意：环境里原本有 API key，已在进程内删掉' : '环境本就无 API key',
    ],
    [
      '2. allow + updatedInput 真的改写了参数',
      observed.probeReceived.includes('CCC'),
      `handler 实收: ${JSON.stringify(observed.probeReceived)}`,
    ],
    [
      '3. deny + message 不中断 turn，agent 就地重调（D6）',
      observed.denyAndRetrySameTurn && !observed.isError,
      `闸门决策序列: ${observed.gateCalls.map((g) => `${g.decision}(text=${JSON.stringify(g.text)})`).join(' → ')}`,
    ],
    [
      '4. 进程内 SDK MCP 工具被调到',
      observed.probeReceived.length > 0,
      `被调 ${observed.probeReceived.length} 次`,
    ],
    [
      '5. PreToolUse hook 可观测（带 agent_id 字段）',
      observed.hookPreToolUse.length > 0,
      `${observed.hookPreToolUse.length} 次: ${JSON.stringify(observed.hookPreToolUse)}`,
    ],
  ];

  console.log('\n===== Spike A 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }

  console.log('\n----- system/init 关键字段 -----');
  for (const k of ['capabilities', 'permissionMode', 'model', 'tools', 'mcp_servers', 'slash_commands']) {
    const v = (init as Record<string, unknown>)[k];
    if (v === undefined) continue;
    const s = JSON.stringify(v);
    console.log(`  ${k}: ${Array.isArray(v) ? `[${v.length}] ` : ''}${s.length > 400 ? s.slice(0, 400) + '…' : s}`);
  }
  console.log(`\n  最终回复: ${JSON.stringify(observed.resultText.slice(0, 120))}`);
  console.log(`  SDK 自带二进制: ${path.join('node_modules/@anthropic-ai', `claude-agent-sdk-${process.platform}-${os.arch()}`)}`);

  return checks.every(([, ok]) => ok);
}

run()
  .then(({ hadApiKey }) => {
    process.exit(report(hadApiKey) ? 0 : 1);
  })
  .catch((err) => {
    console.error('\nSpike A 崩了：', err);
    report(Boolean(process.env.ANTHROPIC_API_KEY));
    process.exit(1);
  });
