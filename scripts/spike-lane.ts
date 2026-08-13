/**
 * Spike A2 —— 子 agent 泳道（overview §3.4 · §4.5）。
 *
 * **这个文件就是那两块地基的实测结论**：下面每一条 check 的标题即断言，
 * 设计文档不另存一份表（存了就会实现改了而表还写着旧的）。
 *
 * 轨道那一侧早就备好了：`steps.lane` 有列、有索引、UI 有 `.lane.branch`——但没有人往里写，
 * 因为分叉的真实数据来源一直没验过。这个 spike 只回答两个问题：
 *
 *   一、**归属**：记账口（hook）给的是 `agent_id`，而 lane key 设计成起子 agent 那次调用的
 *       `tool_use_id`（§4.5）。两个键天生不同，中间有没有一座**活着的时候就能走**的桥？
 *       （事后是有的：Task 的 tool_result 里带 `agentId`——但那是支线跑完才到，
 *        实时轨道等不到那时候。）
 *   二、**处置**：§3.4 说单条支线能转后台、且**只针对那一条**。真调一次看看，
 *       顺带看被转后台的那条怎么回来（`task_notification`）。
 *
 * 每轮各起一次真会话：
 *   `lanes`      —— 并发两条支线，归属闭不闭合、串不串台（两条都钉死 run_in_background:false）
 *   `background` —— 两条前台，中途把其中一条推到后台
 *   `async`      —— 什么都不写时的默认形态（**默认就是后台**，这条是实跑打出来的）
 *   `stop`       —— 单条支线停得掉吗（§3.4 那条"不能单独 kill"从没调过，实测推翻了）
 *
 * 起真会话就要订阅凭据，所以**不进 `spike:all`**（同 `spike:tools` / `spike:wire`）。
 * 跑：npm run spike:lane           全跑
 *     npm run spike:lane -- lanes  只跑一轮（`lanes` 最快，其余几轮各有几十秒的真等待）
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const ECHO = 'mcp__inquestry__echo_probe';
const SLOW = 'mcp__inquestry__slow_probe';
/** 起子 agent 的那个工具在不同版本里叫 Task / Agent，两个都认——名字变了不该让 spike 静默变空。 */
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const RUN_TIMEOUT_MS = 300_000;
/** 转后台那轮：alpha 要足够长，长到"主线没等它"这件事无法用巧合解释。 */
const ALPHA_SLEEP_S = 45;
const BETA_SLEEP_S = 8;
const GAMMA_SLEEP_S = 15;
const DELTA_SLEEP_S = 40;
/** 停掉之后再等一会儿：不等的话"没有 SubagentStop"只是"没等到"。 */
const STOP_GRACE_MS = 4000;
/**
 * 第一轮里 alpha 那条支线先睡一会儿再打探针，**故意把两条支线的到达顺序拧过来**：
 * 主线的 Task 调用是 alpha 在前，内层探针却是 beta 先到。
 * 不拧的话，"按到达顺序配对"这种错写法算出来的答案与正解一模一样，那一轮的 PASS 就没排除掉它。
 */
const LANE_STAGGER_S = 6;

// ───────────────────────── 观测记录 ─────────────────────────

type PreCall = {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** 只有子 agent 内触发的 hook 才有（SDK 契约，Spike A 在主线侧验过没有）。 */
  agentId?: string;
  agentType?: string;
  at: number;
};

/** 带 `parent_tool_use_id` 转发回来的一条子 agent 消息。 */
type Forwarded = {
  lane: string;
  /** 这条消息里出现的 tool_use 块 id —— 内层调用与泳道之间唯一的活体桥。 */
  toolUseIds: string[];
  texts: string[];
};

type Recorder = {
  pre: PreCall[];
  forwarded: Forwarded[];
  subagentStart: { agentId: string; agentType?: string; at: number }[];
  subagentStop: {
    agentId: string;
    agentType?: string;
    transcript?: string;
    /** 支线最后说的那句话。收口那一步写的就是它（ui.md §3.2），拿不到才退回通知里的摘要。 */
    lastMessage?: string;
    at: number;
  }[];
  gate: { toolName: string; agentId?: string; toolUseId: string }[];
  /** 主线的 tool_result（`parent_tool_use_id === null`），转后台那轮靠它判"等没等"。 */
  mainResults: { toolUseId: string; text: string; structured: unknown; at: number }[];
  notifications: { taskId: string; toolUseId?: string; status?: string; summary?: string; at: number }[];
  bgLevels: { n: number; at: number }[];
  resultAt: number | null;
  isError: boolean;
  resultText: string;
};

function newRecorder(): Recorder {
  return {
    pre: [],
    forwarded: [],
    subagentStart: [],
    subagentStop: [],
    gate: [],
    mainResults: [],
    notifications: [],
    bgLevels: [],
    resultAt: null,
    isError: false,
    resultText: '',
  };
}

// ───────────────────────── 探针工具 ─────────────────────────

const echoProbe = tool(
  'echo_probe',
  'Echo back the given text. Used only by the Inquestry spike.',
  { text: z.string().describe('the exact word you were told to echo') },
  async (args) => ({ content: [{ type: 'text' as const, text: `echoed: ${args.text}` }] }),
);

