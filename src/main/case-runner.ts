/**
 * 一个 case 的运行时：持有 SDK 会话句柄、DB、以及**挂起中的人工回填**。
 *
 * pending 是活着的 Promise，只能待在 main：超时兜底与 resolve 都不能交给 renderer，
 * 否则用户关个窗口 agent 就永久挂死（architecture.md）。
 */

import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import { blobDir, openDatabase, type Db } from '../backend/db/database.js';
import { locateEvidence, readBlobText } from '../backend/db/blobs.js';
import { buildSnapshot } from '../backend/db/snapshot.js';
import { createInvestigationSession, type InvestigationSession } from '../backend/store/sqlite-store.js';
import { createInquestryMcpServer, toolName } from '../backend/tools/sdk-mcp-adapter.js';
import { createDemoDataSource, DEMO_INCIDENT_DATE, DEMO_TOOL, suggestOperatorAnswer } from '../backend/datasource/demo.js';
import { EMPTY_SNAPSHOT, type ChatLine, type OperatorReply, type PendingAsk, type Snapshot } from '../shared/ipc.js';

/** 人工回填的超时兜底（D9）。到点自动作废，节点标注为超时，agent 不会干挂。 */
const OPERATOR_TIMEOUT_MS = 15 * 60 * 1000;

const STRUCTURAL = new Set([toolName('open_step'), toolName('close_step')]);
const ALLOWED = new Set([...STRUCTURAL, toolName('ask_operator'), DEMO_TOOL]);

type Pending = { ask: PendingAsk; resolve: (r: OperatorReply) => void; timer: NodeJS.Timeout };

export class CaseRunner {
  private db: Db;
  private blobs: string;
  private session: InvestigationSession;
  private caseId = 'case_demo';
  private sessionId = randomUUID();
  private chat: ChatLine[] = [];
  private pending = new Map<string, Pending>();
  private busy = false;
  private status: Snapshot['sessionStatus'] = 'idle';
  private q: Query | null = null;
  private inbox = createInbox();

  constructor(
    dbFile: string,
    /** 提示词文本由构建期内联传入 —— 打包后源码目录不存在，读文件必然失效。 */
    private promptText: string,
    private onChange: () => void,
  ) {
    this.db = openDatabase(dbFile);
    this.blobs = blobDir(dbFile);
    this.session = createInvestigationSession(
      this.db,
      {
        caseId: this.caseId,
        sessionId: this.sessionId,
        backend: 'claude',
        blobDir: this.blobs,
        incidentDate: DEMO_INCIDENT_DATE,
        tzOffset: '+08:00',
        isTimestampedSource: (name) => name.includes('query_logs'),
        now: () => Date.now(),
        newId: (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`,
        runOperator: (args) => this.askOperator(args),
      },
      { title: '提交一次却产生两条重复订单' },
    );
  }

  snapshot(): Snapshot {
    try {
      return buildSnapshot(
        this.db,
        { caseId: this.caseId, sessionId: this.sessionId, blobDir: this.blobs },
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

  async start(question: string) {
    if (this.q) return this.send(question);
    this.pushChat('user', question);
    this.busy = true;
    this.status = 'live';
    this.inbox.push(question);
    this.onChange();

    this.q = query({
      prompt: this.inbox.iterable,
      options: {
        settingSources: [],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.promptText },
        includeHookEvents: true,
        mcpServers: {
          inquestry: createInquestryMcpServer(this.session.store),
          datasource: createDemoDataSource(),
        },
        canUseTool: async (name) =>
          ALLOWED.has(name)
            ? { behavior: 'allow' as const, updatedInput: undefined as never }
            : { behavior: 'deny' as const, message: `本次排查不要用 ${name}。` },
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
      this.status = 'ended';
    } catch (err) {
      this.status = 'crashed';
      this.pushChat('system', `会话出错：${(err as Error).message}`);
    } finally {
      this.busy = false;
      this.session.endSession(this.status === 'crashed' ? 'crashed' : 'ended');
      this.onChange();
    }
  }

  async send(text: string) {
    this.pushChat('user', text);
    this.busy = true;
    this.inbox.push(text);
    this.onChange();
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
    this.session.recordToolStart({
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
    this.session.recordToolEnd({ callId: toolUseID, output: text });
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
