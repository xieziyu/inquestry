# Inquestry —— 排查小助手设计纪要

> 首次成文：2026-08-10
> 状态：v0.1 可运行，界面规格已定（D21–D29），按 §9.5 进开发
> 定位：本仓库的**总设计纪要**。后续按主题拆分（data-model / ui / open-questions）时，本文保留为总览与决策来源，拆出的文档只做展开，不复制决策。
>
> 已拆出：
> - [architecture](architecture.md) —— 技术栈、后端分层、存储与 IPC、前端状态分层、屏幕划分
> - [agent-backends](agent-backends.md) —— 多 backend 抽象：能力对照、三段接缝、第一阶段纪律
> - [data-model](data-model.md) —— 三层结构、关键字段、两条时间线的投影查询、FTS5 中文实测
> - [tools](tools.md) —— 三个工具的契约、提示词、真 agent 遵从性实测
> - [ui](ui.md) —— 界面规格：两个阶段、三区调查台、人工介入三级、报告与两种导出、案子的一生
> - [mockups/](mockups/) —— 定稿时的冻结快照，只作记录，不再维护
>
> **写这些文档的一条约定：不写会随代码变的数字。** 「四条不要改回去的」「spike 兜底（51 条）」这类引导语，
> 每加一条就得回头改一次，而漏改是常态——评审里已经因此提过好几次。清单就写清单，
> 数量让读的人自己数；确实要给规模感就说"由 `npm run spike:close` 兜底"，不带条数。
> 例外是**设计本身定死的封闭集**（两条时间线 / 三种收尾 / 五种结论形态 / 三个工具）——
> 那些数字变了就是设计变了，写出来反而是承诺。

---

## 0. 命名

**Inquestry** = `inquest`（死因/事故的正式调查程序）+ `-ry`（表「一整套体系 / 积累起来的集合」，同 registry / ancestry / forestry）。字面读作「调查记录的集合体」。

- `inquest` 命中核心语义——**确立事实的正式程序**，终点是宣读 **verdict**，与 Step 的字段名同构；它同时要求重建事件时间线 + 认定死因，正对应事故时间线 + 根因
- `-ry` 补上 `inquest` 覆盖不到的一维：**沉淀**。单次调查是 inquest，把所有调查积累成的档案体系才是 inquestry——对应 Case 层、跨 case 检索、事故档案库
- 读音 /ɪnˈkwestri/，与 registry 同韵

占用检查（2026-08-10）：GitHub 仓库搜索零结果；npm 未注册；`inquestry.com` / `.dev` / `.io` 均无 NS 记录。

---

## 1. 定位

### 1.1 要解决的问题

日常已用 Claude Code 排查线上问题——接入云日志服务（腾讯云 CLS / 阿里云 SLS）、Sentry 和代码仓库，再用一个自定义 skill 做编排。定位准确度够用，但排查过程的**中间态不可见、不可回溯**：

- 排查细节只在思考链或简短汇报里露出一点阶段性总结
- 想看「每一步在验证什么、执行了什么查询、原始输出是什么」非常麻烦
- 排查完成后无法沉淀成可复用的事故报告

### 1.2 第一性定位

> 真正的问题不是 agent 说得太少，而是**证据在汇报环节被有损压缩了**。
> agent 读了 500 行日志，只写一句「主从复制延迟导致写入后读不到」，那 500 行没留存，复核只能重跑。

由此：

> **harness 负责把每一次工具调用的原始输入/输出完整落库；
> agent 的文字只做索引和判断，不承担搬运证据的职责。**

Timeline 因此不是"日志美化"，而是**证据库 + 推理链的双层结构**。

### 1.3 Timeline 是控制面

工具形态是**实时交互**（边排查边看、能及时打断换方向），因此 Timeline 不是展示层，是控制面——**每个节点上要挂载可执行的操作**（放行 / 改写 / 拒绝 / 转后台 / 接管）。

### 1.4 两条时间线

设计分水岭，也是最终报告质量的关键。

| | 排查时间线 | 事故时间线 |
|---|---|---|
| 回答 | 我（agent）按什么顺序做了什么 | 系统当时到底发生了什么 |
| 排序依据 | agent 行动顺序（`observedAt`） | 事件真实发生时间（`occurredAt`） |
| 性质 | 操作日志 | 因果重建 |
| 用途 | 过程可溯源、实时介入 | **最终报告主体** |

示例（"为什么产生了两条重复记录"的最终汇报）：

```
12:03:01.220  用户点击提交             [evidence: 网关日志 req_id=abc]
12:03:01.480  主库写入成功 id=X        [evidence: 手工 SQL 结果]
12:03:01.900  客户端 2s 超时未收到响应  [evidence: Sentry event]
12:03:02.100  客户端自动重试
12:03:02.240  服务端读从库未命中 id=X   [evidence: 应用日志，主从延迟 340ms]
12:03:02.390  写入第二条 id=Y          ← 重复产生
```

**这条线里没有一条是「我查了什么」。** 它由排查过程采集的证据重建而成，顺序与排查顺序基本无关——第 2 行的证据很可能是第 9 步才查到的。

推论：最终报告的主体是一条**独立的、由证据投影出来的线**，不是排查时间线的摘要。

---

## 2. 订阅接入

**结论：能用订阅，机制与 codex app-server 一致。**

CLI 长驻双向流模式：

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --forward-subagent-text \
  --include-hook-events \
  --replay-user-messages \
  --session-id <uuid>