/** 转后台那轮的"钉子"：让支线真的占住前台一段时间，否则没有东西可转。 */
const slowProbe = tool(
  'slow_probe',
  'Sleep for the given number of seconds, then echo the text back. Used only by the Inquestry spike.',
  {
    text: z.string().describe('the exact word you were told to echo'),
    seconds: z.number().describe('how many seconds to sleep before echoing'),
  },
  async (args) => {
    const s = Math.min(Math.max(args.seconds, 0), 90);
    await new Promise((r) => setTimeout(r, s * 1000));
    return { content: [{ type: 'text' as const, text: `slept ${s}s: ${args.text}` }] };
  },
);

// ───────────────────────── 流消息的最小形状 ─────────────────────────

type Block = { type?: string; id?: string; text?: string; tool_use_id?: string; content?: unknown };
type StreamMsg = {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: Block[] | string };
  task_id?: string;
  tool_use_id?: string;
  tool_use_result?: unknown;
  /** 支线跑完时通知自带的摘要——没有 SubagentStop 时收口写的就是它（ui.md §3.2）。 */
  summary?: string;
  status?: string;
  tasks?: unknown[];
  is_error?: boolean;
  result?: string;
};

function blocks(m: StreamMsg): Block[] {
  const c = m.message?.content;
  return Array.isArray(c) ? c : [];
}

function blockText(b: Block): string {
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) {
    return (b.content as Block[]).map((x) => (typeof x.text === 'string' ? x.text : '')).join('\n');
  }
  return '';
}

/** 把一条消息记进 recorder；转后台那轮还要靠返回值判断该不该动手。 */
function absorb(rec: Recorder, msg: unknown) {
  const m = msg as StreamMsg;
  const at = Date.now();
  if (m.type === 'assistant' && m.parent_tool_use_id) {
    rec.forwarded.push({
      lane: m.parent_tool_use_id,
      toolUseIds: blocks(m).filter((b) => b.type === 'tool_use' && b.id).map((b) => b.id!),
      texts: blocks(m).filter((b) => b.type === 'text').map((b) => b.text ?? ''),
    });
  }
  if (m.type === 'user' && !m.parent_tool_use_id) {
    for (const b of blocks(m)) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        // `tool_use_result` 是工具的完整 Output 对象，不是发给模型的那段文本；
        // Agent 工具的这一份带 `agentId`——支线**跑完之后**的另一条归属路
        rec.mainResults.push({ toolUseId: b.tool_use_id, text: blockText(b), structured: m.tool_use_result, at });
      }
    }
  }
  if (m.type === 'system' && m.subtype === 'task_notification') {
    rec.notifications.push({
      taskId: m.task_id ?? '?',
      toolUseId: m.tool_use_id,
      status: m.status,
      summary: m.summary,
      at,
    });
  }
  if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
    rec.bgLevels.push({ n: Array.isArray(m.tasks) ? m.tasks.length : 0, at });
  }
  if (m.type === 'result') {
    rec.resultAt = at;
    rec.isError = Boolean(m.is_error);
    rec.resultText = String(m.result ?? '');
  }
}

// ───────────────────────── 会话骨架 ─────────────────────────

/**
 * 一条**不结束**的输入流：turn 收尾之后消息流还开着，转后台那轮的 `task_notification`
 * 正是在 `result` 之后才回来的。用完由调用方 `close()`。
 */
function heldPrompt(text: string) {
  let release: () => void = () => {};
  const done = new Promise<void>((r) => (release = r));
  const gen = (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage;
    await done;
  })();
  return { gen, release: () => release() };
}

type RunOpts = {
  prompt: string;
  /** 子 agent 拿得到的工具；只给探针，别的都不给，跑出来的东西才是确定的。 */
  agentTools: string[];
  forwardSubagentText: boolean;
  /** 命中的工具强制走 canUseTool（回 'ask'），用来验闸门那一侧拿不拿得到归属。 */
  askOn?: string;
  /** 每条消息之后被调一次，返回 true 表示这一轮可以收了。 */
  onMessage?: (rec: Recorder, q: Query) => boolean | Promise<boolean>;
};

