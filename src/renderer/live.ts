import type { CallNode, ChatLine, StepNode } from '../shared/ipc.js';
import { isFoldedFallback } from '../shared/report.js';
import { CASE_BOX_ID } from './track.js';

/**
 * 舞台的心跳层：**此刻在干什么**（`Stage.tsx` 的卡面底带 · 列头芯片 · HUD「最后更新」）。
 *
 * 要修的是这个：调查跑起来之后舞台上没有任何运行信号，一次几十秒的调用期间画面零变化，
 * 人据此判定它卡住了。卡上那枚 `.pulse` 只说明「这一步没收口」，不随调用变化，
 * 证明不了还在动。
 *
 * 给的是**会变的量**（工具名 · 秒数 · 计数），不是动画：关掉 `prefers-reduced-motion`
 * 之后这一层照样成立，而数字是 DOM 文本、写得出会失败的断言。
 *
 * 🔴 **这里一律不读时钟。** 每个结果只给"从哪一刻起"，"跑了多久"由订阅秒钟的那几个
 * 叶子组件现算（理由见 `clock.ts`）。这儿要是自己算一个秒数出来，它就得随快照才更新，
 * 而快照恰恰不会每秒推——那正是这一层要解决的问题本身。
 *
 * 判断全提成纯函数：renderer 没有 node 侧的回归网，只有提出来的这部分验得了
 * （`scripts/spike-live.ts`）。
 */

/** 一次调用跑过这么久就在秒数后面缀「未回」。**颜色不变**——暖色是「需要人动手」的全局专属。 */
export const STALE_MS = 60_000;

export type LiveActivity =
  /** 有调用没回来。`since` 是那次调用起跑的时刻。 */
  | { kind: 'call'; toolName: string; since: number; calls: number; evidence: number }
  /** 没有调用在跑，但这一轮还没交回来。`since` 是这一步最后一次真的发生了什么的时刻。 */
  | { kind: 'thinking'; since: number; calls: number; evidence: number }
  | null;

/**
 * 这一步最后一次真的发生了什么：它自己开出来 / 收口，或它的某次调用起跑 / 收回。
 *
 * 🔴 **收口那一刻非算不可，而且只有 `step.endedAt` 说得出。** `close_step` 是结构工具，
 * `case-runner.ts` 的三条 hook 把它挡在 `tool_calls` 之外（账本不给自己记一笔），
 * 而证据也只在 close 里落（`sqlite-store.ts` 里 `evidence.attached` 只有那一个发处，
 * `observed_at` 与这一刻是同一个）。漏了它的表现是：agent 刚收了一步、刚挂上五条证据，
 * HUD 却说"最后更新 3 分钟前"——把最有进展的那一下说成了停滞。
 */
function lastTouch(step: StepNode): number {
  let at = Math.max(step.startedAt, step.endedAt ?? 0);
  for (const c of step.calls) {
    const t = c.endedAt ?? c.startedAt;
    if (t > at) at = t;
  }
  return at;
}

/** 并发那一批里最早起的那次。秒表因此报的是"最久的那个还没回来多久"，「未回」也落在真的慢的那次上。 */
function earliest(calls: CallNode[]): CallNode | null {
  let out: CallNode | null = null;
  for (const c of calls) if (!out || c.startedAt < out.startedAt) out = c;
  return out;
}

/**
 * 这一步此刻在干什么；不在动就是 `null`。
 *
 * 三种"不在动"分得清清楚楚，因为它们在屏幕上各有各的说法：
 * - **已收口**：停掉一条支线会在库里留下一条 `pending` 的调用，认它的话那张定稿的卡
 *   会一直挂着一个永远走下去的秒表。所以先看 `status`，不看调用
 * - **卡在①/②档**（`waiting`）：此刻它确实没在动，装成在动是骗人。那一档由 `.waitbadge`
 *   与钉在视口上的待办卡说
 * - **这一轮已经交回来了**（`busy` 假）：主干那一步照旧开着，但没人在跑
 */
