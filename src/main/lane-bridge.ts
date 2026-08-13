/**
 * 子 agent 泳道的归属桥（overview §4.5，实测见 `scripts/spike-lane.ts`）。
 *
 * lane key 是**起这条支线那次调用的 `tool_use_id`**，而记账口（PreToolUse）给的是
 * `agent_id`——两个键天生不同。两边都有的只有**内层那次调用的 `tool_use_id`**：
 * hook 侧连同 `agent_id` 一起给，转发上来的子 agent 消息里连同 `parent_tool_use_id`
 * （= lane key）一起给。按它一 join，`agent_id ↔ lane` 就闭合了。
 *
 * ⚠️ **不要按到达顺序或「最近一次 Task 调用」去猜。** 并发时支线的到达顺序会与发起顺序
 * 反过来（A.1 特意把 alpha 那条拧慢了才排除掉这种错写法），猜出来的答案会把甲的证据
 * 记到乙的泳道上——而这种错账没有任何报错，只有读报告的人有一天发现对不上。
 *
 * 单独成文件是因为它是这一带唯一算得出对错的部分：`spike:branch` 直接喂消息给它，
 * 不必起真会话（真会话那侧由 `spike:lane` 兜底）。
 */

/** 流消息里这个桥用得上的那几个字段。结构化取值，不依赖 SDK 的具体类型。 */
export type LaneMessage = {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
  task_id?: string;
  tool_use_id?: string;
  status?: string;
  summary?: string;
  tasks?: unknown[];
};

/**
 * 一条支线跑完的通知。**被人停掉的支线不发 `SubagentStop`，只发这个**（A.1），
 * 所以收口只认它。
 *
 * `summary` 是**支线自己的话**：优先 `SubagentStop` 给的最后一句（那是它对主线说的结论），
 * 退回这条通知自带的摘要。harness 不替它编一句判定——收口那一步唯一能说的就是它说过什么。
 */
export type LaneFinish = { lane: string; agentId: string; status: string; summary: string };

export class LaneBridge {
  /** 内层 `tool_use_id` → lane key。桥的左半边，由转发上来的子 agent 消息填。 */
  private byCall = new Map<string, string>();
  /** `agent_id` → lane key。桥合拢之后记住，同一条支线后续的调用直接查它。 */
  private byAgent = new Map<string, string>();
  /** `background_tasks_changed` 给的电平：现在还有几条支线在后台跑。 */
  private level = 0;
  /**
   * 还没收到收尾通知的泳道（lane → agent_id）。**按 hook 侧的 `agent_id` 建，不按电平的
   * `tasks[].task_id` 建**：后者与 `agent_id` 是不是同一个键还没有人实测过，而停一条支线
   * 认的正是 `agent_id`（A.1 验过 `task_id === agent_id`，那是 `task_notification` 那侧）。
   * 拿一个没验过的 id 去 `stopTask`，停不掉还是停错了都不会有报错。
   */
  private live = new Map<string, string>();
  /** `SubagentStop` 给的最后一句话，按 `agent_id` 存着等收尾时用。 */
  private lastWords = new Map<string, string>();
  /** 已经收过尾的泳道。收尾是一次性的，第二条通知不该再惊动收口那侧。 */
  private finished = new Set<string>();