async function runSession(rec: Recorder, opts: RunOpts) {
  delete process.env.ANTHROPIC_API_KEY;
  const held = heldPrompt(opts.prompt);

  const q = query({
    prompt: held.gen,
    options: {
      // spike 要的是确定性：用户的 skill / MCP 会带进几十个工具，也会带进别的 agent 类型
      settingSources: [],
      model: 'sonnet',
      permissionMode: 'default',
      includeHookEvents: true,
      forwardSubagentText: opts.forwardSubagentText,
      agents: {
        lane_probe: {
          description: 'Inquestry spike 专用：按吩咐调一次探针工具就收工。',
          prompt:
            '你是一个只做一件事的探针。按用户消息里给的参数调用一次指定的探针工具，' +
            '拿到结果后只回复 DONE，不要做任何别的事，不要解释。',
          tools: opts.agentTools,
          model: 'haiku',
        },
      },
      mcpServers: {
        inquestry: createSdkMcpServer({
          name: 'inquestry',
          version: '0.0.0',
          tools: [echoProbe, slowProbe],
        }),
      },
      canUseTool: async (toolName, _input, o) => {
        rec.gate.push({ toolName, agentId: o.agentID, toolUseId: o.toolUseID });
        return { behavior: 'allow' as const };
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const i = input as {
                  tool_name?: string;
                  tool_input?: unknown;
                  tool_use_id?: string;
                  agent_id?: string;
                  agent_type?: string;
                };
                rec.pre.push({
                  toolUseId: i.tool_use_id ?? '?',
                  toolName: i.tool_name ?? '?',
                  input: (i.tool_input ?? {}) as Record<string, unknown>,
                  agentId: i.agent_id,
                  agentType: i.agent_type,
                  at: Date.now(),
                });
                if (opts.askOn && i.tool_name === opts.askOn) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      permissionDecision: 'ask' as const,
                      permissionDecisionReason: 'spike：强制推到 canUseTool，看闸门那侧有没有归属',
                    },
                  };
                }
                return {};
              },
            ],
          },
        ],
        SubagentStart: [
          {
            hooks: [
              async (input) => {
                const i = input as { agent_id?: string; agent_type?: string };
                rec.subagentStart.push({ agentId: i.agent_id ?? '?', agentType: i.agent_type, at: Date.now() });
                return {};
              },
            ],
          },
        ],
        SubagentStop: [
          {
            hooks: [
              async (input) => {
                const i = input as {
                  agent_id?: string;
                  agent_type?: string;
                  agent_transcript_path?: string;
                  last_assistant_message?: string;
                };
                rec.subagentStop.push({
                  agentId: i.agent_id ?? '?',
                  agentType: i.agent_type,
                  transcript: i.agent_transcript_path,
                  lastMessage: i.last_assistant_message,
                  at: Date.now(),
                });
                return {};
              },
            ],
          },
        ],
      },
    },
  });

  const timer = setTimeout(() => q.close(), RUN_TIMEOUT_MS);
  try {
    for await (const msg of q) {
      absorb(rec, msg);
      if (opts.onMessage && (await opts.onMessage(rec, q))) break;
      // 没有 onMessage 的那轮（并发泳道）跑到 result 就收
      if (!opts.onMessage && rec.resultAt) break;
    }
  } finally {
    clearTimeout(timer);
    held.release();
    q.close();
  }
}

// ───────────────────────── 第一轮：并发两条泳道 ─────────────────────────

/**
 * `run_in_background: false` 是这一轮的前提，不是顺手加的：**子 agent 现在默认在后台跑**
 * （AgentInput 的注释这么写，第一次实跑也这么表现——主线当场收尾，支线还在跑）。
 * 不写死这个参数，这一轮验的就不是"支线跑起来长什么样"，而是"异步启动长什么样"。
 */
const LANE_PROMPT = [
  '请在**同一条消息里同时**发起两个 Agent（Task）工具调用，两个都用 subagent_type="lane_probe"，',
  '两个都要带 run_in_background: false（我要你等它们的结果），不要一个跑完再跑另一个：',
  `  - 第一个：description 写 "alpha"，prompt 写：先调用 ${SLOW}（text 填 WAIT，seconds 填 ${LANE_STAGGER_S}），` +
    `再调用 ${ECHO}，text 参数填 ALPHA。`,
  '  - 第二个：description 写 "beta"，prompt 写：调用 ' + ECHO + '，text 参数填 BETA。',
  '两个都回来之后，只回复 DONE 两个字，不要做任何别的事。',
].join('\n');

/** 从起子 agent 那次调用的入参里认出它是哪条泳道——`description` 就是我们让它写的词。 */
function laneWord(input: Record<string, unknown>): string {
  const s = `${String(input.description ?? '')} ${String(input.prompt ?? '')}`.toLowerCase();
  if (s.includes('alpha')) return 'alpha';
  if (s.includes('beta')) return 'beta';
  return '?';
}

/**
 * 桥：内层调用 → 泳道。
 *
 * hook 只给 `agent_id`，转发回来的消息只给 `parent_tool_use_id`，**两边都有的只有内层
 * 那个 `tool_use_id`**。所以归属是靠它拼出来的，不是靠时间相邻猜的。
 */
function laneOf(rec: Recorder, innerToolUseId: string): string | undefined {
  return rec.forwarded.find((f) => f.toolUseIds.includes(innerToolUseId))?.lane;
}

