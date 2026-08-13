/**
 * 一个 case 的运行时：持有 SDK 会话句柄、DB、以及**挂起中的人工回填**。
 *
 * pending 是活着的 Promise，只能待在 main：超时兜底与 resolve 都不能交给 renderer，
 * 否则用户关个窗口 agent 就永久挂死（architecture.md）。
 */

import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import type { Db } from '../backend/db/database.js';
import { LaneBridge } from './lane-bridge.js';
import { locateEvidence, readBlobText } from '../backend/db/blobs.js';
import { buildSnapshot } from '../backend/db/snapshot.js';
import {
  createInvestigationSession,
  isVerdictShape,
  missingClosingSteps,
  openCase,
  readCaseStatus,
  setCaseStatus,
  setVerdictShape,
  suggestVerdictShape,
  type CaseIntake,
  type CaseStatus,
  type GateOutcome,
  type InvestigationSession,
} from '../backend/store/sqlite-store.js';
import { createInquestryMcpServer, toolName } from '../backend/tools/sdk-mcp-adapter.js';
import { createDemoDataSource, DEMO_TOOL, suggestOperatorAnswer } from '../backend/datasource/demo.js';
import {
  EMPTY_SNAPSHOT,
  type AgentChoice,
  type CaseBrief,
  type ChatLine,
  type ClosingOutcome,
  type ClosingRequest,
  type ClosingStepKind,
  type GateDecision,
  type OperatorReply,
  type PendingAsk,
  type PendingGate,
  type Snapshot,
  type VerdictShape,
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
/** 支线想自己开步/收步时回的话。得说清替代做法，否则它只会换个姿势再试一次。 */
const LANE_STRUCTURAL_DENY =
  '支线不记账：open_step / close_step 只有主线用得了。把你查到的东西和结论写进给主线的回复里，' +
  '由主线来开步收步——你这条支线的每次工具调用都已经自动记在它自己的节点上了。';

type Pending = {
  ask: PendingAsk;
  /**
   * 这条回填对应的 tool call。散场时要把它记成 `abandoned`，没有这个键就只能让它
   * 永远挂在 `pending` 上——库里于是攒下一批"发起了但永远不会有结果"的调用。
   */
  callId?: string;
  resolve: (r: OperatorReply) => void;
  timer: NodeJS.Timeout;
};
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
  /**
   * PreToolUse 记下的 ask_operator 调用，等工具正文跑起来时认领。
   *
   * 两侧的键天生不同：账上的是 backend 的 `toolUseID`，回填卡上的是自己发的 `ask_*`。
   * hook 一定先于工具正文，所以这里排的就是"已记账、还没开始等人"的那些。
   */
  private askCalls: { callId: string; statement: string }[] = [];
  private gates = new Map<string, Gate>();
  /** 闸门赶在 PreToolUse 之前落定时，判决先搁这儿，等 started 事件把它带上。 */
  private preGated = new Map<string, GateOutcome>();
  private busy = false;
  /** 子 agent 泳道的归属桥与后台电平（§3.4 / §4.5）。 */
  private lanes = new LaneBridge();
  private ended = false;
  /** 最近一轮的失败原因。会话可能还「活着」但已经跑不动了，这是 UI 唯一的线索。 */
  private lastError: string | null = null;
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

  /**
   * 下面三个是给案件切换栏用的**便宜**读数（D28）：全局汇总每次快照都要把所有案子算一遍，
   * 走 buildSnapshot 的话每 60ms 就是一轮全库查询。
   */
  get todoCount() {
    return this.pending.size + this.gates.size;
  }

  /**
   * 「这个案子还在跑吗」。**支线也算**：`result` 一到主线就不忙了，而那一刻后台可能
   * 还有几条支线在查。只看主线的话，`trimIdle()` 会把一个正有支线在跑的运行时卸掉，
   * 案件切换栏也会把它显示成空闲。界面上要分得出是哪一种，看 `backgroundLanes`。
   */
  get isBusy() {
    return this.busy || this.lanes.backgroundLanes > 0;
  }

  get sessionStatus() {
    return this.status;
  }

  /**
   * 开跑前的会话准备。上一轮已经收过尾（跑完 / 崩了 / 被限流降级过）就**换一个新的 session**：
   * 不换的话新步骤会落进库里那个已标 ended 的会话，读起来是「会话结束之后还在查」，
   * 排查时间线上的会话断点也就对不上了。
   */
  private beginSession(): InvestigationSession {
    if (this.ended) {
      this.ended = false;
      this.session = null;
      this.sessionId = randomUUID();
      // lane key 是上一次会话的 `tool_use_id`，留着只会把新会话的调用配到旧泳道上
      this.lanes.reset();
    }
    return this.openSession();
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

  /** `cases` 由注册处给：一个 runner 只认得自己那个案子。 */
  snapshot(cases: CaseBrief[] = []): Snapshot {
    try {
      return buildSnapshot(
        this.db,
        { caseId: this.caseId, blobDir: this.blobs, agent: this.init.agent },
        {
          busy: this.busy,
          backgroundLanes: this.lanes.backgroundLanes,
          chat: this.chat,
          pending: [...this.pending.values()].map((p) => p.ask),
          gates: [...this.gates.values()].map((g) => g.ask),
          sessionStatus: this.status,
          lastError: this.lastError,
          cases,
        },
      );
    } catch {
      return { ...EMPTY_SNAPSHOT, cases };
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

  /** 案子的状态以库为准，不在内存里另存一份——收尾之后重建运行时也得照样是冻的。 */
  get caseStatus(): CaseStatus {
    return readCaseStatus(this.db, this.caseId) ?? 'open';
  }

  /** 还差哪几步才能结案（§6.2）。空数组 = 现在就能结。 */
  get closingGaps(): ClosingStepKind[] {
    return missingClosingSteps(this.db, this.caseId);
  }

  async start(question?: string) {
    // 结案与归档都是冻结：再开一轮会往一个已下结论的案子里追加步骤，
    // 报告与它记录的过程就此对不上。要接着查就另立案件
    if (this.caseStatus !== 'open') return;
    const opening = question?.trim() || openingMessage(this.intake);
    if (this.q) return this.send(opening);
    const session = this.beginSession();
    this.lastError = null;
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

    void this.consume(this.q);
  }

  /**
   * 消费某一次查询的消息流。
   *
   * **必须认准自己那一次查询。** `restart()` 会在旧的还没停稳时就把新的建起来，
   * 而旧 consume 要晚一拍才醒——不认的话它会拿新 session 去 `endOnce`（刚开的会话
   * 当场标成结束，后续步骤还继续往里写）、把新 `q` 置空、再换掉新查询正在消费的
   * `inbox`。重开于是原地作废，且没有任何报错。
   */
  private async consume(q: Query) {
    const mine = () => this.q === q;
    try {
      for await (const msg of q) {
        if (!mine()) return;
        // 泳道归属只在活着的时候拼得出来（§4.5）：转发上来的子 agent 消息是桥的左半边，
        // 而 hook 那侧的调用随时可能到——先吸收再往下走
        const finished = this.lanes.absorb(msg as never);
        // 一条后台支线跑完不说一声，就是"悄悄地查完悄悄地回来"（§3.4）。
        // 认 `task_notification` 而不是 `SubagentStop`：被人停掉的那条不发后者
        if (finished) this.pushChat('system', `支线 ${finished.lane.slice(-6)} 已${laneEndLabel(finished.status)}。`);
        if (msg.type === 'assistant') {
          const text = extractText((msg as { message?: { content?: unknown } }).message?.content);
          if (text.trim()) this.pushChat('assistant', text);
        }
        if (msg.type === 'result') {
          this.busy = false;
          // 一轮失败了不等于会话结束：凭据过期时消息流一直开着，`consume` 永远不返回，
          // 状态就卡在 `live`——界面显示「会话中」，主区空的，还没有任何重开的入口。
          // ⚠️ 只能信 `is_error`：实测这条消息的 `subtype` 仍是 "success"（ui.md §10）。
          // 成功那轮要把它清回 null：失败一轮之后再发一条并成功了，横幅还挂着
          // 「上一轮没跑起来」会把人诱去重开一个其实已经恢复的会话
          const r = msg as { is_error?: boolean; result?: string };
          this.lastError = r.is_error
            ? r.result?.trim() || '这一轮失败了，但 backend 没有给出原因。'
            : null;
          this.onChange();
        }
      }
      if (mine()) this.endOnce('ended');
    } catch (err) {
      if (mine()) {
        this.endOnce('crashed');
        this.pushChat('system', `会话出错：${(err as Error).message}`);
      }
    } finally {
      // 会话到此为止，**查询和输入流都不能再用了**。留着 `q` 的话下一次 start()
      // 会因为它还在而退化成 send()，消息塞进一个已经没人消费的 inbox：
      // 界面永久停在「进行中」，agent 那侧什么都没收到。inbox 也要换新的——
      // 旧那个的生成器已经随查询一起结束了
      if (mine()) {
        this.q = null;
        this.inbox = createInbox();
        this.busy = false;
        // 电平得跟着查询一起归零：消息流没了就再也不会有 `background_tasks_changed`
        // 把它推回 0，留着的话这个运行时永远"忙着"——界面停在进行中，`trimIdle()` 也永久跳过它
        this.lanes.reset();
        this.onChange();
      }
    }
  }

  /** 返回是否真的送进去了：冻结的案子没有会话接得住，送了只会静静排在一个没人消费的队列里。 */
  async send(text: string): Promise<boolean> {
    if (this.caseStatus !== 'open') return false;
    this.pushChat('user', text);
    this.busy = true;
    this.inbox.push(text);
    this.onChange();
    return true;
  }

  /**
   * 显式重开一轮。
   *
   * 会话还「活着」但已经跑不动了（凭据过期是实测到的那种）时，这是唯一的出路：
   * 消息流不会自己结束，所以 `start()` 只会看见 `q` 还在而退化成 `send()`，
   * 往一个每轮都会失败的会话里继续发。先收干净再起新的。
   */
  async restart() {
    this.close();
    await this.start();
  }

  /** 关窗 / 换案子时收尾：不收的话库里会留一排永远 `live` 的僵尸 session。 */
  close(why = '案子已关闭。') {
    this.discardPending(why);
    // 闸门同理：它挂着的也是一个 agent 那侧在等的 Promise
    for (const g of [...this.gates.values()]) g.abandon(why);
    // 上面两轮只收「卡在人这儿」的那些。**正跑着的普通调用同样收不了尾**：
    // 一次已经自动放行、还在跑的 Read / 日志查询，库里只有 started，
    // 而 `close()` 之后 SDK 保证不再有任何消息（sdk.d.ts: "After calling close(),
    // no further messages will be received."），PostToolUse 永远不会来。
    // 忙着的时候归档是允许的动作，不收的话冻结后的报告里那条会永远显示「进行中」，
    // 一直挂到下次启动清扫——而那时案子早就冻上、甚至已经导出了。
    // 中断走的是另一条路：它不关查询，在跑的调用会由 PostToolUseFailure 带 is_interrupt 收尾
    this.abandonInFlight(why);
    this.endOnce('ended');
    this.q?.close();
    this.q = null;
    // **收尾这条路上没有别人会清它**：`consume()` 的 finally 认的是 `this.q === q`，
    // 而上一行刚把 q 置空，那一轮醒来时已经不是"自己那次查询"了，直接 return。
    // 留着 busy=true 的后果不只是界面一直显示「进行中」——`trimIdle()` 跳过忙着的运行时，
    // 于是每收尾一个就永久占住一格，载入上限形同虚设
    this.busy = false;
    this.lanes.reset();
    // 输入流是**跟着查询走的**：`createInbox` 是一个 async generator，只能有一个消费者。
    // 不在这儿换掉的话，`restart()` 随后 push 进去的开场白会被正在收尾的旧查询取走，
    // 或者旧迭代器一关、新查询上来直接看到 done——库里已经有了新 session、界面显示
    // 进行中，agent 那侧却什么都没收到，而且不报任何错
    this.inbox = createInbox();
  }

  /**
   * 散掉挂起中的人工回填（D29 的"终止只做两件事"之一）。
   *
   * 两件事缺一不可：
   *
   * 1. **逐条 resolve**——只清定时器和 Map 的话，工具那侧的 Promise 既没了超时兜底
   *    也永远不会落地，连同它的闭包一直挂在进程里
   * 2. **把账也收掉**——那次 `ask_operator` 调用还记在 `pending` 上。不收的话
   *    库里会攒下一批永远等不到结果的调用（闸门那侧一直是这么做的，回填这侧原先漏了）
   *
   * 记 `abandoned` 不记 `failed`：人按了停止不是工具坏了；也不记 `denied`——
   * 没有任何人看过这一条并说不行（tools.md §2 那张表）。
   */
  private discardPending(why: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      if (p.callId) this.abandonCall(p.callId, why);
      p.resolve({ id: p.ask.id, statement: p.ask.statement, answer: `(${why}这条回填作废)` });
    }
    this.pending.clear();
    // 还没认领的也要收：PreToolUse 记完账、工具正文还没跑到 askOperator 的那一小段里
    // 撞上停止，这条调用两头不靠——不在 `pending` 里所以上面那轮扫不到，
    // 而它的行确实已经在库里挂着 `pending` 了，只能等下次启动清扫才纠正得回来
    for (const c of this.askCalls) this.abandonCall(c.callId, why);
    this.askCalls = [];
  }

  /**
   * 收掉这个会话里所有还没着落的调用。
   *
   * 与前两轮不同，这里不认识它们是什么——按库里的 `pending` 扫，因为**能挂住的不止那两种**。
   * `abandonCall()` 自己会跳过已经有结论的，所以扫过去不会把 `failed` / `denied` 改写掉。
   * 只扫当前会话：别的会话留下的是上一次运行的事，归启动清扫管。
   */
  private abandonInFlight(why: string) {
    if (!this.session) return;
    const rows = this.db
      .prepare(`SELECT id FROM tool_calls WHERE session_id=? AND status='pending'`)
      .all(this.sessionId) as { id: string }[];
    for (const r of rows) this.abandonCall(r.id, why);
  }

  private endOnce(status: 'ended' | 'crashed') {
    // 会话没开过就没什么可收的：立完案没点「开始排查」就关窗是常态
    if (this.ended || !this.session) return;
    this.ended = true;
    this.status = status;
    this.session.endSession(status);
  }

  /**
   * 收尾第一档：**停止**（D29）。中断当前轮，案子仍是 `open`，随时能接着查。
   *
   * 挂起的两种待办都得散：这一轮已经没了，人再回答也回给不到任何人——
   * 而那条 `ask_operator` 调用会一直挂在 `pending` 上（回填这侧原先漏了这一下）。
   */
  async interrupt() {
    // 先散闸门再中断：还卡在闸门上的调用会挡住 interrupt 想收的那一轮
    for (const g of [...this.gates.values()]) g.abandon('这一轮已被中断。');
    this.discardPending('这一轮已被中断，');
    // 排队里还没送出去的一起清（D7）：留着它们下一轮一开就会被翻出来接着跑，
    // 而人按停止多半正是因为方向错了
    const dropped = this.inbox.clear();
    // Stop 传 cancel_queued（D7）；SDK 若不支持这个签名就退回无参 interrupt
    const q = this.q as unknown as { interrupt?: (o?: unknown) => Promise<unknown> } | null;
    await q?.interrupt?.({ cancel_queued: true }).catch(() => undefined);
    this.busy = false;
    // 清掉的那几条人是发过的，聊天带上还留着——不说一声就成了"发出去石沉大海"
    this.pushChat('system', dropped ? `已中断当前轮，${dropped} 条还没送出的消息一并清掉。` : '已中断当前轮。');
    this.onChange();
  }

  /**
   * 结案前的问询。**这条路不改任何状态**，缺了就把那两步派给 agent。
   *
   * 与 `closeCase()` 分开是这一带最要紧的一条边界：界面拿的是 60ms 合流推来的快照，
   * 隔着这一拍，一次本以为"去补两步"的点击会落进执行路径，把案子直接冻上且没经过确认。
   * 分开之后，执行入口只有确认按钮够得到。
   */
  requestClosing(): ClosingRequest {
    // 形态与缺口出自同一次库状态：确认条冻的是这一份，而不是界面自己那份快照上的。
    // 差着一拍的话，main 按最新状态放行了弹窗，界面却冻了点击那一帧的推断值
    const suggestion = suggestVerdictShape(this.db, this.caseId);
    if (this.caseStatus !== 'open') return { missing: [], asked: false, suggestion };
    const missing = this.closingGaps;
    if (!missing.length) return { missing, asked: false, suggestion };
    // 会话还活着就直接派给 agent：这两步的内容只有查过的人给得出来
    const asked = !!this.q;
    if (asked) void this.send(closingMessage(missing));
    return { missing, asked, suggestion };
  }

  /**
   * 收尾第二档：**结案**（D29）。先走完影响面与遗留疑点两个强制 step（§6.2）才给结。
   *
   * 挡在这里而不是结完再补：报告的影响面栏是那一步的投影，缺了它结案只会得到
   * 一份"看起来完整实则半截"的报告。真要就这么收手，走的是归档——那一档明写着放弃。
   *
   * **执行入口只回绝、不派活**：派活是问询那条路的事。缺步走到这儿只说明界面那份
   * 快照过期了（或者确认条挂着的时候强制 step 被推翻了），这时该做的是不动手。
   */
  async closeCase(shape?: VerdictShape): Promise<ClosingOutcome> {
    if (this.caseStatus !== 'open') return { ok: true, status: this.caseStatus };
    const missing = this.closingGaps;
    if (missing.length) return { ok: false, missing };
    // 界面给的形态是人在确认条上按下去的那个选择，认它；认不出来（版本对不上、
    // 或是从别处调进来的）才退回建议值——报告总得有个装法，不能落个 NULL 进去
    this.freeze('closed', '案子已结案，', isVerdictShape(shape) ? shape : suggestVerdictShape(this.db, this.caseId).shape);
    return { ok: true, status: 'closed' };
  }

  /**
   * 收尾第三档：**归档**（D29）。同"停止"，外加标记放弃。
   *
   * **不销毁任何证据**——查到的事实照旧在库里，残报告的主体正是它们（ui.md §8.4）。
   */
  archiveCase(): CaseStatus {
    if (this.caseStatus !== 'open') return this.caseStatus;
    // 残报告的形态**强制 open**，不看 agent 声明过什么（ui.md §8.4）：主体是排除掉的方向
    // 与遗留疑点，没有根因栏。查到一半的案子照它自己的形态装，装出来的是一份看着完整、
    // 实则半截的报告——而那正是归档这一档明写要避免的
    this.freeze('aborted', '案子已归档，', 'open');
    return 'aborted';
  }

  /**
   * 收尾的公共动作：散待办 → 收会话 → 落形态 → 落状态。
   *
   * **状态最后落**：前面几步失败不该留下个冻住的空壳；反过来，状态一落下案子就宣告冻结了，
   * 那之后再写形态，写的是一个已经冻上的案子。
   */
  private freeze(status: Exclude<CaseStatus, 'open'>, why: string, shape: VerdictShape) {
    const ctx = { caseId: this.caseId, blobDir: this.blobs, now: () => Date.now() };
    this.close(why);
    setVerdictShape(this.db, ctx, shape);
    setCaseStatus(this.db, ctx, status);
    this.onChange();
  }

  /**
   * 回执是**处置成功了没有**，不是「有没有这条」。
   * 找不到就是这条已经不在这个案子手里了（切了案子 / 已经超时作废），
   * 静默 return 的话人贴进去的查询结果就凭空消失，那条回填继续挂到超时。
   */
  answerOperator(reply: OperatorReply): boolean {
    const p = this.pending.get(reply.id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(reply.id);
    p.resolve(reply);
    this.onChange();
    return true;
  }

  /** 待办栏上的两个控制手势最终都落到这里（ui.md §8.2）。 */
  decideGate(d: GateDecision): boolean {
    const gate = this.gates.get(d.id);
    // 丢掉这一下的代价比①档还大：人明明按了「拒绝」，这条却继续挂着，
    // 三分钟后按预设**自动放行**——人说过的不行会静静变成放行
    if (!gate) return false;
    gate.finish(
      d.action === 'deny'
        ? { decision: 'deny', message: d.message }
        : d.action === 'rewrite'
          ? { decision: 'rewrite', input: d.input }
          : { decision: 'allow' },
    );
    return true;
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
    // **已经有结论的一律不动。** 散场是"把还没着落的收干净"，不是"把账重写一遍"：
    // 一次 `failed`（工具自己坏了）或 `denied`（有人看过并说了不行）被改写成 `abandoned`，
    // 丢掉的正是那三种"没跑成"的区别——而这道保护要放在这里而不是各个调用点，
    // 因为闸门散场那条路一样够得到已经被规则判过 denied 的调用
    if (this.statusOf(callId) !== 'pending') return;
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
    const callId = this.claimAskCall(args.statement);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.onChange();
        resolve({ answer: '(超时未回填，请换个方向或稍后再问)', statement: args.statement });
      }, OPERATOR_TIMEOUT_MS);

      this.pending.set(id, {
        ask: { id, askedAt: Date.now(), ...args, suggestedAnswer: suggestOperatorAnswer(args.statement) },
        callId,
        resolve: (r) => resolve({ answer: r.answer, statement: r.statement, executedAt: r.executedAt }),
        timer,
      });
      this.onChange();
    });
  }

  /**
   * 认领这次回填对应的调用。
   *
   * 按语句认而不是按先后：子 agent 可以同时问出好几条，先后顺序对不上就会把甲的
   * 放弃记到乙头上。认之前先把**已经不在 pending 上的**清掉——被规则拦下、
   * 或压根没跑起来的调用会一直留在队列里。
   *
   * **认不到就认不到，不拿队首兜底。** 语句两边同源（都来自这次调用的入参），
   * 对不上就说明这条根本不是它；猜一个的代价是散场时把**别人**那次调用记成放弃，
   * 而真正该收的那条继续挂着——正好是"三种没跑成不能混"要防的那类错账。
   * 没认到的调用由停止/收尾那条路统一清，不靠这里猜。
   */
  private claimAskCall(statement: string): string | undefined {
    this.askCalls = this.askCalls.filter((c) => this.statusOf(c.callId) === 'pending');
    const at = this.askCalls.findIndex((c) => c.statement === statement);
    if (at < 0) return undefined;
    return this.askCalls.splice(at, 1)[0]?.callId;
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
    if (STRUCTURAL.has(i.tool_name)) {
      // **支线不记账**（§4.5：泳道各自收敛回主干节点）。放它开步的话，那一步落在主干上
      // （MCP 那侧拿不到 agent_id，泳道传不进去），主线随后的调用就会记进一个支线开的步里；
      // close_step 更糟，一条支线收得掉另一条根本不认识的步。所以这里当场回绝并说清怎么办
      if (i.agent_id) return hookDecision('deny', LANE_STRUCTURAL_DENY);
      return {};
    }
    const lane = this.lanes.laneOf(toolUseID, i.agent_id);

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
      lane,
      gate,
    });
    // 回填卡与它的调用在这里连线：hook 一定先于工具正文，正文里才发得出那张卡
    if (i.tool_name === toolName('ask_operator') && !gate) {
      this.askCalls.push({
        callId: toolUseID,
        statement: String((i.tool_input as { statement?: unknown } | undefined)?.statement ?? ''),
      });
    }
    if (gate) this.closeIfDenied(toolUseID, gate);
    this.onChange();

    if (gate) return hookDecision(gate.decision === 'deny' ? 'deny' : 'allow', gate.message);
    return verdict === 'gate' ? hookDecision('ask', '这次排查里它要过一道人工闸门。') : {};
  }

  private onToolEnd(input: unknown, toolUseID: string | undefined) {
    const i = input as { tool_name?: string; tool_response?: unknown };
    if (!i.tool_name || STRUCTURAL.has(i.tool_name) || !toolUseID) return {};
    const text = outputText(i.tool_response);
    // 已经收过尾的不再收第二次。停止/结案/归档会把还挂着的回填就地记成 `abandoned`，
    // 而散场用的正是"给工具那侧一个结果"——它随后照样会走完 PostToolUse。
    // 不挡这一下，人按停止散掉的调用会被这条迟到的成功盖成 `done`，
    // 轨道上于是多出一次"跑完了"的调用，实际上没有任何人回答过它
    if (this.statusOf(toolUseID) === 'pending') {
      this.session?.recordToolEnd({ callId: toolUseID, output: text });
    }
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

/** 支线跑完的措辞。`stopped` 是人手动停的，与自己跑完不是一回事。 */
function laneEndLabel(status: string): string {
  return status === 'stopped' ? '被停下' : status === 'failed' ? '失败收场' : '跑完';
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
    /** 停止要连排队消息一起清（D7）。返回清掉几条——人发过的东西凭空消失得说一声。 */
    clear() {
      const n = items.length;
      items.length = 0;
      return n;
    },
  };
}

/**
 * 结案缺步时派给 agent 的话。
 *
 * 说的是"补这两步"而不是"结案吧"：这两块的内容只能由查过的人给，
 * harness 替它写一句空话进去，报告里那一栏就是编的。
 */
function closingMessage(missing: ClosingStepKind[]): string {
  const what: Record<ClosingStepKind, string> = {
    impact: '用 open_step(kind="impact") 量化影响面：影响了多少用户/请求、时间窗口多长，要有查询作证据',
    leftover: '用 open_step(kind="leftover") 汇总还没查清的疑点；一条都没有也要开一步并写明"没有遗留"',
  };
  return [
    '准备结案了。结案前还差这几步，请依次补上，每一步都要 close_step 收口：',
    ...missing.map((k) => `- ${what[k]}`),
    '补完就停下来等我，不要顺手开新的排查方向。',
  ].join('\n');
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
