/**
 * Spike A —— 在裸 Node 里验 Claude backend 的**协议能力**（overview §2 / §3）。
 *
 * 只验能力，不验运行环境；Electron main 内的 PATH / 打包 / 签名是 Spike B。
 *
 * 验五条，任何一条不成立整套设计要改形：
 *   1. 不带 ANTHROPIC_API_KEY 也能跑通 —— 走订阅（D3）
 *   2. canUseTool 的 `allow + updatedInput` 真能改写参数（tool handler 收到的是改后的值）
 *   3. canUseTool 的 `deny + message` **不中断 turn**，agent 就地换方向重调（D6，全设计最贵的一条）
 *   4. createSdkMcpServer 的进程内工具能被调到（ask_operator 的载体，§5）
 *   5. hook 事件能拿到 PreToolUse 及其 agent_id（tool call 自动归属 step 的兜底，§4.4）
 *   6. 起标题那一趟（`case-namer`）手上一个工具都没有、不进扩展思考，且只有一个链接的描述也答得上来
 *
 * 跑：npm run spike:claude
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ## 速查：这套设计用到的 CLI flag 与 SDK API
 *
 * 放在这儿而不是设计文档里，是因为它们随 SDK 走不随设计走——要核对就跑一次这个 spike，
 * 或直接翻 `@anthropic-ai/claude-agent-sdk` 的类型定义，别信一份手抄的表。
 *
 * CLI（长驻双向流那套，overview §2）：
 *   --input-format stream-json    实时流式输入（需配 -p）
 *   --output-format stream-json   实时流式输出
 *   --include-partial-messages    增量 chunk，打字机效果（**不落库**，只走 IPC）
 *   --forward-subagent-text       转发子 agent 正文，带 parent_tool_use_id
 *   --include-hook-events         hook 生命周期事件进流（自动归属的地基）
 *   --replay-user-messages        回显 stdin 的 user message 用于 ack
 *   --session-id / --resume / --fork-session
 *   --permission-mode             acceptEdits | auto | bypassPermissions | manual | dontAsk | plan
 *   --bare                        ⛔ 强制 API key，**禁用**（D4：它会绕开订阅凭据）
 *
 * SDK：
 *   canUseTool                    单次调用闸门：allow / allow+updatedInput / deny+message
 *   interrupt()                   turn 级中断，返回 receipt，支持 cancel_queued（D7）
 *   setPermissionMode(mode)       运行时切档
 *   createSdkMcpServer()          进程内 MCP server（ask_operator 的载体，D14）
 *   backgroundTasks(toolUseId)    把一条前台支线转后台（认 tool_use_id）
 *   stopTask(taskId)              停掉一条支线（认 task_id，而它就是 agent_id）
 *   forkSession()                 从某点分叉
 *   getSubagentMessages() / listSubagents()
 *   supportedModels()             每个模型真实的 supportsEffort 与 effort 档位
 *
 * **能力探测要 feature-detect，不要版本嗅探**：`system/init` 的 `capabilities` 是开放集合
 * （观测到 interrupt_receipt_v1 / interrupt_cancel_queued_v1 / msg_lifecycle_v1）。
 *
 * ## 两条顺带打出来的环境观测
 *
 * - **`settingSources: []` 不隔离用户环境**：用户的 slash command 与全部 MCP 照样加载。
 *   overview §2「白送用户已有的 skill 和 MCP」因此成立，但反面是调查无关的工具会一起进来，
 *   而工具集一大模型会先走一跳 ToolSearch
 * - **主线调用的 hook input 里没有 `agent_id`**（与 §4.4 一致：它只在子 agent 内出现）。
 *   子 agent 那一侧由 `spike:lane` 补齐
 * ──────────────────────────────────────────────────────────────────────────
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { namerOptions, proposeCaseFacts } from '../src/main/case-namer.js';
import type { CaseFacts } from '../src/main/case-namer.js';
import { todayLocal } from '../src/shared/time.js';

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
  namerFacts: null as CaseFacts | null,
  namerTools: null as string[] | null,
  namerThinking: 0,
};

/**
 * 检查 6 的输入：**描述里除了一个链接什么都没有**。这是最容易把起标题那一趟带沟里的一种，
 * 而它恰恰常见（从 Sentry / 监控页复制一条就来建单）。
 *
 * 这条检查有来历：`case_1baca6bb` 的标题一直停在建单兜底那句半截原文。当时那趟 spawn 用
 * `disallowedTools` 黑名单挡工具，漏了 `ToolSearch`——模型看见链接就用它去找抓取工具，
 * 一跳用光 `maxTurns: 1`，整趟被收成"问不出来"，界面上什么都没说。
 *
 * **所以 6a 断言的是「一个工具都没有」而不是「它这次没去调工具」**：调不调是模型的心情，
 * 拿它当网的话，提示词换一句话就能让一份漏工具的选项照样 PASS（这条检查第一版就是这么假过的）。
 * 6b 那条端到端的只补一件 6a 管不着的事：够不着链接时，标题里得留下那个认得出的编号。
 * **它是条概率网**：退回旧提示词跑，有时回 `title: null`（`case_1baca6bb` 就是这么空着的），
 * 有时又蒙对——所以它只断言编号在不在，不断言措辞，也别把它当成唯一的那道网。
 */