async function runLanes() {
  const rec = newRecorder();
  await runSession(rec, {
    prompt: LANE_PROMPT,
    agentTools: [ECHO, SLOW],
    forwardSubagentText: true,
    askOn: ECHO,
  });

  const taskCalls = rec.pre.filter((p) => AGENT_TOOLS.has(p.toolName));
  const inner = rec.pre.filter((p) => p.toolName === ECHO);
  const laneByTaskId = new Map(taskCalls.map((t) => [t.toolUseId, laneWord(t.input)]));

  /** 每个内层调用最终落在哪条泳道 —— 检查 5 就是拿它和它自己 echo 的那个词对。 */
  const attributed = inner.map((p) => {
    const lane = laneOf(rec, p.toolUseId);
    return {
      echoed: String(p.input.text ?? '').toLowerCase(),
      agentId: p.agentId,
      lane,
      laneWord: lane ? laneByTaskId.get(lane) : undefined,
    };
  });

  const agentIds = new Set(inner.map((p) => p.agentId).filter(Boolean));
  const laneToAgents = new Map<string, Set<string>>();
  for (const a of attributed) {
    if (!a.lane || !a.agentId) continue;
    if (!laneToAgents.has(a.lane)) laneToAgents.set(a.lane, new Set());
    laneToAgents.get(a.lane)!.add(a.agentId);
  }

  // 检查 5 是这一轮唯一"算出来"的结论，所以要顺手问一句：这份数据分不分得开错写法。
  // 两种一望即知的错法都不用内层 tool_use_id：一种按到达顺序配对，一种一律算给最近那次
  // Task 调用。它们若与正解算出同一个答案，检查 5 的 PASS 就没有排除掉它们——**那一轮是空的**，
  // 所以这条自己就是一条检查（FAIL 了要重跑，不是改代码）。
  const real = attributed.map((a) => a.lane);
  const byOrder = inner.map((_, i) => taskCalls[i]?.toolUseId);
  const byLatest = inner.map(() => taskCalls[taskCalls.length - 1]?.toolUseId);
  const distinguishes = (v: (string | undefined)[]) => v.some((x, i) => x !== real[i]);

  const overlapped =
    taskCalls.length === 2 &&
    rec.subagentStart.length === 2 &&
    rec.subagentStop.length === 2 &&
    Math.max(...rec.subagentStart.map((s) => s.at)) < Math.min(...rec.subagentStop.map((s) => s.at));

  const checks: [string, boolean, string][] = [
    sessionCheck(rec),
    [
      '1. 主线起子 agent 的那次调用，hook input 里没有 agent_id',
      taskCalls.length > 0 && taskCalls.every((t) => t.agentId === undefined),
      `主线 ${taskCalls[0]?.toolName ?? '?'} 调用 ${taskCalls.length} 次，` +
        `agent_id: ${JSON.stringify(taskCalls.map((t) => t.agentId ?? null))}`,
    ],
    [
      '2. 子 agent 内的调用带 agent_id + agent_type',
      inner.length >= 2 && inner.every((p) => Boolean(p.agentId) && Boolean(p.agentType)),
      `内层 ${inner.length} 次: ${JSON.stringify(inner.map((p) => ({ agent_id: p.agentId, agent_type: p.agentType })))}`,
    ],
    [
      '3. 两条支线的 agent_id 互不相同（并发时分得开）',
      agentIds.size === 2,
      `不同的 agent_id: ${agentIds.size} 个 ${JSON.stringify([...agentIds])}`,
    ],
    [
      '4. 子 agent 的 tool_use 块被转发上来，带 parent_tool_use_id',
      rec.forwarded.some((f) => f.toolUseIds.length > 0) &&
        rec.forwarded.every((f) => laneByTaskId.has(f.lane)),
      `转发消息 ${rec.forwarded.length} 条，其中带 tool_use 块的 ${rec.forwarded.filter((f) => f.toolUseIds.length).length} 条；` +
        `parent_tool_use_id 全部落在主线的 Task 调用上: ${rec.forwarded.every((f) => laneByTaskId.has(f.lane))}`,
    ],
    [
      '5. 桥闭合且不串台：agent_id ↔ lane key 一一对上，ALPHA 归 alpha 那条',
      attributed.length >= 2 &&
        attributed.every((a) => a.lane && a.laneWord && a.echoed === a.laneWord) &&
        [...laneToAgents.values()].every((s) => s.size === 1) &&
        laneToAgents.size === agentIds.size,
      JSON.stringify(attributed),
    ],
    [
      '5b. 这一轮的数据分得开两种错写法（否则 5 的 PASS 什么都没排除）',
      distinguishes(byOrder) && distinguishes(byLatest),
      `按到达顺序配对 ${distinguishes(byOrder)} · 一律算给最近一次 Task 调用 ${distinguishes(byLatest)}；` +
        `正解 ${JSON.stringify(real)}`,
    ],
    [
      '6. forwardSubagentText 把子 agent 的文本也带上来了',
      rec.forwarded.some((f) => f.texts.some((t) => t.trim())),
      `带文本的转发消息 ${rec.forwarded.filter((f) => f.texts.some((t) => t.trim())).length} 条`,
    ],
    [
      '7. SubagentStart / SubagentStop 成对，且 agent_id 与内层调用的对得上',
      rec.subagentStart.length === 2 &&
        rec.subagentStop.length === 2 &&
        rec.subagentStart.every((s) => agentIds.has(s.agentId)) &&
        rec.subagentStop.every((s) => agentIds.has(s.agentId)),
      `start ${JSON.stringify(rec.subagentStart.map((s) => [s.agentId, s.agentType]))} / ` +
        `stop ${JSON.stringify(rec.subagentStop.map((s) => [s.agentId, s.agentType]))}`,
    ],
    [
      '8. 闸门那一侧（canUseTool）也拿得到归属：opts.agentID',
      rec.gate.filter((g) => g.toolName === ECHO).length >= 2 &&
        rec.gate.filter((g) => g.toolName === ECHO).every((g) => Boolean(g.agentId)),
      JSON.stringify(rec.gate),
    ],
  ];

  console.log('\n===== Spike A2 · 第一轮：并发两条泳道 =====');
  printChecks(checks);
  console.log(`      两条支线真的重叠在跑: ${overlapped}（false 只说明模型串行起的，归属结论不受影响）`);
  console.log(`      SubagentStop 给的 transcript: ${JSON.stringify(rec.subagentStop.map((s) => s.transcript))}`);
  console.log(`      最终回复: ${JSON.stringify(rec.resultText.slice(0, 80))}`);
  return checks.every(([, ok]) => ok);
}