```

stdin 喂 JSON 消息、stdout 吐事件流，长驻进程，多轮对话。上层可用 `@anthropic-ai/claude-agent-sdk` 封装好的 spawn + 协议。

**授权边界（硬约束）：**

- SDK / headless 模式**spawn 本机 `claude` 二进制，继承 `~/.claude` 的 OAuth 凭据** → 走订阅额度
- **架构必须是「壳 + spawn CLI」**，不能自己写 HTTP client 打 api.anthropic.com
- **禁用 `--bare`**——它强制 auth 走 `ANTHROPIC_API_KEY` / apiKeyHelper

**白送的能力：** 这样跑的 session 照常加载用户已有的 skill 和 MCP 配置，现成的日志查询、Sentry、代码检索能力不用重建。

---

## 3. 控制语义

三档粒度差别很大，**UI 上对应三种不同手势，不要混成一个 Stop 键**。

### 3.1 一级：`canUseTool` —— 单次工具调用级（最细，最常用）

每次工具调用前回调到 UI，参数含 `toolName` / `input` / `toolUseID` / `agentID`（子 agent 来源，`undefined` 为主线）/ `title` / `displayName` / `description` / `suggestions` / `signal`。

> ⚠️ 接起来才发现：**"每次工具调用前"要打个折扣**——backend 觉得不用问就不会问，只读工具按默认模式直接放行，`canUseTool` 根本不到。真正每次都到的是 `PreToolUse` hook，闸门的入口在那儿（[ui](ui.md) §8.1）。

| 返回 | 效果 |
|---|---|
| `{behavior:'allow', updatedInput}` | **可改写参数再放行**——查询语句写窄了，直接改了让它跑 |
| `{behavior:'deny', message:'...'}` | 拒这一个调用，**把话带给 agent，turn 不中断**，就地换方向 |
| `{behavior:'deny', message, interrupt:true}` | 拒 + 停掉整个 turn |

> **关键决策：「打断当前方向、换个方向」用中间那行（deny + message）。**
> turn 的上下文全部保留，agent 收到纠偏就继续走。排查场景里前面几十轮的日志上下文重建成本极高，这个区别非常值钱。

### 3.2 二级：`interrupt()` —— turn 级（Stop 按钮）

杀整个 turn，连同所有子 agent。

- 返回 receipt，含 `still_queued`（会在这之后继续跑的排队消息 uuid）
- **Stop 按钮应传 `cancel_queued: true`**，一次性连排队消息清掉；否则按了停、队列里的东西照跑，体感是"没停住"
- 能力探测：`system/init` 的 `capabilities` 含 `interrupt_receipt_v1` / `interrupt_cancel_queued_v1`，需 feature-detect 而非版本嗅探

### 3.3 三级：异步消息入队 —— 不打断

turn 进行中往 stdin 塞 user message（带 uuid），可事后 `cancel_async_message` 撤回。语义是"我不拦你，但你这轮收尾时看一眼我的补充"。

**取消粒度坑：** 一批消息被 dequeue 并合并成一个 turn 后，取消**非代表** uuid 是 no-op（内容照跑），取消**批次代表** uuid 会丢掉整批。两种情况响应都报 `cancelled:false`。

### 3.4 子 agent 泳道的处置

- **不能**单独 kill 一条泳道
- **能**单独转后台：background-tasks 控制请求带 `tool_use_id` 只针对那一个任务。该工具调用立刻返回"已转后台"的 tool_result，主线继续；支线跑完发 `task_notification` 回来

> 三条并发支线里有一条在钻牛角尖，不想等它、也不想丢掉它万一有用的结果 → 折叠到后台，主线往下走。

### 3.5 接管模式（分层放行）

全程每个调用都弹给人会累死，全程不管又来不及拦。因此：

- 默认：只读类（日志查询、Read、Grep、Sentry）自动放行，UI 上只流过
- 拦截点只放在 `open_step` 边界——**方向变了才需要人表态**
- 一键"接管"：`setPermissionMode('manual')` 运行时切换，之后每步过审，可随时切回

### 3.6 ⚠️ 阻塞兜底（必做）

`canUseTool` 返回 Promise，**不响应就一直挂着，agent 干等**。必须有超时兜底（如 60s 未响应按预设策略走），并在节点上标记"自动放行"。同样适用于 `ask_operator`（§5）。

### 3.7 `open_step` 的第二重价值：减速带

实时模式的硬约束：**agent 一个 turn 里可能并发甩出 5 个工具调用，等人看清在查什么，日志已经查完了。**

`open_step(direction)` 除了提供结构，更重要的是**在 agent 动手之前先把意图渲染出来**——看到的是"我怀疑是从库延迟，准备拉 create 前后 5 秒的主从日志"，而不是五个已经在跑的 query。这个几百毫秒到几秒的窗口，就是能有效介入的**全部窗口**。

配套：`open_step` 支持软确认——默认自动放行，可对某个 step 点"我要审"，之后它下面的工具调用逐个走 `canUseTool`。

---

## 4. 数据模型

### 4.1 层级

```
Case (事故)  ──┬── Session (一次对话)  ── Step ── ToolCall ── EvidenceRef
  title        ├── Session
  status       └── Session
  report
