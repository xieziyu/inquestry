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
  type GateOutcome,
  type InvestigationSession,
} from '../backend/store/sqlite-store.js';
import { createInquestryMcpServer, toolName } from '../backend/tools/sdk-mcp-adapter.js';
import { createDemoDataSource, DEMO_TOOL, suggestOperatorAnswer } from '../backend/datasource/demo.js';
import {
  EMPTY_SNAPSHOT,
  type AgentChoice,
  type ChatLine,
  type GateDecision,
  type OperatorReply,
  type PendingAsk,
  type PendingGate,
  type Snapshot,
} from '../shared/ipc.js';

/** 人工回填的超时兜底（D9）。到点自动作废，节点标注为超时，agent 不会干挂。 */
const OPERATOR_TIMEOUT_MS = 15 * 60 * 1000;
/** ②档闸门的倒计时。归零按预设放行并标记"自动放行"（ui.md §4）——人不在时排查不该停。 */
const GATE_TIMEOUT_MS = 3 * 60 * 1000;

const STRUCTURAL = new Set([toolName('open_step'), toolName('close_step')]);
/** 有项目起点时给的只读三件套：读代码是排查的地基，不值得每次拦一下。 */
const READONLY_BUILTINS = ['Read', 'Grep', 'Glob'];
/** agent 自理的杂务：记事本与工具检索。它们取不到任何证据，拦下来只会把待办栏刷满。 */
const CHORES = ['TodoWrite', 'ToolSearch'];
/**
 * 写盘与跑命令一律不给，**闸门也放行不了**：要动这些东西就走 ask_operator 由人执行，
 * 这是有意的权限边界（overview §5.1）。
 *
 * 同时进 `disallowedTools`——真项目模式会加载该项目自己的 settings，
 * 里面若有 allow 规则，canUseTool 根本不会被问到，只靠这里的判断守不住。
 */
const NEVER_ALLOWED = ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