// ───────────────────────── 第二轮：单条支线转后台 ─────────────────────────

const BG_PROMPT = [
  '请在**同一条消息里同时**发起两个 Agent（Task）工具调用，两个都用 subagent_type="lane_probe"，',
  '两个都要带 run_in_background: false（我要你等它们的结果），不要一个跑完再跑另一个：',
  `  - 第一个：description 写 "alpha"，prompt 写：调用 ${SLOW}，text 参数填 ALPHA，seconds 参数填 ${ALPHA_SLEEP_S}。`,
  `  - 第二个：description 写 "beta"，prompt 写：调用 ${SLOW}，text 参数填 BETA，seconds 参数填 ${BETA_SLEEP_S}。`,
  '两个都回来之后，只回复 DONE 两个字，不要做任何别的事。',
].join('\n');

async function runBackground() {
  const rec = newRecorder();
  let alphaTaskId: string | null = null;
  let betaTaskId: string | null = null;
  let bgOk: boolean | null = null;
  let bogusOk: boolean | null = null;
  let bgAt = 0;
  let fired = false;

  await runSession(rec, {
    prompt: BG_PROMPT,
    agentTools: [SLOW],
    // 故意不开：文档说不开的时候子 agent 的 tool_use / tool_result 块**照样**转发。
    // 若成立，泳道归属就不依赖这个开关，它只管渲染子 agent 的正文。
    forwardSubagentText: false,
    onMessage: async (r, q) => {
      for (const p of r.pre) {
        if (!AGENT_TOOLS.has(p.toolName)) continue;
        if (laneWord(p.input) === 'alpha') alphaTaskId = p.toolUseId;
        if (laneWord(p.input) === 'beta') betaTaskId = p.toolUseId;
      }
      // 等 alpha 的探针真的开跑了再动手：hook 只说"要调了"，前台占住是从工具正文开始的
      const alphaRunning = r.pre.some((p) => p.toolName === SLOW && String(p.input.text ?? '').toUpperCase() === 'ALPHA');
      if (!fired && alphaTaskId && alphaRunning) {
        fired = true;
        bogusOk = await q.backgroundTasks('toolu_this_id_does_not_exist');
        bgAt = Date.now();
        bgOk = await q.backgroundTasks(alphaTaskId);
      }
      // 收工条件：alpha 转后台之后跑完、并且回执到了
      return Boolean(r.resultAt) && r.notifications.some((n) => n.toolUseId === alphaTaskId);
    },
  });

  const alphaResult = rec.mainResults.find((m) => m.toolUseId === alphaTaskId);
  const betaResult = rec.mainResults.find((m) => m.toolUseId === betaTaskId);
  const alphaNote = rec.notifications.find((n) => n.toolUseId === alphaTaskId);
  const alphaProbe = rec.pre.find((p) => p.toolName === SLOW && String(p.input.text ?? '').toUpperCase() === 'ALPHA');
  const alphaAgentId = alphaProbe?.agentId;
  /** alpha 的探针睡醒的时刻——"卡没卡住"要拿它当界，不能拿转后台那一刻。 */
  const alphaWakesAt = (alphaProbe?.at ?? bgAt) + ALPHA_SLEEP_S * 1000;
  const secs = (a: number, b: number) => `${((a - b) / 1000).toFixed(1)}s`;

  const checks: [string, boolean, string][] = [
    sessionCheck(rec),
    [
      '9. backgroundTasks(toolUseId) 对在跑的那一条返回 true',
      bgOk === true,
      `alpha 的 tool_use_id=${alphaTaskId} → ${bgOk}`,
    ],
    [
      '10. 传一个不存在的 tool_use_id 返回 false（"只针对那一个"的反面）',
      bogusOk === false,
      `bogus → ${bogusOk}`,
    ],
    [
      '11. 被转后台的那条立刻回 tool_result，主线不等它',
      Boolean(alphaResult) &&
        alphaResult!.at - bgAt < 10_000 &&
        alphaResult!.at - bgAt < ALPHA_SLEEP_S * 1000,
      alphaResult
        ? `转后台后 ${secs(alphaResult.at, bgAt)} 就回了（探针要睡 ${ALPHA_SLEEP_S}s）：${JSON.stringify(alphaResult.text.slice(0, 120))}`
        : '没看到 alpha 的 tool_result',
    ],
    [
      '12. 另一条没被碰过，照旧阻塞到自己跑完',
      Boolean(betaResult) && betaResult!.at - bgAt > (BETA_SLEEP_S - 4) * 1000,
      betaResult
        ? `beta 在转后台后 ${secs(betaResult.at, bgAt)} 才回（它自己要睡 ${BETA_SLEEP_S}s）`
        : '没看到 beta 的 tool_result',
    ],
    [
      // 别写成"turn 在 alpha 睡醒之前收尾"——那验的是模型的选择不是机制：
      // 实测它被 prompt 要求"两个都回来再说"，于是自己去 TaskOutput 等了 alpha 一场。
      // 机制这一侧要问的只有一句：主线有没有被那条支线**卡住**。
      '13. 主线没被 alpha 卡住：探针还在睡的时候主线已经又动了（或已收尾）',
      Boolean(alphaResult) &&
        (rec.pre.some((p) => !p.agentId && p.at > alphaResult!.at && p.at < alphaWakesAt) ||
          Boolean(rec.resultAt && rec.resultAt < alphaWakesAt)),
      `alpha 睡醒是在转后台后 ${secs(alphaWakesAt, bgAt)}；期间主线又发了 ` +
        `${rec.pre.filter((p) => !p.agentId && p.at > (alphaResult?.at ?? 0) && p.at < alphaWakesAt).map((p) => p.toolName).join(', ') || '（无）'}；` +
        `result 在转后台后 ${rec.resultAt ? secs(rec.resultAt, bgAt) : '?'} 到`,
    ],
    [
      // 回执的 `task_id` 就是那条支线的 `agent_id`（第三轮同样如此）——第三座桥，
      // 也是 §3.4 里 `stopTask(taskId)` 那一档控制真正认的键。
      '14. 支线跑完发 task_notification：tool_use_id 对回泳道，task_id 就是 agent_id',
      Boolean(alphaNote) && alphaNote!.status === 'completed' && alphaNote!.taskId === alphaAgentId,
      alphaNote
        ? `status=${alphaNote.status} task_id=${alphaNote.taskId}，alpha 的 agent_id=${alphaAgentId}`
        : `没等到 alpha 的 task_notification；收到的是 ${JSON.stringify(rec.notifications)}`,
    ],
    [
      // 文档把"观测到 1 → 0"写成了已验证结论，那它就得有人兜着：SDK 不再发这条消息、
      // 载荷形状变了、或者只见 1 不见 0，都会让"这条支线还在后台"的指示卡在亮着
      '14b. background_tasks_changed 给出电平：先非零，跑完回零',
      rec.bgLevels.some((b) => b.n > 0) &&
        rec.bgLevels.some((b, i) => b.n === 0 && rec.bgLevels.slice(0, i).some((x) => x.n > 0)),
      `电平序列 ${JSON.stringify(rec.bgLevels.map((b) => b.n))}`,
    ],
    [
      '15. 不开 forwardSubagentText，子 agent 的 tool_use 块照样转发（泳道不依赖这个开关）',
      rec.forwarded.some((f) => f.toolUseIds.length > 0) &&
        !rec.forwarded.some((f) => f.texts.some((t) => t.trim())),
      `带 tool_use 块的转发 ${rec.forwarded.filter((f) => f.toolUseIds.length).length} 条，` +
        `带文本的 ${rec.forwarded.filter((f) => f.texts.some((t) => t.trim())).length} 条（应为 0）`,
    ],
  ];

  console.log('\n===== Spike A2 · 第二轮：单条支线转后台 =====');
  printChecks(checks);
  console.log(`      background_tasks_changed 的电平序列: ${JSON.stringify(rec.bgLevels.map((b) => b.n))}`);
  console.log(`      主线 tool_result: ${JSON.stringify(rec.mainResults.map((m) => [m.toolUseId, m.text.slice(0, 60)]))}`);
  return checks.every(([, ok]) => ok);
}