```

一次事故经常跨多个会话（今天查一半明天接着查，或换个角度重开一轮），所以 session 之上必须有 Case 层。**检索维度是事故，不是会话。** Case 只需存一组 session id。

Claude Code 侧支撑：`--session-id` 指定、`--resume` 续接、`forkSession` 从某点分叉（"从第 5 步换个假设重来"，前面上下文全留着）。

### 4.2 Step 节点

```
Step {
  id, parentStepId, lane          // 子 agent 用 parent + lane
  direction    : 这一步想验证的假设
                 （不是"我要查日志"，而是"我怀疑 X 导致 Y"——必须可证伪）
  actions      : ToolCall[]        // 自动采集，不需要 agent 复述
  verdict      : { text, confidence }
  evidenceRefs : EvidenceRef[]                                    ← ①
  status       : open | confirmed | refuted | inconclusive | superseded  ← ②
  supersededBy : stepId
  t_start, t_end, tokens, cost
}
```

**① `evidenceRefs` 是「可溯源」的真正落点。**
结论光挂在节点上不叫溯源。agent 下结论时必须指明依据的具体位置，UI 上点结论就高亮原始输出的对应片段。没有这个字段，Timeline 只是把 agent 的话分了段，仍然无法验证它有没有编。

**② 结论必须可被推翻。**
真实排查里第 3 步的判断经常被第 7 步否掉。纯 append-only 的 Timeline 会呈现一条"一路顺利推导到真相"的假历史，而排查的价值恰恰在那些走错又折回的地方。UI 上第 3 个节点划掉并画一条回指箭头到第 7 个。

这也是工具能沉淀经验的地方——回看会发现自己/agent 反复在同一类岔路上错。

### 4.3 EvidenceRef（双时间戳）

```
EvidenceRef {
  toolCallId
  lineRange | jsonPath   // 溯源锚点：具体到第几行 / 哪个字段
  observedAt             // 我什么时候查到的    → 排查时间线
  occurredAt?            // 它描述的事件何时发生 → 事故时间线
  actor?                 // 谁 / 哪个组件干的
  claim                  // 这条证据说明了什么（一句话）
}
```

> **`occurredAt` 是本设计里最不能省的字段。**
> 有了它，事故时间线就是一次 `ORDER BY occurredAt` 的投影，**不需要 agent 再写一遍**；没有它，只能让 agent 在结尾凭记忆重述——那就回到了 §1.2 的有损压缩，而且是在最重要的产物上有损。

降低成本：日志类工具输出本来就带时间戳，harness 从日志服务 / Sentry 的返回结构里**自动抽取** `occurredAt`，只有人工粘贴的结果需要手填。

### 4.4 节点边界的产生方式

**骨架显式声明 + 内容自动填充：**

- agent 只负责标 `open_step` / `close_step` 两个语义边界
- **中间发生的所有 tool call 由 harness 自动归属到当前 open 的 step 上**，agent 完全不用复述输出
- `--include-hook-events` + PreToolUse hook 兜底：没有 open step 时的工具调用自动进"未归类"节点，不丢事件

agent 的增量负担 ≈ 两次极短的 tool call，遵从性高；拿到的是完整结构。

可用 hook 事件（节选）：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` / `SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `PermissionRequest` / `PermissionDenied` / `Stop` / `PreCompact` / `PostCompact`。

`PreToolUseHookInput` 带 `agent_id`（仅在子 agent 内触发时出现）和 `agent_type`——用它区分主线与子 agent 调用。

### 4.5 子 agent 呈现

- `--forward-subagent-text` 把子 agent 的文本/thinking 带 `parent_tool_use_id` 转发；Task 的 tool_use id 就是天然的 lane key
- Timeline 做成**泳道**：主干一条线，并发时 fan-out 成平行支线，各自收敛回主干节点
- SDK 有选项开启**子 agent 周期性进度摘要**（约 30s fork 一次子会话生成一句话摘要，前后台都适用，官方说明成本很低）——泳道上"这条支线正在干嘛"不用自己实现
- 子 agent transcript 落盘：`~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`；SDK 提供 `getSubagentMessages` / `listSubagents`

### 4.6 持久化

- 事件全部落 **SQLite**，一行一 event，UI 从库**投影**出 Timeline（event sourcing）
- **不做内存态 + 事后 dump。** 反正要把事件解析一遍，增量成本接近零
- 白送三样：崩溃/断连恢复现场、多窗口看同一 session、导出排查报告
- 开 **FTS5** 全文索引 → 跨 case 检索证据（"上次那个从库延迟怎么定位的"、"这个错误码以前出现过吗"）。建表时多一行

---

## 5. 人工回填通道（`ask_operator`）

排查中有些查询需要人工执行（特定数据库、Redis）：agent 给语句，人执行并回填结果。

**实现：** 用 SDK 的 `createSdkMcpServer` 建**进程内 MCP server**，不起子进程，handler 与 app 共享内存。

```
ask_operator({
  engine:    'mysql' | 'redis' | 'mongo' | ...
  statement: string   // agent 给出的查询语句
  why:       string   // 为什么需要这条 —— 直接成为节点的 direction
  expect:    string   // 预期看到什么 —— 见下
})
```

handler 返回 Promise，UI 上出现一个 **pending 节点**，粘贴结果回来才 resolve。语义与其它工具调用完全同构，自动进 Timeline、自动成为 evidence。

### 5.1 设计要点

**① 语句必须可编辑再执行。**
agent 写的 SQL 表名字段名多半是猜的。改完之后**把改后的语句一起回传给 agent**——它就学到了真实 schema，后面几条不用再改。别只回传结果。

**② 粘贴框旁边要有 engine / env / 执行时间。**
这条证据要参与事故时间线重建，没有 `occurredAt` 就是孤儿。手工结果是唯一拿不到自动时间戳的来源。

**③ 批量问，别一条一条阻塞。**
提示词要求 agent 把需要人工执行的查询**攒成一组再发**（"我需要你跑这 3 条"），否则会在切窗口上耗掉一半时间。

**④ pending 期间 turn 的两种走法（都要支持）：**
- 还有并行支线 → agent 转去推进别的
- 没有并行支线 → 让这个 turn 收尾，回填后作为新一轮继续

**⑤ 重连要能 re-arm。**
SDK 要求客户端重连时 re-arm 尚未响应的 pending 请求（`initialize` 响应带 `pending_permission_requests` 及待响应 dialog 列表，且同一 `request_id` 可能同时以 live/replay 两种帧到达，**必须去重、只渲染一次**）。UI 刷新后要能恢复挂起节点。

### 5.2 定性：这是权限边界，不是妥协

> 生产库、敏感用户数据、任何写操作——**永远不给 agent 直连，全部走这条人肉通道**，是有意的设计。
> agent 负责想清楚要查什么、为什么查、**预期看到什么**；人负责执行和把关。

`expect` 字段的作用：**逼 agent 先说预期再看结果**，挡住事后合理化（看到数据再倒推一个说法）。这是这套设计里少数几个直接提升结论质量的机制，也是敢把工具用在生产排查上的前提。

---

## 6. 最终报告

### 6.1 报告是投影，不是重写

每一块都有确定的数据来源：

| 报告章节 | 来源 |
|---|---|
| 事故时间线 | `evidenceRefs ORDER BY occurredAt` 自动投影 |
| 根因 | 最终 `status=confirmed` 的 step 的 verdict |
| 排查路径（含走错的） | step 树，含 `superseded` 分支 |
| 影响面 | 一个专门的量化 step（见 §6.2） |
| 修复建议 | **agent 唯一需要真正"生成"的部分** |
| 遗留疑点 | `status=inconclusive` 的 step 自动汇总 |

agent 只写最后两栏，其余是投影 + 一次润色。报告与过程天然一致，改不了也编不了。

### 6.1.1 时间线只是五种结论形态之一

**事故时间线是报告主体（§1.4），但不是每个案子都有。** 配置写错、索引缺失、证书过期这类故障没有"事发瞬间"——故障状态一直存在直到被发现，硬凑一条时间线只会得到"某天变更、某天发现"两行，还会稀释掉真正重要的对照。

因此报告是**按形态组装的块**：

| `verdict_shape` | 什么时候是它 | 主体块 | 不投影 |
|---|---|---|---|
| `sequence` 时序型 | 顺序 / 竞态错了 | 事故时间线 | 应然实然、归因切分 |
| `state` 状态型 | 某个东西一直就是错的 | **应然 / 实然对照** | 事故时间线 |
| `chain` 因果链型 | 一处变更连锁放大 | 因果链（每环带置信度）+ 最弱一环 | 应然实然 |
| `distribution` 分布型 | 问题只在某一小撮 | 归因切分 + 干净组对照 | 事故时间线 |
| `open` 未决型 | 没查出来 | **排除矩阵 + 遗留疑点** | 根因判定——没有就是没有，不编 |

影响面 / 排查路径 / 遗留疑点 / 修复建议四块在所有形态里都出现。

agent 的增量负担只是**多填一个枚举**，块的组装由 harness 做——D17「报告是投影」因此不动摇。配套 schema 增量：`cases.verdict_shape`，以及状态型需要的 `expected` / `actual` 一对字段。

> **形态为 `state` 时报告应显式写出"为什么没有事故时间线"**，而不是默默省略一节。缺席也写出来比省略可信。

### 6.2 两个固化成流程的约束

**「影响面」是强制 step。** 排查经常找到根因就停了，但事故报告要回答"影响了多少用户、多长时间窗口"，这几乎总需要一次额外的聚合查询。做成结案前的必经节点。

**「遗留疑点」必须出现，哪怕是空的。** 现实里排查很少 100% 收敛，把没查清的部分明写出来，比一篇看起来严丝合缝的报告可信得多。

### 6.3 两种导出并列一等

同一份章节组装逻辑，两个渲染目标。详见 [ui](ui.md) §7。

- **Markdown** —— 给会被继续编辑、被搜索、被贴进 PR 的场合。根因用引用块置顶；时间线用**表格**而非 mermaid（mermaid 在不少 wiki 与评论区不渲染，不渲染就是一团噪音），mermaid 放进末尾 `<details>` 作为附加；证据用脚注，正文保持可读
- **长图** —— 给一贴进群里就要被看懂的场合。固定 1240 CSS px @2x，配色与报告页一致且不跟随系统主题（所见即所得，且同一个 case 在谁的机器上导出都是同一张图）

> **长图这条反过来定义了报告页的信息架构：凡是要点击才能看到的内容，截图里就不存在。**
> 所以报告页不能有 tab、折叠面板、内部滚动区——所有块必须平铺在一条纵向流里，顶部只能是"点击滚动"的锚点导航。这是 D22 的由来。

---

## 7. 决策清单

| # | 决策 | 理由 |
|---|---|---|
| D1 | 工具形态 = **实时交互**，边排查边看、能及时打断 | 核心诉求 |
| D2 | **Timeline 为主**，对话降级成输入带 | 看清每步 + 及时介入全发生在节点上。**待体验验证** |
| D3 | 架构 = **壳 + spawn `claude` CLI**（或 Agent SDK） | 唯一能合规使用订阅额度的路径 |
| D4 | 禁用 `--bare` | 它强制走 API key |
| D5 | 节点边界 = `open_step`/`close_step` 定骨架 + 工具调用自动归属 | agent 负担最小，结构最完整 |
| D6 | "换方向"用 `canUseTool` **deny + message** | 保留 turn 上下文，避免重建成本 |
| D7 | Stop 按钮传 `cancel_queued: true` | 否则停不干净 |
| D8 | 权限**分层放行** + 一键接管（`setPermissionMode`） | 全拦太累，全放来不及 |
| D9 | `canUseTool` / `ask_operator` 必须有**超时兜底** | 否则 agent 干挂 |
| D10 | 数据模型分四层：**Case > Session > Step > ToolCall/Evidence** | 一次事故跨多会话；检索维度是事故 |
| D11 | `EvidenceRef` 带**双时间戳** `observedAt` / `occurredAt` | 事故时间线的唯一来源 |
| D12 | Step 状态支持 `superseded` + `supersededBy` | 真实排查会推翻结论；append-only 会造假历史 |
| D13 | 事件落 **SQLite（event sourcing）+ FTS5** | 恢复/多窗口/导出/跨 case 检索，成本近零 |
| D14 | 人工查询用 `createSdkMcpServer` 自建 `ask_operator` | 进程内、UI 完全可控 |
| D15 | `ask_operator` 带 `expect` 字段 | 逼 agent 先说预期，挡事后合理化 |
| D16 | 生产库 / 敏感数据 / 写操作**一律走人肉通道** | 权限边界，是工具可用于生产的前提 |
| D17 | 报告 = **投影 + 少量生成** | 避免二次有损压缩 |
| D18 | agent **知道**自己在被记录 | `open_step` 本身是显式的，无法隐藏 |
| D19 | agent backend **分三段抽象**：工具契约（MCP，天然跨端）/ 会话与事件流（接口）/ 控制语义（**能力协商，不是接口方法**） | 目标是 Claude + codex 两种 backend；核心结构全经 MCP 产生，抽象面比想象窄，落差全集中在控制语义。详见 [agent-backends](agent-backends.md) |
| D20 | 第一阶段**只实现 Claude backend，且不写 mock backend** | 空实现验证不了抽象；只守四条"事后补代价极高"的纪律（backend 是 schema 一等字段 / renderer 零 backend 类型 / MCP handler 传输无关 / 事件命名无 backend 词汇） |
| D21 | 调查台与报告是**两个屏**，不是同屏两个 tab；但**共用同一套色板**，差别只来自密度与字号 | 人在两个屏前做的事不同（一个求及时介入，一个求讲清楚），所以分屏；但一深一浅会被读成两个应用，而它们是同一个工具的两个阶段。详见 [ui](ui.md) §1 |
| D22 | 报告页是**单列长页**，无 tab / 折叠 / 内部滚动 | 由长图导出倒逼——点击才能看到的内容在截图里不存在。顶部只放锚点导航（§6.3） |
| D23 | 调查台轨道：**主干纵向单调追加、永不重排，分叉只向右生长** | 实时界面里任何"排漂亮"的布局算法都会让已读节点位移，这是唯一不可接受的失败。详见 [ui](ui.md) §3 |
| D24 | 需要人动手的事按**"不处理会怎样"分三级**，暖色为其全局专属 | 不按工具类型分——类型不决定紧迫性。①档无超时兜底（自动填假结果比等着更糟），②档有。详见 [ui](ui.md) §4 |
| D25 | 报告 = **按 `verdict_shape` 组装的块**，时间线只是其中一种主体 | 状态型故障没有"事发瞬间"，硬凑时间线会稀释真正的对照（§6.1.1）。agent 只多填一个枚举，投影原则不变 |
| D26 | **Markdown 与长图并列一等**，共用同一份章节组装逻辑 | 两种分享场景都真实存在；只是渲染目标不同，不该做成两套内容（§6.3） |
| D27 | 立案时必须收 **项目起点 + 事故基准日与时区**（落 `cases`）以及 **backend / model / effort**（落 `sessions`）| 项目起点决定 agent 继承哪套 skill/MCP（§2）；基准日与时区决定 `occurred_at_ms` 能不能落成绝对时刻——没有它事故时间线就是空的。agent 三项放 session 层是因为一个案子跨多会话、中途换模型是常态，报告里要标出每一步是谁跑的。详见 [ui](ui.md) §8.1 |
| D28 | 「等你处理」的计数**跨 case 全局汇总** | 并发排查时你在 A 案上工作，B 案卡在 `ask_operator` 上等你；只在当前 case 显示会让那条支线静静挂死。详见 [ui](ui.md) §8.3 |
| D29 | 收尾分**停止 / 结案 / 归档**三档，`aborted` 案子仍可导出**残报告**（形态强制 `open`） | 与 §3「三档粒度不要混成一个 Stop 键」同源。终止不销毁证据，只把 pending 改判 `abandoned` 并给 Case 打状态。详见 [ui](ui.md) §8.4 |

---

## 8. 待验证与风险

### 8.1 待验证

- **D2（Timeline 为主）初步成立**，v0.1 实跑下来主区看的确实是节点，对话压到底部一条带不缺信息。长期使用仍需验证
  - 缓解：**布局可以换，数据模型换不了**。换前端布局成本几天，模型缺字段成本是历史数据全废
- **D23 的规模上限**：主干 + 分叉在约 40 节点后需要折叠，折叠规则要等真实案子才能定
- **`verdict_shape` 由谁判定**：倾向 agent 结案时选，但若它总选 `sequence` 图省事，就要改成由 harness 按"带 `occurredAt` 的证据是否成链"推断
- 子 agent 进度摘要的实际成本与摘要质量
- `occurredAt` 自动抽取的覆盖率（各日志源的返回结构差异很大）

### 8.2 已知风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| ~~agent 填 `direction` 敷衍~~ | **已证伪**（2026-08-10 实跑）：direction 全部是可证伪命题，agent 还主动写出证伪条件，并敢把结论填 `refuted`。风险等级下调，见 [tools](tools.md) §4 | — |
| **`occurredAt` 的强制规则设计错** | 取代上一条成为头号风险：一刀切强制不会让字段变完整，只会让 agent 拿查询执行时间凑数，**假时间直接进报告主体** | 由 harness 按「本次调用是否真的产出带时间戳的记录」判定，不靠提示词自觉（[tools](tools.md) §3） |
| agent 忘记调 `open_step`/`close_step` | prompt 纪律不可靠 | PreToolUse hook 兜底进"未归类"节点 |
| 介入窗口过窄 | 并发工具调用来不及拦 | `open_step` 作为减速带；软确认机制 |
| pending 节点僵尸化 | 重连后 resolve 不了 | 按 SDK 的 re-arm 契约恢复，注意 request_id 去重 |
| 报告里洗掉走错的分支 | 会产出虚假的"一路顺利"叙事 | superseded 分支强制进报告 |
| 打包后 spawn 不到 `claude` | GUI 启动的 app 只有最小 PATH；打包的 Electron 无独立 node 二进制；签名后 entitlements 需允许子进程 | 抄 duetlens 的 `shell-path.ts`；显式指定可执行文件路径。**列为首个 spike，见 §9** |
| 原始输出撑爆库与 IPC | §1.2 要求完整落库，单次日志查询可达 MB 级 | 大 payload 内容寻址落盘、库存 hash + 可索引文本；IPC 只推摘要与 preview。详见 [architecture](architecture.md) |
| codex backend 控制面弱一档 | D6 / 改写参数 / 运行时切档 / 泳道在 codex 侧无等价物 | 设计既定结果而非 bug，按能力协商降级。详见 [agent-backends](agent-backends.md) §4 |

---

## 9. 下一步

0. **spike：Electron main 里跑通 Claude backend**（**排在数据模型之前**）

   理由：数据模型是纯设计工作，随时能做；这个 spike 是**证伪风险**——任何一条不成立，整套设计要改形。分两段：

   - **A（裸 Node / tsx）** —— ✅ **已完成，五条全 PASS，见附录 A.0**
   - **A2（裸 Node）**：子 agent 场景——hook input 的 `agent_id` / `forwardSubagentText` 的 `parent_tool_use_id` / 单条支线转后台（§3.4）。泳道设计依赖这三条
   - **B（Electron main）**：验运行环境——PATH 补齐后能 spawn · 签名后 entitlements · 「已装但未登录」的环境检查

1. **完整数据模型 + SQLite schema** —— ✅ **已完成**，见 [data-model](data-model.md) 与 `src/backend/db/schema.ts`，由 `npm run spike:db` 实跑验证（重放一致性 / 两条时间线错位 / superseded 链 / FTS 中文 / 报告四栏投影）
2. **三个工具的定义 + 配套 skill 提示词** —— ✅ **已完成**，见 [tools](tools.md)。真 agent 端到端跑通（`npm run spike:tools`，7/7）

   结论与预期相反：`close_step` 逼出 `occurredAt` **不是靠提示词**，而是靠 harness 判定"这次调用是否真的产出了带时间戳的记录"。一刀切强制会让 agent 拿查询执行时间凑数，把假时间填进报告主体——tools.md §3 记了这三次收敛。

3. **接线：agent 会话 → hook 自动归属 → events → SQLite → 两条时间线** —— ✅ **已完成**（`npm run spike:wire`，7/7）

   主干第一次连通：真 agent 排查 → 每次工具调用经 hook 自动归属并落 blob → 事件流写库 → **事故时间线从 SQL 里长出来，agent 没有重写过任何一行**，且 17/17 条证据能按校正后的锚点回到原始日志的那一行。

   三个实跑打出来的结论：
   - `PostToolUse` 的 `updatedToolOutput` 能给**任意工具**注入 `[call #N]`，自动归属不限于自建工具（[tools](tools.md) §2）
   - **行号锚点不可信**，必须内容匹配校正 → 新增 `anchor_resolved`（[data-model](data-model.md) §2）
   - **「未归类」兜底节点每轮都会触发**：agent 总是先查一次再 `open_step`。§4.4 的兜底不是保险丝，是常态路径

4. **Electron 壳 + Timeline 控制面** —— ✅ **v0.1 可运行**（`npm start`），见 [ui](ui.md)

   D2「Timeline 为主、对话降级成输入带」初步成立：主区看的确实是节点，对话压到底部一条带也不缺信息。Spike B 的运行环境问题一并解决（PATH 补齐 / ESM preload 需 `sandbox:false` / schema 与提示词不能读源码目录）。

5. **立案面板 + schema v2** —— ✅ **已完成**（D27），见 [ui](ui.md) §8.1

   立案单落 `cases`（项目起点 / 基准日与时区 / 问题 / 已知线索），agent 三项落 `sessions`。实跑结论：

   - **模型列表是问出来的不是写死的**：`query.supportedModels()` 返回真实的 `supportsEffort` 与每个模型可用的 effort 档位（实测 Haiku 一个都没有）。写死一张表就一定会在这里给出假开关。探测要 spawn 一次 CLI，所以带超时并缓存进 `ui_settings`，问不到才退回内置表且 UI 明说是兜底
   - **开发期不做跨版本迁移，直接重建库**：一度写成"DROP 投影表 + 按 events 重放"，老库也确实跑通了——但那只是因为 better-sqlite3 把 `undefined` 绑成 NULL，老事件缺的字段静默落空，看着像成功实则是一批半残的案子。重放只在载荷形状没变过时成立，而破坏性升级改的就是形状（[data-model](data-model.md) §2）
   - **能少一个能填错的空就少一个**：时区改成取本机偏移落库，不让用户填。手填 `±HH:MM` 填错的后果是全部无时区证据整体平移几小时且毫无报错，而它几乎总是同一个值。取的是**事故那天**的偏移不是此刻的——夏令时地区冬夏差一小时。代价是假设「日志时区 = 立案机器时区」，已写进 [ui](ui.md) §8.1 与欠缺清单
   - **立案与开会话是两个时刻**：合在一起会让"打开 app 看一眼"每次都留下一条空会话。case 在点「立案」时就落库，session 等到真的跑第一轮
   - **项目起点决定挂哪套工具与哪套上下文**：填了就是真项目（`cwd` 指过去，`settingSources` 含 `project` 才读得到它的 `CLAUDE.md`，只给只读三件套），不填就是演示事故（隔离模式 + 玩具数据源）。这条区分让"项目起点"这个字段不只是记录

6. **待办栏两个控制手势 + 放开工具面** —— ✅ **已完成**，见 [ui](ui.md) §8.1 / §8.2，由 `npm run spike:gate` 兜底

   ②档闸门（改写参数再放行 / deny + message 换方向）接上，真项目模式的工具面收成三档：直接放行 / 过闸门 / 一律不给。实跑结论：

   - **闸门的入口是 `PreToolUse` 不是 `canUseTool`**：后者只在 backend 自己决定要问时才到，只读工具按默认模式直接放行，白名单压根没参与
   - **三种"没跑成"是三件事，不能合并**：`denied` = 有人看过并说了不行 · `failed` = 工具自己坏了 · `abandoned` = 人按了停止，连"该不该跑"都没问到。四轮评审里有三轮栽在把它们混起来
   - **被拒的调用不会有 `PostToolUse`**，不在拒绝那一刻补收尾就永远挂在 `pending` 上
   - **判决落在哪条事件上取决于到达顺序**，所以别去数 `toolcall.gated` 的条数，要验就验重放后判决是否逐字一致

7. **案件切换栏 + 全局待办汇总** —— ✅ **已完成**（D28），见 [ui](ui.md) §8.3，由 `npm run spike:cases` 兜底

   main 改成同时持有多个案子的运行时（`src/main/case-registry.ts`），切换只换投影不中断任何一个。实跑结论：

   - **两条时间线都得按 case 取，不能按 session 取**：一个案子跨多会话，按 session 取时重开旧案主区是空的，看起来像数据丢了而不像查错了表。代价是 `ordinal` 每个会话都从 1 重来，轨道上要标出会话断点
   - **重开是新起一个 session**，两条路都得换：换运行时的（重启 app / 被限流降级过）和同一个运行时接着跑的（会话自己跑完再点「接着查」）。后者最容易漏——不换 sessionId 的话，新步骤会落进库里那个已标 `ended` 的会话
   - **降级绝不能挑挂着待办的那个**：它会把等着人回答的 pending 就地作废，等于替人做了「这条不查了」的决定。挑不出人选就让它超一个——拒绝新建、或杀掉一条正等着人的支线，都比多开一个进程糟
   - 顺带：`cases.updated_at` 立案之后没有别的地方会动它，得由投影器按事件自己的 `at` 前移，否则切换栏的"最近活动"永远是立案先后

8. **三种收尾** —— ✅ **已完成**（D29），见 [ui](ui.md) §8.4，由 `npm run spike:close` 兜底

   停止 / 结案 / 归档三个动作接上，`cases.status` 有了写入方。schema 没动。实跑结论：

   - **状态变更走 `case.status_changed` 事件**，不直接 `UPDATE cases`：重放时 `case.opened` 会把 status 写回 `open`，直接改的库值一重建投影就没了，且毫无报错。这条是本 spike 的地基，其余几条的验证都压在它上面
   - **回填与它的调用原先没有连线**：账上的键是 backend 的 `toolUseID`，回填卡上的是自己发的 `ask_*`。连线**按语句认领**而不是按先后——子 agent 可以同时问出好几条，按先后认会把甲的放弃记到乙头上。认领前先把已经不在 `pending` 上的清掉，被规则拦下、压根没跑起来的调用才不会被兜底那一手认走
   - **散场之后 PostToolUse 还会来一趟**：散场靠的正是"给工具那侧一个结果"，那次调用随后照样走完 PostToolUse。不挡这一下，刚记下的 `abandoned` 会被改写成 `done`，轨道上多出一次从没有人回答过的"跑完了"。与被拒那条同源（§9.6），只是这次的来源是收尾而不是闸门
   - **启动清扫必须赶在任何 runner 建起来之前**：那一刻库里所有 `pending` 的调用与所有 `live` 的会话都必然是上一个进程留下的。建完 runner 再扫会把这一轮自己的活计一起判成放弃。清扫同样走事件

   另：结案挡在两个强制 step 之前（§6.2），且**只认已收尾的**——拿一个还开着的 impact step 放行，等于让报告的影响面栏空着结案。缺步时不是报个错就完，而是把这两步派给 agent 去补；就此收手走的是归档，那一档明写着放弃。

9. **写入 `verdict_shape` 与 `expected` / `actual`** —— ✅ **已完成**（D25），见 [ui](ui.md) §8.4.2 与 [data-model](data-model.md)，由 `npm run spike:close` 兜底

   报告形态有了唯一的写入方：结案确认条上的五选一。schema 升到 v3（`steps.shape`），新增事件 `case.verdict_decided`。实跑结论：

   - **形态得挂在 step 上再投影到 case，不能让 agent 直接写 case。** 它是"这个结论属于哪一类故障"，而结论会被推翻——写进 `cases` 的话它不会跟着失效，报告就按一份已经作废的判断装块。这与 `expected` / `actual` 挂 step 是同一条理由
   - **取哪一步的声明，必须与报告取根因是同一条规则。** 第一版写成了"全案最新那条带声明的"，于是一条误填了 `shape` 的 impact step 就能决定报告装哪几块，而根因与应然实然仍来自根因那一步——结构与内容自相矛盾且毫无报错。这与影响面共用 `effectiveStep`（§9.8）是同一条纪律，我在同一个功能里又踩了一次
   - **没人声明时的推断值，准绳是"宁可少装一块，也不装一块空的"。** 一度想不出声明就一律 `open`——那会把一条真实结论从报告里抹掉。反过来默认 `sequence` 则是装一块空的。落点是 `chain`：它的主体（每环带置信度的因果链）能从 step 树直接投影，任何案子都装得出来
   - **「冻住 vs 实时」不是二选一，要按它说的是不是同一条根因认。** 确认条冻的是弹出那一刻的建议，而快照 60ms 一轮。一律信冻住的，agent 补上应然/实然之后警告永不消失；一律信实时的，根因换了人时会拿新根因的形态配旧根因的判定——预选 `state` 却一句"这一块会是空的"都没有，人当场确认就冻出一份空主体报告。我第一轮判断成"误报方向只是多说一句"，漏的正是根因整个换掉这一种
   - **这一个枚举该由人按下去，不该做成第三种缺口。** 做成缺口的话，agent 得为了补一个枚举再开一步——而它此前每一步都已经收好了。放进确认条则一步不多：预选值备着，人不动手也能一路按到底，而"确认结案"本就是唯一看得见后果的那一下
   - **可选字段的"没填"是"不动"，不是"清空"。** 同一步会被 close 第二次——我们自己的 warning 就写着"请补 evidence 后重新 close"，而那一次多半只带 evidence。投影一律 `?? null` 的话，第一次填好的形态与应然实然被静默抹掉，报告主体随之空掉，重放还会一模一样地复现。三项改走 `COALESCE`，与 `toolcall.gated` 的 `input_json` 同一个语义。**凡是给事件加可选字段，都要先问一句"这个事件会不会来第二次"**
   - **加了 patch 语义，"按入参判断"就整体失效了。** 三项改成"缺省=不动"之后，警告仍按本次入参判——只补 evidence 那次看不见库里已有的 `state`，只补一半那次又被当成"只给了一半"。改动一个字段的**写入语义**，就要回头看所有读它的判断是不是还按旧语义写的
   - **填了不生效的必须当场说，"静默忽略"不算修好。** 上一条修完，误填的声明从"被错误采纳"变成"被静默忽略"——两者都让 agent 以为形态已经交代过了。所以不生效的五种情形（非 `confirmed` / 非 `normal` / 当前不是根因 / 状态型缺应然实然 / 那一对只给一半）一律由 `close_step` 回警告，其中"当前不是根因"只有落库之后才判得出来，警告因此在事件发出之后才算

10. **轨道改成主干 + 分叉** —— ✅ **已完成**（D23），见 [ui](ui.md) §3.1，由 `npm run spike:track` 兜底

    平铺卡片流改成缩进轨道：`parent_step_id` 一路接到快照（库里早有这一列，此前没有读它的人），
    布局提成纯函数 `trackLayout()`，推翻关系有了全屏唯一的那条回指曲线。schema 没动。实跑结论：

    - **"永不重排"落到代码上就是"深度只从已经出现过的父算"。** 换成在整份列表里找父，
      一个"父在后面才到"的分叉就会在父到达那一刻让早先那一行的缩进跳一格。这一手顺带兜掉了
      父不存在与父指向自己，也让它天然不会成环——防环代码一行都不用写
    - **绝对定位的 y 是个陷阱。** §3 原本写的是"定宽画布内的绝对定位"，但 y 要先量高度，
      而卡片一展开工具调用高度就变。x 算、y 交给文档流，不重排的保证照旧（顺序不动、只在末尾追加），
      还省掉了两趟测量。定死的是那条约束，不是实现方式
    - **分叉不画连接线，只缩进 + 标「↳ 接 #N」。** 父与子之间往往隔着几步主干，
      从父拉下来的线会横穿那几张卡。这也正好保住了"全屏只有一种曲线"
    - **推翻者不在这条轨道上时，曲线没有但划线要在。** "查不到就跳过"在这里的后果是
      把一个已经作废的结论显示成仍然成立的（§9.7 同一个形状，这次是渲染侧）
    - **纯函数那一半能验，量出来那一半得进真 app 驱动。** 用临时探针撑高中间一张卡，
      确认曲线两头跟着位移走（+208px 分毫不差），验完删干净
    - **"永不重排"不只管位置，也管"回头改写已经渲染出去的行"。** 第一版让序号在多会话时
      改带 `S1#` 前缀、又给第一段也标了会话断点：前者把每一行都重写一遍，后者更是要在轨道顶上
      插进一个块，把每一张已读的卡整体下推——比改文本实在得多的位移。现在序号恒为 `#N`，
      会话号只出现在跨会话的引用里（带不带只取决于两端自己），断点只标在真正换会话那一行
    - **契约要写在兑现得了它的那一层。** 渲染侧写着"认不得的父就当主干"，可
      `steps.parent_step_id` 上有开着的外键——原样落库换来的是 `FOREIGN KEY constraint failed`
      加事务回滚，这一步压根开不出来。改成 `open_step` 发事件前按**本案子**核一遍
      （只核"这个 id 存在吗"不够：别的案子的 step 过得了外键，却不在这条轨道上），
      认不得就归一成主干**并回一条 warning**——静默丢掉会让 agent 以为分叉已经记下了（§9.9 同一条）

    另：布局的回归网写完全绿，退回三种错写法逐一确认 FAIL——其中"追加不动已有行"那条一开始是**空的**，
    因为夹具里压根没有"父在后面才到"的行，错写法在每个前缀里算出来的都一样。补进夹具才真的兜住。

    更该记的是另一种空：上面"每一段开头都标断点，含第一段"这条规则，我不但写了检查，
    还退回旧写法确认过它会 FAIL——**检查是实的，被它锁死的判断是错的**。
    退回验 FAIL 只证明检查非空，不证明它验的是对的事。

11. **报告拆成独立屏，单列长页** —— ✅ **已完成**（D21 / D22 / D25），见 [ui](ui.md) §6，由 `npm run spike:report` 兜底

    章节的组装提成了纯函数 `src/shared/report.ts`（`reportPlan()`），报告屏与两种导出共用同一份——换的只是渲染目标。schema 没动。实跑结论：

    - **这一带的错法只有一个形状：「有数据就装」。** 它一条都不会报错，装出来的报告看着还更完整。归档强制未决型，而被归档的案子多半已经查出了点什么——按"有就装"写的话，明写着"没查出来"的残报告会顶着一条根因。同族的还有：时序型把应然/实然一并印上、分布型顺手补一条时间线。所以形态表里那一列**「不投影」与「主体块」同样是规则**，夹具因此要把该字段都填满，否则"不装"的检查全是空的
    - **同一节会被两处要到，得去重。** 遗留疑点在未决型里是主体块，又在通用四块里；不去重就印两遍，去重时留错那一份则会把主体挪到末尾。锚点导航按 id 滚动，重复 id 还会让导航跳到第一份而正文在第二份
    - **报告屏不许自己再挑一次根因。** 选择器只有 `reportSections()` 那一条，`rootCause` 连 `stepId` 一起进快照。再挑一次的后果是链条标的根因与根因栏印的结论指着两步，且毫无报错——与 §9.9「取哪一步的声明必须与报告取根因同一条规则」同源，只是这次跨了进程边界
    - **静默跳过的分支要出声。** 无人值守截图那条探针原本点的是"事故时间线"那个 tab，而 tab 已经没有了；`?.click()` 会安安静静什么都不做，拍出来的是调查台，文件名和日志却说这是报告。改成点不到就抛——一张认错了的截图比没有更糟
    - **两条时间线不再是顶栏的两个 tab**：排查线留在调查台，事故线随报告走（[ui](ui.md) §1 早就这么写了，只是一直没落地）。收尾落地后直接翻到报告屏——报告装成什么样正是刚才那一下决定的
    - 🔴 **别用吃帧循环的东西做落点或度量**（评审后补）。锚点跳转一度用 `scrollIntoView({behavior:'smooth'})`、让开 sticky 导航一度用 `ResizeObserver` 预先同步高度——**两者在未获焦点的窗口里一次都不跑**，前者点了纹丝不动、后者留下一个悄悄过期的偏移量，都不报错。这与 §11 的过期帧、长图导出必须等 `fonts.ready` 是同一条：**这个 app 的验证环境天然是不获焦点的**，凡是依赖帧的东西在那儿都验不出来。现在全走同步布局读数
    - **跨会话的编号必须带会话号**（评审后补）。`ordinal` 是会话内序号，重开一次从 1 重来——报告里会出现两个 `#1`，而「← 被 X 推翻」这类引用无处可对。调查台那条"序号恒为 `#N`"（§9.10）防的是实时图里已读节点位移，报告是冻住的文档，不受它约束——**同一个字段在两个屏上的正确做法是相反的**
    - **上一轮我写的一条检查把错误判断锁死了**（评审后补）：因果链断言写成 `st1,st4,st5`，正好把"链条越过根因继续走"钉成了预期。退回旧写法验它会 FAIL 只证明检查非空，不证明它验的是对的事——同 §9.10 那条，这已经是第二次

12. **接下来**，按依赖排序：

    1. **两种导出**（D26）。Markdown 先做（纯字符串拼装，可单测，直接吃 `reportPlan()` 的输出）；长图后做（要处理离屏窗口与字体就绪，见 [ui](ui.md) §7.2）。**归档的残报告在这一步才真的能导**——收尾只保证了证据没被销毁，报告屏也只是让它看得见
    2. **Spike A2（子 agent 泳道）**。分叉的真实数据来源还没验过——`agent_id` 与 `parent_tool_use_id` 是否够用，决定轨道里的支线怎么归属。轨道这一侧已经备好：`lane` 那一列还没有读它的人

---

## 附录 A：实测能力速查

2026-08-10 在 Claude Code CLI `2.1.220` / `@anthropic-ai/claude-agent-sdk` `0.3.226` 上验证。

### A.0 Spike A 结论（`npm run spike:claude`，SDK `0.3.220`）

**五条全部 PASS，D3 / D6 / D14 坐实。**

| # | 断言 | 结果 |
|---|---|---|
| 1 | 无 `ANTHROPIC_API_KEY` 跑通（走订阅，D3） | ✅ |
| 2 | `allow + updatedInput` 真能改写参数 | ✅ handler 实收改写后的值，非原值 |
| 3 | **`deny + message` 不中断 turn，agent 就地换方向重调（D6）** | ✅ 闸门序列 `deny+message(AAA) → allow+updatedInput(BBB)`，同一 turn 内完成，最终正常收尾 |
| 4 | 进程内 SDK MCP 工具被调到（`ask_operator` 载体，D14） | ✅ |
| 5 | `PreToolUse` hook 可观测 | ✅ 主线 3 次 |

**两条须留意的观测：**

- **主线调用的 hook input 里没有 `agent_id`**（与 §4.4 "仅在子 agent 内出现"一致）。但**子 agent 侧尚未验证**——泳道归属（§4.5）依赖它，列为 Spike A2
- **`settingSources: []` 不隔离用户环境**：仍加载 48 条 slash command 与用户全部 MCP（观测到 4 个 claude.ai connector，含 `needs-auth` / `pending` 状态）。**§2 "白送用户已有 skill 和 MCP"成立**，但反面是排查无关的工具会一起进来，且工具集变大后模型会先走一跳 `ToolSearch`——正式实现需用 `allowedTools` / `disallowedTools` 收窄

**CLI flags**

| flag | 用途 |
|---|---|
| `--input-format stream-json` | 实时流式输入（需配 `-p`） |
| `--output-format stream-json` | 实时流式输出 |
| `--include-partial-messages` | 增量 chunk，打字机效果 |
| `--forward-subagent-text` | 转发子 agent 文本/thinking，带 `parent_tool_use_id`；false 时只发心跳计数 |
| `--include-hook-events` | hook 生命周期事件进流 |
| `--replay-user-messages` | 回显 stdin 的 user message 用于 ack |
| `--session-id <uuid>` | 指定 session id |
| `--resume` / `--fork-session` | 续接 / 分叉 |
| `--json-schema` | 结构化输出校验 |
| `--max-budget-usd` | 花费上限 |
| `--permission-mode` | `acceptEdits`/`auto`/`bypassPermissions`/`manual`/`dontAsk`/`plan` |
| `--agents <json>` | 内联定义自定义子 agent |
| `--bare` | ⛔ 强制 API key，禁用（D4） |

**SDK 关键 API**

| API | 用途 |
|---|---|
| `canUseTool` | 单次工具调用闸门，支持 allow / 改写 / deny+message |
| `interrupt()` | turn 级中断，返回 receipt，支持 `cancel_queued` |
| `setPermissionMode(mode)` | 运行时切换权限模式 |
| `createSdkMcpServer()` | 进程内 MCP server（`ask_operator` 的载体） |
| `forkSession()` | 从某点分叉出新 session |
| `getSubagentMessages()` / `listSubagents()` | 读子 agent transcript |

**能力探测**
`system/init` 的 `capabilities` 是开放集合，需 feature-detect 而非版本嗅探。2026-08-10 spike 实测（CLI 2.1.220 与 2.1.226 一致）：`interrupt_receipt_v1`、`interrupt_cancel_queued_v1`、`msg_lifecycle_v1`。