export function stepActivity(
  step: StepNode,
  ctx: {
    /** 这一步正卡在①档回填或②档闸门上（`Stage.tsx` 的 `waiting`）。 */
    waiting: boolean;
    /** 主线这一轮还没交回来（`snap.busy`）。 */
    busy: boolean;
    /** 还没收尾的那几条泳道（`snap.liveLanes`）。 */
    liveLanes: ReadonlySet<string>;
    /** runner 这会儿跑在哪个 session 上（`snap.sessionId`）。 */
    sessionId: string;
    /** 「agent 在想」这会儿落在哪张卡上；见 {@link thinkingStep}。 */
    thinkingStepId: string | null;
  },
): LiveActivity {
  if (step.status !== 'open' || ctx.waiting) return null;
  /**
   * 🔴 **上一次会话留下的步一律不算在动，哪怕它还开着、里面还挂着 `pending` 的调用。**
   * 一次调查跨多会话，而收尾只收支线——主干那一步没人替它 `close_step`，于是每断一次
   * 会话，轨道上就多一张永远开着的旧卡。`busy` / `liveLanes` 答的是"现在有没有事在跑"，
   * 它们对这些旧卡一个字都说明不了：新一轮一开 `busy` 就回真，那些旧账会跟着一起活过来。
   *
   * 崩溃后接着发一句话正是这条路（`App.submit` 在会话不 live 时走 `start()`，
   * 而 `endOnce('crashed')` 只收支线、主干那几条没收的调用要等下次启动的 `sweepZombies()`）：
   * 不认会话的话，刚刚才安静下去的那张僵尸卡会重新挂上旧工具名和一路往上加的秒表。
   */
  if (step.sessionId !== ctx.sessionId) return null;
  /**
   * 再问"跑这一步的那一头还活着没有"，然后才看有没有调用挂在 pending 上——库里那个
   * `pending` 自己说明不了还在跑（同上）。
   *
   * 主干那一头是 `busy`，支线那一头是它自己那条泳道——**支线不能看 `busy`**：
   * 主线交回来了支线照样在后台查（`Snapshot.busy` 那段注释说的正是这件事）。
   */
  const alive = step.lane ? ctx.liveLanes.has(step.lane) : ctx.busy;
  if (!alive) return null;

  // 计数只数**收回来了的**：还在跑的那次由前面的工具名与秒表单独说，数进来等于说它已经有结果了
  const counts = {
    calls: step.calls.filter((c) => c.endedAt !== null).length,
    evidence: step.evidence.length,
  };

  const running = earliest(step.calls.filter((c) => c.status === 'pending'));
  if (running) return { kind: 'call', toolName: running.toolName, since: running.startedAt, ...counts };

  // 「在想」只给主干：支线是在想还是在等，harness 这侧分不出来，**分不出来就不说**。
  // 这儿不必再问一次 `busy`——上面那道 `alive` 对主干问的就是它
  if (step.id !== ctx.thinkingStepId) return null;
  return { kind: 'thinking', since: lastTouch(step), ...counts };
}

/**
 * 「agent 在想」落在哪张卡上。主干（`lane === null`）当前开着的那一步，同时开着好几步时认最后一个；
 * **主干上没有开着的可见步时落回信息卡**（`CASE_BOX_ID`）。
 *
 * 🔴 **落点必须是舞台上真有的那张卡。** 主干兜底步不再出卡（`trackLayout` 滤掉了它），
 * 而它恰恰是"正常步全关之后唯一还开着的主干步"——认它的话，收尾那段时间里
 * 「agent 在想」会挂到一张不存在的卡上，表现是这个信号整个消失，且没有任何报错。
 * 信息卡是主干那一列的头，也是那几次不属于任何方向的调用的落点，落回它是同一条归属。
 *
 * 🔴 **只认这一次会话的。** 上一次会话断在半途留下的 open 步会一直挂在轨道上，
 * 而它恰恰排在后面——不筛会话的话，新一轮刚开、agent 还没 `open_step` 的那几十秒里，
 * 「agent 在想」会落到上一次会话最后那张卡上，秒数从几小时前算起。
 */
export function thinkingStep(steps: StepNode[], sessionId: string): string {
  let id: string = CASE_BOX_ID;
  for (const s of steps) {
    if (s.lane || s.status !== 'open' || s.sessionId !== sessionId) continue;
    if (isFoldedFallback(s)) continue;
    id = s.id;
  }
  return id;
}

/**
 * **这一次会话里**最后一次真的发生了什么；这一轮还什么都没发生时给 null。
 *
 * 🔴 **信息卡那条底带的秒表只能用这一份，不能用 {@link lastUpdate}。** 后者跨整次调查
 * （HUD 的「最后更新」问的正是那个），而底带答的是"这一轮想了多久"——一次调查跨多会话，
 * 新一轮刚开、agent 还没 `open_step` 也还没发出第一次调用的那几十秒里，拿跨会话那份当起点，
 * 卡上的秒数从上一次会话最后那件事算起，一开屏就是几小时。这道会话闸与 `stepActivity` /
 * {@link thinkingStep} 那两道是同一条：**心跳层的每个信号都只说这一轮的事**。
 *
 * 给 null 时界面只写「agent 在想」、不带秒数：快照里没有会话启动时刻（对话行不带
 * `sessionId`，认不到这一轮的开场白），而编一个起点出来与真的从那一刻起长得一模一样。
 */