// ───────────────────────── 第三轮：默认的异步支线 ─────────────────────────

/**
 * 前两轮都把 `run_in_background` 钉死成 false，因为泳道要看的是"支线在跑"。
 * 但**默认值是后台**——不写这个参数时，主线当场收尾、支线自己跑完再回来。
 * 排查会话里 agent 是不会替我们写这个参数的，所以默认那条路才是常态路径，得单独验。
 */
const ASYNC_PROMPT = [
  '请发起一个 Agent（Task）工具调用，subagent_type="lane_probe"，description 写 "gamma"，',
  `prompt 写：调用 ${SLOW}，text 参数填 GAMMA，seconds 参数填 ${GAMMA_SLEEP_S}。`,
  'run_in_background 这个参数不要写，用它的默认值。',
  '发起之后立刻回复 SENT 一个词，不要等它，不要做任何别的事。',
].join('\n');

async function runAsync() {
  const rec = newRecorder();
  let gammaTaskId: string | null = null;

  await runSession(rec, {
    prompt: ASYNC_PROMPT,
    agentTools: [SLOW],
    forwardSubagentText: false,
    onMessage: async (r) => {
      const call = r.pre.find((p) => AGENT_TOOLS.has(p.toolName));
      if (call) gammaTaskId = call.toolUseId;
      return Boolean(r.resultAt) && r.notifications.some((n) => n.toolUseId === gammaTaskId);
    },
  });

  const call = rec.pre.find((p) => AGENT_TOOLS.has(p.toolName));
  const result = rec.mainResults.find((m) => m.toolUseId === gammaTaskId);
  const payload = (result?.structured ?? {}) as { status?: string; agentId?: string };
  const note = rec.notifications.find((n) => n.toolUseId === gammaTaskId);
  const inner = rec.pre.filter((p) => p.toolName === SLOW);
  const secs = (a: number, b: number) => `${((a - b) / 1000).toFixed(1)}s`;

  const checks: [string, boolean, string][] = [
    sessionCheck(rec),
    [
      '16. 不写 run_in_background 时，子 agent 默认转后台：主线不等它',
      Boolean(call && result) && result!.at - call!.at < GAMMA_SLEEP_S * 1000,
      call && result
        ? `Agent 调用后 ${secs(result.at, call.at)} 就回了 tool_result（支线里的探针要睡 ${GAMMA_SLEEP_S}s）`
        : '没看到 Agent 调用或它的 tool_result',
    ],
    [
      '17. 这次 tool_result 是 async_launched，结构化载荷里的 agentId 与 hook 侧对得上',
      payload.status === 'async_launched' &&
        Boolean(payload.agentId) &&
        inner.some((p) => p.agentId === payload.agentId),
      `status=${payload.status} agentId=${payload.agentId}；hook 侧 ${JSON.stringify(inner.map((p) => p.agentId))}`,
    ],
    [
      '18. 支线跑完发 task_notification：tool_use_id 对回泳道，task_id 就是 agent_id',
      Boolean(note) &&
        note!.status === 'completed' &&
        note!.at > (rec.resultAt ?? 0) &&
        note!.taskId === payload.agentId,
      note
        ? `status=${note.status} task_id=${note.taskId}（agentId=${payload.agentId}），` +
          `在 result 之后 ${secs(note.at, rec.resultAt ?? note.at)} 到`
        : `没等到 gamma 的 task_notification；收到的是 ${JSON.stringify(rec.notifications)}`,
    ],
    [
      '19. 异步支线的归属照旧：内层带 agent_id，tool_use 块带 parent_tool_use_id',
      inner.length > 0 &&
        inner.every((p) => Boolean(p.agentId)) &&
        inner.every((p) => laneOf(rec, p.toolUseId) === gammaTaskId),
      `内层 ${inner.length} 次，泳道 ${JSON.stringify(inner.map((p) => laneOf(rec, p.toolUseId)))}，` +
        `Agent 调用的 tool_use_id=${gammaTaskId}`,
    ],
    [
      // 收口那一步写的就是这两样（ui.md §3.2）。**没有它们，收口只能由 harness 编一句判定**——
      // 而报告里会因此多出一条没有人下过的结论。两样都要，因为被人停掉的那条不发 SubagentStop
      '20. 收口拿得到支线自己的话：SubagentStop 的最后一句 + 通知自带的摘要',
      Boolean(rec.subagentStop.find((s) => s.agentId === payload.agentId)?.lastMessage?.trim()) &&
        Boolean(note?.summary?.trim()),
      `last_assistant_message=${JSON.stringify(
        rec.subagentStop.find((s) => s.agentId === payload.agentId)?.lastMessage?.slice(0, 60),
      )} / notification.summary=${JSON.stringify(note?.summary?.slice(0, 60))}`,
    ],
  ];

  console.log('\n===== Spike A2 · 第三轮：默认的异步支线 =====');
  printChecks(checks);
  console.log(`      SubagentStart/Stop: ${rec.subagentStart.length}/${rec.subagentStop.length}`);
  console.log(`      最终回复: ${JSON.stringify(rec.resultText.slice(0, 80))}`);
  return checks.every(([, ok]) => ok);
}