  /**
   * 吸收一条流消息。返回值只在支线跑完时非空——调用方要说一声，
   * 否则一条后台支线会悄悄地查完悄悄地回来（§3.4）。
   */
  absorb(msg: LaneMessage): LaneFinish | null {
    if (msg.type === 'assistant' && msg.parent_tool_use_id) {
      for (const id of toolUseIds(msg.message?.content)) this.byCall.set(id, msg.parent_tool_use_id);
      return null;
    }
    if (msg.type !== 'system') return null;
    // 电平是 UI 唯一的「还有支线在跑」依据：`result` 一到主线就不忙了，
    // 而那一刻后台可能还有几条在查
    if (msg.subtype === 'background_tasks_changed') {
      this.level = Array.isArray(msg.tasks) ? msg.tasks.length : 0;
      return null;
    }
    if (msg.subtype === 'task_notification') {
      // `task_id` 就是那条支线的 `agent_id`（A.1）
      const agentId = msg.task_id ?? '?';
      // **认过的那条优先，通知里的 `tool_use_id` 只是退路。** 两者不一致是常态：
      // 桥没合拢时这条支线是按 `agent:<agent_id>` 记的账（`laneOf`），而通知带的是真 key——
      // 信通知的话，收口去查一个库里从来没有过的 lane，那一步收不到、「停」也撤不掉，
      // 一条早就跑完的支线于是挂到会话结束才被当成 orphan。这与 `laneOf` 的"认过就不改口"
      // 是同一条纪律：**以已经记上账的那个 key 为准**。
      // 反过来退路也省不掉——`tool_use_id` 缺席时 `agent_id` 是找得到步的唯一线索
      const lane = this.byAgent.get(agentId) ?? msg.tool_use_id;
      if (!lane) return null;
      // **一条泳道只收一次尾。** 再来一条通知时照旧返回 LaneFinish 的话，收口那侧查不到
      // 开着的步，会把它解释成"这条支线没有留下任何调用"并再说一遍——而它明明查了一堆东西
      if (this.finished.has(lane)) return null;
      this.finished.add(lane);
      this.live.delete(lane);
      return {
        lane,
        agentId,
        status: msg.status ?? 'completed',
        summary: this.lastWords.get(agentId)?.trim() || msg.summary?.trim() || '',
      };
    }
    return null;
  }

  /**
   * `SubagentStop` 给的最后一句话。**只存不判**：这条 hook 到得比 `task_notification` 早，
   * 而被人停掉的那条根本不发它（A.1）——所以它是锦上添花的那一半，收口不能等它。
   */
  noteSubagentStop(agentId: string, lastMessage?: string): void {
    if (lastMessage?.trim()) this.lastWords.set(agentId, lastMessage.trim());
  }

  /** 还没收尾的泳道，按第一次工具调用认出来的先后。UI 只给这些泳道显示「停」。 */
  get liveLanes(): string[] {
    return [...this.live.keys()];
  }

  /** 停一条支线要的 `task_id`（= `agent_id`，A.1）。认不出来就别停——停错一条不会有报错。 */
  agentOf(lane: string): string | undefined {
    const live = this.live.get(lane);
    if (live) return live;
    for (const [agentId, l] of this.byAgent) if (l === lane) return agentId;
    return undefined;
  }

  /**
   * 这次调用属于哪条泳道；`undefined` = 主干。
   *
   * **没有 `agent_id` 一律是主干**——起支线的那次调用本身也没有它（A.1 检查 1），
   * 所以主线的 Task 调用会正确地留在主干上，它派生的那条泳道才挂到它下面。
   *
   * **有 `agent_id` 就一定不是主干，哪怕桥还没搭上。** 转发消息与 hook 谁先到不保证，
   * 桥没合拢时退回 `agent:<agent_id>` 这个临时 key，而不是回 `undefined`——回主干的话，
   * 那次支线查询会记进主线正开着的那一步，报告里于是有一步的证据来自它从没发起过的查询，
   * 而这条错账没有任何报错。代价只是那条泳道认不出父，在轨道上落到主干层显示（仍带支线徽标）。
   *
   * **一个 `agent_id` 认过的泳道就不再改**（`byAgent` 先查）：桥晚一步合拢时升级 key，
   * 换来的是同一条支线裂成两步——已经记上账的那几次调用留在旧 key 上，正是 D23 禁的那种回头改。
   */
  laneOf(callId: string, agentId?: string): string | undefined {
    if (!agentId) return undefined;
    const known = this.byAgent.get(agentId);
    if (known) return known;
    const lane = this.byCall.get(callId) ?? `agent:${agentId}`;
    this.byAgent.set(agentId, lane);
    // 第一次工具调用就是这条支线「活着」的第一个证据，也是唯一一处拿得到 `agent_id` 的地方
    this.live.set(lane, agentId);
    return lane;
  }

  /** 还有几条支线在后台跑。 */
  get backgroundLanes(): number {
    return this.level;
  }

  /** 换会话时清空：lane key 是上一次会话的 `tool_use_id`，留着只会张冠李戴。 */
  reset(): void {
    this.byCall.clear();
    this.byAgent.clear();
    this.live.clear();
    this.lastWords.clear();
    this.finished.clear();
    this.level = 0;
  }
}

function toolUseIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return (content as { type?: string; id?: string }[])
    .filter((b) => b?.type === 'tool_use' && typeof b.id === 'string')
    .map((b) => b.id!);
}
