/**
 * 一个 case 的运行时：持有 SDK 会话句柄、DB、以及**挂起中的人工回填**。
 *
 * pending 是活着的 Promise，只能待在 main：超时兜底与 resolve 都不能交给 renderer，
 * 否则用户关个窗口 agent 就永久挂死（architecture.md）。
 */

import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import type { Db } from '../backend/db/database.js';
import { locateEvidence, readBlobText } from '../backend/db/blobs.js';
import { buildSnapshot } from '../backend/db/snapshot.js';
import {
  createInvestigationSession,
  openCase,
  type CaseIntake,
  type InvestigationSession,
} from '../backend/store/sqlite-store.js';
import { createInquestryMcpServer, toolName } from '../backend/tools/sdk-mcp-adapter.js';
import { createDemoDataSource, DEMO_TOOL, suggestOperatorAnswer } from '../backend/datasource/demo.js';
import {
  EMPTY_SNAPSHOT,
  type AgentChoice,
  type ChatLine,
  type OperatorReply,
  type PendingAsk,
  type Snapshot,
} from '../shared/ipc.js';

/** 人工回填的超时兜底（D9）。到点自动作废，节点标注为超时，agent 不会干挂。 */
const OPERATOR_TIMEOUT_MS = 15 * 60 * 1000;

const STRUCTURAL = new Set([toolName('open_step'), toolName('close_step')]);
/** 有项目起点时给的只读三件套。写操作与查库一律走 ask_operator —— 这是有意的权限边界。 */
const READONLY_BUILTINS = ['Read', 'Grep', 'Glob'];

type Pending = { ask: PendingAsk; resolve: (r: OperatorReply) => void; timer: NodeJS.Timeout };

export type CaseRunnerInit = {
  db: Db;
  blobDir: string;
  /** 提示词文本由构建期内联传入 —— 打包后源码目录不存在，读文件必然失效。 */
  promptText: string;
  caseId: string;
  intake: CaseIntake;
  agent: AgentChoice;
  onChange: () => void;
};

export class CaseRunner {
  private db: Db;
  private blobs: string;
  private intake: CaseIntake;
  /** 到真的要跑第一轮时才开：立完案先放着不看，不该在库里留一个空会话。 */
  private session: InvestigationSession | null = null;
  private caseId: string;
  private sessionId = randomUUID();
  private chat: ChatLine[] = [];
  private pending = new Map<string, Pending>();
  private busy = false;
  private ended = false;
  private status: Snapshot['sessionStatus'] = 'idle';
  private q: Query | null = null;
  private inbox = createInbox();
  private allowed: Set<string>;
  private onChange: () => void;

  constructor(private init: CaseRunnerInit) {
    this.onChange = init.onChange;
    this.db = init.db;
    this.blobs = init.blobDir;
    this.caseId = init.caseId;
    this.intake = openCase(
      this.db,
      { caseId: this.caseId, blobDir: this.blobs, now: () => Date.now() },
      init.intake,
    );
    this.allowed = new Set([
      ...STRUCTURAL,
      toolName('ask_operator'),
      ...(this.demoMode ? [DEMO_TOOL] : READONLY_BUILTINS),
    ]);
  }

  /** 没有项目起点 = 演示事故：只有这种情况才把玩具数据源塞进去。 */
  private get demoMode() {
    return !this.intake.projectRoot;
  }

  get meta() {
    return { caseId: this.caseId, intake: this.intake, agent: this.init.agent };
  }