// ───────────────────────── 第四轮：单条支线能不能停 ─────────────────────────

/**
 * §3.4 原本写着"**不能**单独 kill 一条泳道"，而 SDK 上摆着 `stopTask(taskId)`
 * （注释说"停掉一个在跑的 task，会发一条 status='stopped' 的回执"）。
 * 一句断言和一个接口互相打脸时，别去改措辞——**调一次看它到底停不停**。
 */
const STOP_PROMPT = [
  '请发起一个 Agent（Task）工具调用，subagent_type="lane_probe"，description 写 "delta"，',
  `prompt 写：调用 ${SLOW}，text 参数填 DELTA，seconds 参数填 ${DELTA_SLEEP_S}。`,
  'run_in_background 这个参数不要写，用它的默认值。',
  '发起之后立刻回复 SENT 一个词，不要等它，不要做任何别的事。',
].join('\n');

async function runStop() {
  const rec = newRecorder();
  let taskId: string | null = null;
  let stopAt = 0;
  let stopThrew: string | null = null;
  let fired = false;
  let noteAt = 0;
  let graceTimer: NodeJS.Timeout | null = null;

  await runSession(rec, {
    prompt: STOP_PROMPT,
    agentTools: [SLOW],
    forwardSubagentText: false,
    onMessage: async (r, q) => {
      // 停的时候认的是 task_id，而它就是 agent_id——支线里第一次工具调用的 hook 就带着它，
      // 也就是说不必等回执、活着的时候就能停
      const agentId = r.pre.find((p) => p.toolName === SLOW)?.agentId;
      if (!fired && agentId) {
        fired = true;
        taskId = agentId;
        stopAt = Date.now();
        try {
          await q.stopTask(agentId);
        } catch (err) {
          stopThrew = String(err);
        }
      }
      const stopped = r.notifications.find((n) => n.taskId === taskId);
      if (!stopped || !r.resultAt) return false;
      // 收到回执就收工的话，"被停掉的支线不发 SubagentStop"只是**没等到**，不是没有。
      // 宽限一会儿再看——这样得到的是一句有界的话："回执之后 N 秒内没有"。
      //
      // ⚠️ 宽限期**不能靠 onMessage 自己推进**：它只在流里再来一条消息时才被调一次，
      // 而支线停了、turn 也收了之后往往没有下一条了——那样这一轮会一直挂到 RUN_TIMEOUT_MS
      // 才被兜底关掉，"等了 4 秒"既不是 4 秒、还把整套 spike 拖慢五分钟（评审打出来的）。
      // 改成挂一个定时器去 close：期间循环照常消费，到点自然收尾。
      graceTimer ??= setTimeout(() => q.close(), Math.max(0, STOP_GRACE_MS - (Date.now() - stopped.at)));
      noteAt = stopped.at;
      return false;
    },
  });
  if (graceTimer) clearTimeout(graceTimer);

  const endedAt = Date.now();
  const note = rec.notifications.find((n) => n.taskId === taskId);
  const secs = (a: number, b: number) => `${((a - b) / 1000).toFixed(1)}s`;

  const checks: [string, boolean, string][] = [
    sessionCheck(rec),
    [
      '20. stopTask(taskId) 不报错（taskId 取的是支线的 agent_id）',
      fired && stopThrew === null,
      fired ? `taskId=${taskId}；抛错 ${stopThrew ?? '无'}` : '压根没轮到调用它',
    ],
    [
      '21. 支线被停掉：回执是 stopped，而且没等到它自己睡醒',
      Boolean(note) && note!.status === 'stopped' && note!.at - stopAt < DELTA_SLEEP_S * 1000,
      note
        ? `status=${note.status}，停之后 ${secs(note.at, stopAt)} 回来（它本来要睡 ${DELTA_SLEEP_S}s）`
        : `没等到回执；收到的是 ${JSON.stringify(rec.notifications)}`,
    ],
    [
      `22. 被停掉的支线不发 SubagentStop（回执之后确实又等满了 ${STOP_GRACE_MS / 1000}s）`,
      rec.subagentStart.length > 0 &&
        rec.subagentStop.length === 0 &&
        noteAt > 0 &&
        endedAt - noteAt >= STOP_GRACE_MS,
      `SubagentStart ${rec.subagentStart.length} 次 / SubagentStop ${rec.subagentStop.length} 次，` +
        `回执之后实等 ${noteAt ? secs(endedAt, noteAt) : '?'}` +
        `（靠 SubagentStop 给泳道收尾的写法会在这里把那条挂死）`,
    ],
  ];

  console.log('\n===== Spike A2 · 第四轮：单条支线能不能停 =====');
  printChecks(checks);
  console.log(`      收到的回执: ${JSON.stringify(rec.notifications.map((n) => [n.taskId, n.status]))}`);
  return checks.every(([, ok]) => ok);
}

