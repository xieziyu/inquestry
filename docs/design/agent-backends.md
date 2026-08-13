# Agent Backend 抽象

> 返回 [总设计纪要](overview.md)
>
> 本文展开 overview §2（订阅接入）与 §3（控制语义）在**多 agent backend** 下的形态。决策来源仍在 overview，本文只做展开与细化。

## 0. 立场

**目标是接 Claude Code 与 codex 两种 backend；第一阶段只实现 Claude。**

抽象最容易变成负债的方式是"为了证明抽象成立，先写一个空实现"——那验证不了任何东西，真正的验证发生在接第二个的时候。因此第一阶段**不写 mock backend**，只留 §3 的四条纪律，它们的共同特征是：**事后补的代价极高**。

反过来，抽象放错位置比不抽象更贵。下面先摸清落差，再定接缝。

---

## 1. 能力对照

Claude 侧为实测（`npm run spike:claude` / `spike:lane`，结论就在那两个脚本里）。codex 侧标注来源：**〔实测〕**= duetlens 在 codex `0.144.x` 上字节级验证过；**〔推断〕**= 由协议形态推导，接入前需核实。

| Inquestry 机制 | Claude Code | codex app-server | 结论 |
|---|---|---|---|
| 常驻会话 / 多轮 | SDK `query()` 流式输入 | `thread/start` + `turn/start`〔实测〕 | ✅ 同构 |
| 工具调用可观测 | 消息流 + hook 事件 | `item/started` / `item/completed`〔实测〕 | ✅ 粒度不同但够用 |
| 自建 MCP 提供三个工具 | `createSdkMcpServer`（进程内函数调用） | in-process HTTP MCP，`--url` 注入〔实测〕 | ✅✅ **完全同构** |
| turn 级中断 | `interrupt()` + receipt | `turn/interrupt`〔实测〕 | ✅（`cancel_queued` 是 Claude 细节） |
| 不打断的补充输入 | stdin 异步入队 user message | `turn/steer`〔实测存在〕 | ✅ 语义相近，取消粒度待核 |
| 从某点分叉 | `forkSession()` | `thread/fork`〔实测存在〕 | ✅ |
| 订阅额度继承 | spawn 本机 `claude`，继承 `~/.claude` OAuth | spawn 本机 `codex`，复用本机登录态〔实测〕 | ✅ 同构 |
| tool call 自动归属 step | PreToolUse hook 兜底（需 `--include-hook-events`） | item 事件流天然全量〔实测〕 | ✅ **手段不同、能力等价**（codex 侧覆盖率反而更高） |
| **改写工具参数再放行** | `{behavior:'allow', updatedInput}` | 审批只有 accept / reject〔实测〕 | ❌ **无等价物** |
| **deny + message 保 turn 上下文（D6）** | `{behavior:'deny', message}` | reject 是否可携带回话给模型〔推断：不可〕 | ❌ **落差最大的一条** |
| **运行时切 permission mode（D8）** | `setPermissionMode()` | `sandbox` / `approvalPolicy` 是 `thread/start` 参数〔实测〕 | ❌ 只能建新 thread |
| 子 agent 泳道（§4.5） | `--forward-subagent-text` + `parent_tool_use_id` | 无 subagent 概念〔推断〕 | ❌ 能力缺失 |

**读法**：上半区（✅）占了 Inquestry 骨架的绝大部分，抽象成本低；下半区（❌）全部集中在 **overview §3 控制语义**，且都是"有/无"而非"形态不同"——这决定了接缝怎么切。

---

## 2. 三段接缝

不是一层大接口，是三段性质不同的边界。

### 2.1 工具契约层 —— 天然跨 backend，零抽象成本

**Inquestry 的核心结构全部经由 MCP 工具产生，而 MCP 是标准协议。**

| 设计物 | 载体 | 与 backend 的关系 |
|---|---|---|
| Step 骨架（D5） | `open_step` / `close_step` 的工具参数 | 无关 |
| 人工回填 + `expect`（D15/D16） | `ask_operator` 的工具参数 | 无关 |
| EvidenceRef 双时间戳（D11） | harness 从工具输出抽取 | 无关 |
| 两条时间线 / 报告投影（D17） | SQLite 查询 | 无关 |

**落地要求：三个工具的 handler 写成传输无关的纯函数**，两种 MCP server 只是把同一组 handler 挂上去的 adapter。

```
tools/                 // schema + handler，不 import 任何 backend 类型
  ├─ sdk-mcp-adapter   // Claude: createSdkMcpServer，进程内函数调用
  └─ http-mcp-adapter  // codex: in-process HTTP server + --url 注入
```