export function sessionLastTouch(steps: StepNode[], sessionId: string): number | null {
  let at = 0;
  for (const s of steps) if (s.sessionId === sessionId) at = Math.max(at, lastTouch(s));
  return at || null;
}

export type LaneActivity =
  /** 有调用在跑，说得出是哪个。 */
  | { kind: 'call'; toolName: string; since: number }
  /** 在动，但说不出在跑什么（两次调用之间）。 */
  | { kind: 'live' }
  /** 唯一没收的那次调用挂在人身上——它**不在动**。 */
  | { kind: 'waiting' };

/**
 * 这条支线此刻在干什么。调用方自己按 `snap.liveLanes` 判这条线还在不在——那份是 hook 侧
 * 按 `agent_id` 认的，比"库里还有没有 open 的步"准。
 *
 * 🔴 **`waiting` 这一档必须与 `live` 分开，两者都是"没有调用在跑"，说的却是相反的事。**
 * 支线的调用照样过闸门、照样开得出回填卡（`onToolStart` 不看 `agent_id`），而挂在闸门上的
 * 调用在库里仍是 `pending`、那条泳道也仍在 `liveLanes` 里。合成一档的话，一条整个卡在人
 * 身上的支线会被列头说成「在跑」，而它那张卡就在正下方写着「等你处理」——一屏上两句相反的话，
 * 而人扫列头是为了找"哪一条在动"，于是正好绕开了那件要他动手的事。
 */
export function laneActivity(
  steps: StepNode[],
  lane: string,
  /** 挂在①档回填或②档闸门上的调用 id。它们不在跑，只是在等人。 */
  parked: ReadonlySet<string>,
  /** runner 这会儿跑在哪个 session 上，同 `stepActivity`。 */
  sessionId: string,
): LaneActivity {
  const running: CallNode[] = [];
  let held = false;
  for (const s of steps) {
    // 会话这道闸与 `stepActivity` 那道是同一条：**卡与列头必须在任何输入下都说同一句话**。
    // 真跑起来时 `beginSession()` 会 `lanes.reset()`，旧泳道键进不了新一轮的 `liveLanes`，
    // 所以这一句多数时候不改变结果——但那是隔着一个模块的假设，就近筛一次便宜得多
    if (s.sessionId !== sessionId || s.lane !== lane || s.status !== 'open') continue;
    for (const c of s.calls) {
      if (c.status !== 'pending') continue;
      if (parked.has(c.id)) held = true;
      else running.push(c);
    }
  }
  const first = earliest(running);
  if (first) return { kind: 'call', toolName: first.toolName, since: first.startedAt };
  return held ? { kind: 'waiting' } : { kind: 'live' };
}

/**
 * 整次调查最近一次真的发生了什么，以及它落在哪一步。
 *
 * **与底带的秒表回答的不是同一个问题**：底带的秒数一直在走（证明界面没死），
 * 而「最后更新 3m20s 前」说的是"这段时间里没有任何新东西"——一次九十秒的调用里，
 * 后者才是"它是不是卡住了"的答案。两个都要有。
 *
 * `stepId` 为 null = 最近那件事是一句对话，「跳过去」没有落点，由调用方退回图上最后一张。
 * 落在主干兜底步上时给信息卡：那几次调用归它认领，而兜底步在舞台上没有卡，
 * 报它的 id 等于给出一个「跳过去」跳不到的落点（同 {@link thinkingStep}）。
 */
export function lastUpdate(steps: StepNode[], chat: ChatLine[]): { at: number; stepId: string | null } {
  let at = 0;
  let stepId: string | null = null;
  for (const s of steps) {
    const t = lastTouch(s);
    if (t > at) {
      at = t;
      stepId = isFoldedFallback(s) ? CASE_BOX_ID : s.id;
    }
  }
  for (const c of chat) {
    if (c.at > at) {
      at = c.at;
      stepId = null;
    }
  }
  return { at, stepId };
}

/**
 * 时长文案：`40s` / `3m20s` / `1h5m`。**底带与 HUD 共用这一份**，各写各的必然长歪。
 *
 * `markStale` 只给"一次调用还没回来"那一档：过 `STALE_MS` 之后缀「未回」两字。
 */
export function elapsedText(ms: number, markStale = false): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const text = h > 0 ? `${h}h${m}m` : total >= 60 ? `${m}m${s}s` : `${s}s`;
  return markStale && ms >= STALE_MS ? `${text} 未回` : text;
}