const NAMER_LINK_ONLY = '请分析下 Sentry 报的 issue: https://sentry.example.com/organizations/sentry/issues/1679';

/**
 * 检查 6c 的输入：**一段真的现象描述**，多行、带日志片段与 traceId。
 *
 * 这条检查也有来历：默认的 adaptive 思考开着时，模型会为这一句标题想上三四十秒，
 * 一趟实测 41s，越过 `case-namer` 的 `TIMEOUT_MS` 被收成"问不出来"——标题于是静默停在
 * 建单兜底那句，**失败形状与漏关 ToolSearch 那次一模一样**。关掉之后同一段 4.8s。
 *
 * 数的是 `system/thinking_tokens` 的条数而不是耗时：耗时随网络与排队浮动，
 * 拿它当阈值的话，网快的那天一趟开着思考的 spawn 照样能 PASS。
 */
const NAMER_THINK_BAIT =
  '今天是 2026-08-25。读下面这段排查请求：\n\n' +
  '今天下午 3 点左右，用户反馈说播客详情页打不开，一直转圈。我看了下网关日志，有大量 504。\n' +
  'traceId: 7f3a9c1b2e4d5f6a\n麻烦帮我看看是哪个下游服务挂了。';

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

  // 与上面那一趟无关，另起两次 spawn（起标题本来就是独立的一跳）。
  // 这一趟同样要有超时与必定收尾：卡住的话 6a/6b/6c 连 FAIL 都报不出来，只剩一个不吭声的进程。
  //
  // **喂的是一段真的现象描述，不是「回复 OK」**：6c 数的是这趟进没进扩展思考，
  // 而一句无可想的指令谁都不会想——夹具没有能触发那件事的输入时，检查是空的。
  const namer = query({ prompt: NAMER_THINK_BAIT, options: namerOptions('haiku') });
  const namerTimer = setTimeout(() => void namer.interrupt?.(), TIMEOUT_MS);
  try {
    for await (const msg of namer) {
      if (msg.type === 'system' && msg.subtype === 'init') observed.namerTools = msg.tools;
      if (msg.type === 'system' && msg.subtype === 'thinking_tokens') observed.namerThinking += 1;
    }
  } finally {
    clearTimeout(namerTimer);
    namer.close();
  }
  observed.namerFacts = await proposeCaseFacts(NAMER_LINK_ONLY, todayLocal(new Date()));

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
    [
      '6a. 起标题那一趟手上一个工具都没有',
      observed.namerTools?.length === 0,
      `system/init 报的工具: ${JSON.stringify(observed.namerTools)}`,
    ],
    [
      '6b. 只有一个链接的描述也起得出标题（含链接里的编号）',
      Boolean(observed.namerFacts?.title?.includes('1679')),
      `proposeCaseFacts 回: ${JSON.stringify(observed.namerFacts)}`,
    ],
    [
      '6c. 起标题那一趟不进扩展思考（开着必超时，而超时长得跟没起过一样）',
      observed.namerThinking === 0,
      `system/thinking_tokens 收到 ${observed.namerThinking} 条`,
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