// ───────────────────────── 收尾 ─────────────────────────

/**
 * 每一轮都要先过的一条：**这一次会话本身正常收尾了吗**。
 *
 * 机制那些检查只看事件到没到齐，而事件齐了、`result` 却是 `is_error`（凭据过期、模型报错、
 * 会话级失败）照样可能发生——那样一轮全 PASS 说的是"没验到失败"，不是"验过了"。
 */
function sessionCheck(rec: Recorder): [string, boolean, string] {
  return [
    '0. 这一轮的会话正常收尾（收到 result 且不是 is_error）',
    Boolean(rec.resultAt) && !rec.isError,
    rec.resultAt ? `is_error=${rec.isError}；${JSON.stringify(rec.resultText.slice(0, 120))}` : '没等到 result',
  ];
}

function printChecks(checks: [string, boolean, string][]) {
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }
}

const only = process.argv[2];
const runs: [string, () => Promise<boolean>][] = [
  ['lanes', runLanes],
  ['background', runBackground],
  ['async', runAsync],
  ['stop', runStop],
];

(async () => {
  // 拼错轮次名（`lane` 之于 `lanes`）不能变成"一轮都没跑、退出码 0"——那是一次
  // 什么都没验的全绿，比 FAIL 更难发现
  if (only && !runs.some(([name]) => name === only)) {
    console.error(`未知的轮次 ${JSON.stringify(only)}；可选：${runs.map(([n]) => n).join(' / ')}（不传则全跑）`);
    process.exit(2);
  }
  let allOk = true;
  for (const [name, fn] of runs) {
    if (only && only !== name) continue;
    allOk = (await fn()) && allOk;
  }
  process.exit(allOk ? 0 : 1);
})().catch((err) => {
  console.error('\nSpike A2 崩了：', err);
  process.exit(1);
});