传输不能统一，是 codex 侧的硬约束：**实测 codex 会对同一 MCP server 做多次 `initialize`**，stdio 子进程会被反复 respawn，故必须 HTTP。这是 duetlens 已经付过学费的地方。

> 第一阶段就按这个形状写。handler 里一旦混进 SDK 的 tool context 类型，第二阶段等于重写。

### 2.2 会话与事件流层 —— 照抄 duetlens 的 `ConversationalAgent`

接口面：`start` / `send` / `streamEvents` / `interrupt` / `fork`。把 backend 的事件归一成领域事件。

**这层的成本几乎全是命名自律**，写不写接口都得付：

| ✅ 领域词汇 | ❌ backend 词汇 |
|---|---|
| `ToolCallStarted` | `PreToolUseEvent` |
| `SessionForked` | `forkSession` |
| `TurnFailed` | `turn/completed` 的 `turn.error` |

沿用 duetlens 的**领域事件面编译期收敛**：事件名→载荷单一来源、`emit` 私有、renderer 侧 `switch` + never 哨兵。Inquestry 的事件种类比 duetlens 多得多（step / tool / evidence / pending / 泳道），漏接一个就是某类节点在 UI 上静默消失——duetlens 上"整个 Discussion 栏为空却无人报错"就是这么来的。

### 2.3 控制语义层 —— 抽象成**能力**，不是方法

§1 下半区那些落差**不能抹平成"接口里有个 `deny` 方法，codex 实现降级为 no-op"**。那样 UI 会假设手势永远可用，到了 codex 上静默失效。

改为能力描述符，**UI 按能力渲染**：

```
AgentCapabilities {
  rewriteToolInput      // 「改写参数再放行」手势渲不渲染
  denyWithoutInterrupt  // D6 换方向；false 时只能给「拦下并停 turn」
  runtimePermissionMode // D8 一键接管按钮的显隐
  subagentLanes         // 泳道 UI
  queuedMessageCancel    // §3.3 撤回
}
```

这不是新机制，是把 overview 附录里已有的决策**升一级**：`system/init` 的 `capabilities` 本就要求 feature-detect 而非版本嗅探。同一套机制顺带覆盖 Claude 自身的版本差异（`interrupt_receipt_v1` / `interrupt_cancel_queued_v1` 有没有），backend 维度只是又一个来源。

---

## 3. 第一阶段的四条纪律

第一阶段 `InvestigationSession` 直接吃 Claude SDK 的具体类型没问题——**只要守住这四条，第二阶段的重构面是加法，不是重写**。

| # | 纪律 | 不守的代价 |
|---|---|---|
| 1 | **schema 里 backend 是一等字段**：`session` 表存 `backend` + `nativeSessionRef`（Claude 的 sessionId / codex 的 threadId 收进同一列） | 第二阶段要迁移历史数据，而历史数据正是本工具的全部价值 |
| 2 | **renderer 零 backend 类型**：`src/shared` 只出现自有领域类型 | SDK 类型渗进 UI，换 backend 要动整个前端 |
| 3 | **MCP handler 传输无关**（§2.1） | 三个核心工具要按 backend 各写一遍 |
| 4 | **领域事件命名无 backend 词汇**（§2.2） | 改名波及事件表、投影、UI 三处 |

---

## 4. 已知落差与降级路径

**接入 codex 时这些是设计既定结果，不是待查的 bug。**

| 落差 | 影响 | 降级路径 |
|---|---|---|
| **无 deny + message（D6）** | 「agent 钻牛角尖需就地纠偏」这个高频场景体验实质弱一档 | `turn/steer`——不打断、追加指令，语义是"我不拦你但你看一眼"。比 D6 弱，比没有强 |
| 无改写参数再放行 | 查询语句写窄了不能直接改了让它跑 | 拒绝 + 在 message / steer 里给出正确语句 |
| permission mode 不可运行时切（D8） | 「一键接管」按钮不可用 | 隐藏该手势；改档需新建 thread（会丢 turn 内上下文） |
| 无子 agent 泳道 | Timeline 退化为单主干 | 泳道 UI 按 capability 关闭，不留空槽 |

> **codex backend 的排查体验会整体弱一档，主要弱在控制面。** 这不是不接的理由，但要在接之前就写明，而不是接完当 bug 查。

> **接入前必须先核实这几条〔推断〕**：codex 的 reject 能否携带消息回给模型且不中断 turn（决定 D6 是否真的无解）· `turn/steer` 的确切语义与取消粒度 · 有没有可用的 subagent / 并行支线概念 · `thread/fork` 的分叉点粒度够不够细。