  private openSession(): InvestigationSession {
    return (this.session ??= createInvestigationSession(
      this.db,
      {
        caseId: this.caseId,
        sessionId: this.sessionId,
        backend: this.init.agent.backend,
        model: this.init.agent.model,
        effort: this.init.agent.effort,
        blobDir: this.blobs,
        isTimestampedSource: (name) => name.includes('query_logs'),
        now: () => Date.now(),
        newId: (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`,
        runOperator: (args) => this.askOperator(args),
      },
      this.intake,
    ));
  }

  snapshot(): Snapshot {
    try {
      return buildSnapshot(
        this.db,
        { caseId: this.caseId, sessionId: this.sessionId, blobDir: this.blobs, agent: this.init.agent },
        {
          busy: this.busy,
          chat: this.chat,
          pending: [...this.pending.values()].map((p) => p.ask),
          sessionStatus: this.status,
        },
      );
    } catch {
      return EMPTY_SNAPSHOT;
    }
  }

  /** UI 上点结论高亮原文：按**校正后**的锚点取片段（data-model.md §2）。 */
  excerpt(callId: string, anchor: string | null): string {
    const row = this.db.prepare(`SELECT output_sha256 FROM tool_calls WHERE id=?`).get(callId) as
      | { output_sha256: string | null }
      | undefined;
    const text = row?.output_sha256 ? readBlobText(this.blobs, row.output_sha256) : null;
    if (text === null) return '(原始输出已不可用)';
    if (!anchor) return text.slice(0, 4000);
    return locateEvidence(text, anchor, undefined)?.excerpt ?? text.slice(0, 4000);
  }

  async start(question?: string) {
    const opening = question?.trim() || openingMessage(this.intake);
    if (this.q) return this.send(opening);
    const session = this.openSession();
    this.pushChat('user', opening);
    this.busy = true;
    this.status = 'live';
    this.inbox.push(opening);
    this.onChange();

    this.q = query({
      prompt: this.inbox.iterable,
      options: {
        // 真项目要加载磁盘上的 settings，否则「继承该项目的 skill 与 MCP」只是句话：
        // **必须含 `project` 才会读该项目的 CLAUDE.md**（SDK 契约），
        // 而项目约束正是排查时最不该缺的上下文。演示模式反过来要可复现，用隔离模式。
        // 放开的是**上下文**不是权限——每次调用照样过 canUseTool 的白名单。
        settingSources: this.demoMode ? [] : ['user', 'project', 'local'],
        // 项目起点决定 agent 继承哪套 skill / MCP，也决定会话记录落在哪（D27）
        cwd: this.intake.projectRoot ?? undefined,
        model: this.init.agent.model ?? undefined,
        effort: (this.init.agent.effort as never) ?? undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.init.promptText },
        includeHookEvents: true,
        mcpServers: {
          inquestry: createInquestryMcpServer(session.store),
          ...(this.demoMode ? { datasource: createDemoDataSource() } : {}),
        },
        canUseTool: async (name) =>
          this.allowed.has(name)
            ? { behavior: 'allow' as const, updatedInput: undefined as never }
            : {
                behavior: 'deny' as const,
                // deny + message 不中断 turn（D6）：agent 就地换个手段接着查
                message: `本次排查不要用 ${name}。查库、写操作、敏感数据一律用 ask_operator 交给人执行。`,
              },
        hooks: {
          PreToolUse: [{ hooks: [async (input, id) => this.onToolStart(input, id)] }],
          PostToolUse: [{ hooks: [async (input, id) => this.onToolEnd(input, id)] }],
        },
      },
    });

    void this.consume();
  }

  private async consume() {
    try {
      for await (const msg of this.q!) {
        if (msg.type === 'assistant') {
          const text = extractText((msg as { message?: { content?: unknown } }).message?.content);
          if (text.trim()) this.pushChat('assistant', text);
        }
        if (msg.type === 'result') {
          this.busy = false;
          this.onChange();
        }
      }
      this.endOnce('ended');
    } catch (err) {
      this.endOnce('crashed');
      this.pushChat('system', `会话出错：${(err as Error).message}`);
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  async send(text: string) {
    this.pushChat('user', text);
    this.busy = true;
    this.inbox.push(text);
    this.onChange();
  }

  /** 关窗 / 换案子时收尾：不收的话库里会留一排永远 `live` 的僵尸 session。 */
  close() {
    // 挂起的回填必须**逐条 resolve 掉**：只清定时器和 Map 的话，工具那侧的 Promise
    // 既没了超时兜底也永远不会落地，连同它的闭包一直挂在进程里
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ id: p.ask.id, statement: p.ask.statement, answer: '(案子已关闭，这条回填作废)' });
    }
    this.pending.clear();
    this.endOnce('ended');
    this.q?.close();
    this.q = null;
  }

  private endOnce(status: 'ended' | 'crashed') {
    // 会话没开过就没什么可收的：立完案没点「开始排查」就关窗是常态
    if (this.ended || !this.session) return;
    this.ended = true;
    this.status = status;
    this.session.endSession(status);
  }

  async interrupt() {
    // Stop 传 cancel_queued（D7）；SDK 若不支持这个签名就退回无参 interrupt
    const q = this.q as unknown as { interrupt?: (o?: unknown) => Promise<unknown> } | null;
    await q?.interrupt?.({ cancel_queued: true }).catch(() => undefined);
    this.busy = false;
    this.pushChat('system', '已中断当前轮。');
    this.onChange();
  }

  answerOperator(reply: OperatorReply) {
    const p = this.pending.get(reply.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(reply.id);
    p.resolve(reply);
    this.onChange();
  }

  private askOperator(args: {
    engine: string;
    statement: string;
    why: string;
    expect: string;
    env?: string;
  }): Promise<{ answer: string; statement: string; executedAt?: string }> {
    const id = `ask_${randomUUID().slice(0, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.onChange();
        resolve({ answer: '(超时未回填，请换个方向或稍后再问)', statement: args.statement });
      }, OPERATOR_TIMEOUT_MS);

      this.pending.set(id, {
        ask: { id, askedAt: Date.now(), ...args, suggestedAnswer: suggestOperatorAnswer(args.statement) },
        resolve: (r) => resolve({ answer: r.answer, statement: r.statement, executedAt: r.executedAt }),
        timer,
      });
      this.onChange();
    });
  }

  private onToolStart(input: unknown, toolUseID: string | undefined) {
    const i = input as { tool_name?: string; tool_input?: unknown; agent_id?: string };
    if (!i.tool_name || STRUCTURAL.has(i.tool_name) || !toolUseID) return {};
    this.session?.recordToolStart({
      callId: toolUseID,
      toolName: i.tool_name,
      input: i.tool_input,
      agentId: i.agent_id,
    });
    this.onChange();
    return {};
  }

  private onToolEnd(input: unknown, toolUseID: string | undefined) {
    const i = input as { tool_name?: string; tool_response?: unknown };
    if (!i.tool_name || STRUCTURAL.has(i.tool_name) || !toolUseID) return {};
    const text = outputText(i.tool_response);
    this.session?.recordToolEnd({ callId: toolUseID, output: text });
    const n = (
      this.db
        .prepare(
          `SELECT COUNT(*) c FROM tool_calls
           WHERE step_id=(SELECT step_id FROM tool_calls WHERE id=?)
             AND started_at <= (SELECT started_at FROM tool_calls WHERE id=?)`,
        )
        .get(toolUseID, toolUseID) as { c: number }
    ).c;
    this.onChange();
    // 行内前缀，不能换行：换行会让模型看到的行号与 blob 物理行号整体错位（tools.md §2）
    return {
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: `[call #${n}] ${text}` },
    } as never;
  }

  private pushChat(role: ChatLine['role'], text: string) {
    this.chat.push({ role, text, at: Date.now() });
    this.onChange();
  }
}

/**
 * 首轮提问由立案单拼成。
 *
 * 基准日与时区必须进正文：agent 在 `close_step` 里填的 `occurredAt` 常常只有时分秒，
 * 它得知道这些时间串属于哪一天（harness 侧也照这个基准补齐，两边要一致）。
 */
function openingMessage(intake: CaseIntake): string {
  const lines = [intake.question.trim()];
  lines.push(`事故基准日：${intake.incidentDate}（时区 ${intake.tzOffset}）。日志里只有时分秒的时间串按这一天理解。`);
  if (intake.clues?.trim()) lines.push(`已知线索：${intake.clues.trim()}`);
  lines.push(
    intake.projectRoot
      ? `项目起点：${intake.projectRoot}。可以读这个仓库的代码与配置；查库、跑命令、动生产数据一律用 ask_operator 交给人执行。`
      : '没有项目起点：只能用已接入的数据源工具，其余一律用 ask_operator 交给人执行。',
  );
  return lines.join('\n');
}

/** 长驻会话的输入端：turn 之间保持打开，随时可以再塞消息进去。 */
function createInbox() {
  const items: string[] = [];
  let notify: (() => void) | null = null;
  const iterable = (async function* (): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      if (!items.length) await new Promise<void>((r) => (notify = r));
      const text = items.shift()!;
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
      } as SDKUserMessage;
    }
  })();
  return {
    iterable,
    push(text: string) {
      items.push(text);
      notify?.();
      notify = null;
    },
  };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: { type?: string }) => b?.type === 'text')
    .map((b: { text?: string }) => b.text ?? '')
    .join('\n');
}

/** `tool_response` 对 MCP 工具直接就是 content 数组本身，不是 `{content:[…]}`（tools.md §2）。 */
function outputText(res: unknown): string {
  if (typeof res === 'string') return res;
  const blocks = Array.isArray(res) ? res : (res as { content?: unknown })?.content;
  if (Array.isArray(blocks)) {
    return blocks
      .map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : `[${c?.type ?? 'unknown'}]`))
      .join('\n');
  }
  return JSON.stringify(res ?? null);
}