type Pending = { ask: PendingAsk; resolve: (r: OperatorReply) => void; timer: NodeJS.Timeout };
type Gate = {
  ask: PendingGate;
  /** 有人处置了：判决进账，调用按判决收尾。 */
  finish: (outcome: GateOutcome) => void;
  /** 没人处置就散了（停止 / 关案）：调用记「已放弃」，不记「被拒」。 */
  abandon: (why: string) => void;
};

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
  private gates = new Map<string, Gate>();
  /** 闸门赶在 PreToolUse 之前落定时，判决先搁这儿，等 started 事件把它带上。 */
  private preGated = new Map<string, GateOutcome>();
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
      ...CHORES,
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
          gates: [...this.gates.values()].map((g) => g.ask),
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
        //
        // ⚠️ 这不只是放开上下文：磁盘 settings 里的 `hooks` 是 shell 命令，**加载即执行**
        // （实测 SessionStart 在第一次工具调用之前就跑了），项目 `.mcp.json` 同理直接拉起进程。
        // 两者都绕过 PreToolUse / canUseTool / disallowedTools——三分法只管得住 agent
        // 自己发出的调用。真正的信任边界是「立案时选的那个目录」，等价于在那儿直接跑 claude。
        // 尚未缓解，见 ui.md §12。
        settingSources: this.demoMode ? [] : ['user', 'project', 'local'],
        // 项目起点决定 agent 继承哪套 skill / MCP，也决定会话记录落在哪（D27）
        cwd: this.intake.projectRoot ?? undefined,
        model: this.init.agent.model ?? undefined,
        effort: (this.init.agent.effort as never) ?? undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.init.promptText },
        includeHookEvents: true,
        // 硬边界不靠 canUseTool 一个人守：项目自己的 settings 里有 allow 规则时它不会被问到
        disallowedTools: NEVER_ALLOWED,
        mcpServers: {
          inquestry: createInquestryMcpServer(session.store),
          ...(this.demoMode ? { datasource: createDemoDataSource() } : {}),
        },
        canUseTool: async (name, input, opts) => {
          const verdict = this.classify(name);
          if (verdict === 'allow') return { behavior: 'allow' as const };
          if (verdict === 'deny') {
            const message = hardDenyMessage(name);
            this.applyGate(opts.toolUseID, { decision: 'deny', message });
            // deny + message 不中断 turn（D6）：agent 就地换个手段接着查
            return { behavior: 'deny' as const, message };
          }
          const outcome = await this.gate(name, input, opts);
          return outcome.decision === 'deny'
            ? { behavior: 'deny' as const, message: outcome.message! }
            : {
                behavior: 'allow' as const,
                updatedInput: outcome.input ? (JSON.parse(outcome.input) as Record<string, unknown>) : input,
              };
        },
        hooks: {
          PreToolUse: [{ hooks: [async (input, id) => this.onToolStart(input, id)] }],
          PostToolUse: [{ hooks: [async (input, id) => this.onToolEnd(input, id)] }],
          // 成功与失败是两个 hook：只接 PostToolUse 的话，报错的调用永远停在 pending
          PostToolUseFailure: [{ hooks: [async (input, id) => this.onToolFailed(input, id)] }],
          // 规则层的拒绝要抢在失败之前把调用收成 denied，否则会被记成工具故障
          PermissionDenied: [{ hooks: [async (input, id) => this.onPermissionDenied(input, id)] }],
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
    // 闸门同理：它挂着的也是一个 agent 那侧在等的 Promise
    for (const g of [...this.gates.values()]) g.abandon('案子已关闭。');
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
    // 先散闸门再中断：还卡在闸门上的调用会挡住 interrupt 想收的那一轮
    for (const g of [...this.gates.values()]) g.abandon('这一轮已被中断。');
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

  /** 待办栏上的两个控制手势最终都落到这里（ui.md §8.2）。 */
  decideGate(d: GateDecision) {
    this.gates.get(d.id)?.finish(
      d.action === 'deny'
        ? { decision: 'deny', message: d.message }
        : d.action === 'rewrite'
          ? { decision: 'rewrite', input: d.input }
          : { decision: 'allow' },
    );
  }

  /**
   * ②档闸门：把一次调用挂起，等人放行 / 改写 / 拒绝，到点按预设放行。
   *
   * 与 ①档一样只能待在 main —— renderer 关掉了，这个 Promise 也得有人负责落地。
   */
  private gate(
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; agentID?: string; signal: AbortSignal; title?: string; decisionReason?: string },
  ): Promise<GateOutcome> {
    const id = opts.toolUseID;
    const askedAt = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: GateOutcome, record: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.gates.delete(id);
        record();
        this.onChange();
        resolve(outcome);
      };
      const finish = (outcome: GateOutcome) => settle(outcome, () => this.applyGate(id, outcome));
      // agent 那侧只有 allow / deny 两种收法，所以中断也得回 deny；账上记的却不能是「被拒」
      const abandon = (why: string) =>
        settle({ decision: 'deny', message: why }, () => this.abandonCall(id, why));
      const timer = setTimeout(() => finish({ decision: 'timeout' }), GATE_TIMEOUT_MS);

      this.gates.set(id, {
        ask: {
          id,
          toolName,
          input: JSON.stringify(input ?? {}, null, 2),
          agentId: opts.agentID,
          reason: opts.title ?? opts.decisionReason,
          askedAt,
          deadline: askedAt + GATE_TIMEOUT_MS,
        },
        finish,
        abandon,
      });
      // 中断当前轮（D7）时闸门也得散：留着它 agent 那侧的 Promise 就永远悬着
      opts.signal.addEventListener('abort', () => abandon('这一轮已被中断。'), { once: true });
      this.onChange();
    });
  }

  /**
   * 把闸门判决落进那次调用。
   *
   * PreToolUse 与 canUseTool 谁先到不保证：调用行还没有就先搁着，让 started 事件带上判决；
   * 已经有了就补一条 gated。判断与写入之间不能有 await，否则两条路会挑同一个空档各写一遍。
   */
  private applyGate(callId: string, outcome: GateOutcome) {
    if (!this.session) return;
    if (!this.session.hasToolCall(callId)) {
      this.preGated.set(callId, outcome);
      return;
    }
    this.session.recordGate({ callId, gate: outcome });
    this.closeIfDenied(callId, outcome);
  }

  /**
   * 被拒的调用不会有 PostToolUse，不在这里收尾它就永远挂在 `pending` 上。
   * 留话原样落 blob —— 它就是 agent 收到的那份工具结果，节点上要看得见被拒的理由。
   */
  private closeIfDenied(callId: string, outcome: GateOutcome) {
    if (outcome.decision !== 'deny') return;
    this.session?.recordToolEnd({ callId, output: `(被拒) ${outcome.message ?? ''}`, status: 'denied' });
  }

  /**
   * 停止 / 关案时散掉的闸门。
   *
   * **不能复用被拒那条路**：`denied` 的意思是有人看过这一条并说了不行，中断没有这层判断——
   * 它连"这次调用该不该跑"都没问到。真按被拒记，轨道上会多出一条从没有人下过的判断，
   * 而 `abandoned` 正是 schema 给这种情况留的档。
   *
   * `gate_decision` 保持原样不动：闸门确实没做出判决，补一个反而是编的。
   */
  private abandonCall(callId: string, why: string) {
    // 走到闸门就说明 PreToolUse 已经记过账了；没有行可收就是真没有，不必补建
    if (!this.session?.hasToolCall(callId)) return;
    this.session.recordToolEnd({ callId, output: `(已放弃) ${why}`, status: 'abandoned' });
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

  private classify(toolName: string): 'allow' | 'deny' | 'gate' {
    if (this.allowed.has(toolName)) return 'allow';
    if (NEVER_ALLOWED.includes(toolName)) return 'deny';
    return 'gate';
  }

  /**
   * PreToolUse 既是记账口，也是**闸门真正的入口**。
   *
   * 实跑打出来的：`canUseTool` 只在 backend 自己决定要问的时候才被调用——只读工具按默认模式
   * 直接放行，白名单根本轮不到发言（第一次跑出来 Read 是 `gate_decision='auto'` 就是这么来的）。
   * 而 PreToolUse 每次调用都到，所以要拦谁得在这里说：回 `ask` 才会把它推到 `canUseTool` 上去。
   *
   * 放行一档回空而不是回 `allow`：项目自己的 settings 里若有 deny 规则（比如不许读 .env），
   * 明写 allow 会把那条规则盖掉——这里要的是别多管，不是抢权。
   */
  private onToolStart(input: unknown, toolUseID: string | undefined) {
    const i = input as { tool_name?: string; tool_input?: unknown; agent_id?: string };
    if (!i.tool_name || !toolUseID) return {};
    const verdict = this.classify(i.tool_name);
    // 结构工具就是账本本身，不给自己记一笔
    if (STRUCTURAL.has(i.tool_name)) return {};

    // hook 的 deny 会绕过 canUseTool（SDK 契约），所以硬边界的记账只能落在这一侧
    const gate: GateOutcome | undefined =
      verdict === 'deny'
        ? { decision: 'deny', message: hardDenyMessage(i.tool_name) }
        : this.preGated.get(toolUseID);
    this.preGated.delete(toolUseID);

    this.session?.recordToolStart({
      callId: toolUseID,
      toolName: i.tool_name,
      input: i.tool_input,
      agentId: i.agent_id,
      gate,
    });
    if (gate) this.closeIfDenied(toolUseID, gate);
    this.onChange();

    if (gate) return hookDecision(gate.decision === 'deny' ? 'deny' : 'allow', gate.message);
    return verdict === 'gate' ? hookDecision('ask', '这次排查里它要过一道人工闸门。') : {};
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

  /**
   * 工具**失败**走的是另一个 hook（`PostToolUseFailure`），载荷里是 `error` 不是 `tool_response`。
   *
   * 只接 PostToolUse 的话，任何报错的调用就只有 started：库里和 UI 上永远是 `pending`，
   * 错误内容也进不了 blob——而查不到东西的原因常常就写在那句报错里。
   * 闸门放开了更多外部工具之后，这条路只会更常走到。
   */
  private onToolFailed(input: unknown, toolUseID: string | undefined) {
    const i = input as { tool_name?: string; error?: string; is_interrupt?: boolean };
    if (!i.tool_name || STRUCTURAL.has(i.tool_name) || !toolUseID) return {};
    // 被拒的调用在拒绝那一刻就收过尾了。backend 照样会把它当成一次失败发过来，
    // 再收一次就会把 `denied` 覆盖成 `failed`，被拦下的和工具自己坏掉的就此混为一谈
    if (this.statusOf(toolUseID) !== 'pending') return {};
    this.session?.recordToolEnd({
      callId: toolUseID,
      output: i.error ?? '(工具失败，未给出错误信息)',
      // 人按了停止不是工具坏了，报告里这两件事不能混
      status: i.is_interrupt ? 'abandoned' : 'failed',
    });
    this.onChange();
    return {};
  }

  /**
   * 规则层的拒绝：项目自己的 settings 里 deny 掉的（比如不许读 `.env`）走这个 hook。
   *
   * 它不经过本地闸门，所以调用还挂在 `pending` 上，随后那条失败会把它记成 `failed` ——
   * 报告里「这里有一道权限边界，绕过去」和「这个工具坏了」是完全不同的两句话。
   *
   * 我们自己在 PreToolUse 里硬拒的不会到这儿（SDK 契约），那些在 `onToolStart` 就收完了。
   */
  private onPermissionDenied(input: unknown, toolUseID: string | undefined) {
    const i = input as { tool_name?: string; tool_input?: unknown; reason?: string };
    if (!i.tool_name || STRUCTURAL.has(i.tool_name) || !toolUseID) return {};
    const status = this.statusOf(toolUseID);
    // 只纠正这两种：还没收尾的（`pending`，也含"规则抢在记账之前"的没有行），
    // 和被后到的失败记成故障的（`failed`）。其余一律不动——
    // `denied` 的留话不能被规则理由顶掉；`abandoned` 更不是一次权限判断，
    // 而中断散闸门时**照样会回一个 deny**，所以这条 hook 一定会追着 abandoned 来一趟
    if (status && status !== 'pending' && status !== 'failed') return {};
    const gate: GateOutcome = { decision: 'deny', message: i.reason ?? '(权限规则拒绝，未给出原因)' };

    // 规则若抢在 PreToolUse 之前短路，调用行还不存在，UPDATE 会静默命中 0 行
    if (!this.session?.hasToolCall(toolUseID)) {
      this.session?.recordToolStart({
        callId: toolUseID,
        toolName: i.tool_name,
        input: i.tool_input,
        gate,
      });
    } else {
      this.session.recordGate({ callId: toolUseID, gate });
    }
    this.closeIfDenied(toolUseID, gate);
    this.onChange();
    return {};
  }

  private statusOf(callId: string) {
    return (
      this.db.prepare(`SELECT status FROM tool_calls WHERE id=?`).get(callId) as
        | { status: string }
        | undefined
    )?.status;
  }

  private pushChat(role: ChatLine['role'], text: string) {
    this.chat.push({ role, text, at: Date.now() });
    this.onChange();
  }
}

function hookDecision(permissionDecision: 'allow' | 'deny' | 'ask', permissionDecisionReason?: string) {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
  } as never;
}

function hardDenyMessage(name: string) {
  return `本次排查不给 ${name}。跑命令、写盘、动生产数据一律用 ask_operator 交给人执行——把要跑的语句、为什么跑、预期看到什么写进去。`;
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
