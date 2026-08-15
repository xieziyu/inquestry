# 架构

> 返回 [总设计纪要](overview.md)
>
> agent backend 的抽象形态见 [agent-backends](agent-backends.md)，本文不重复。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | **Electron**（自带 Chromium，渲染与 Chrome 一致）；目标平台先做 macOS |
| 后端 | **Node / TypeScript**，写在 Electron main 进程，不引入独立后端进程 |
| 调查 agent | **`@anthropic-ai/claude-agent-sdk`**（spawn 本机 `claude`，继承 OAuth 走订阅） |
| 工具回传通道 | main 进程内 **SDK MCP server**（`createSdkMcpServer`），承载 `open_step` / `close_step` / `ask_operator` |
| 持久化 | 本地 **sqlite**（`better-sqlite3`，WAL + FK + **FTS5**）+ 内容寻址 blob 落盘 |
| 前端 | React SPA，承载于 Electron renderer |

与 duetlens 同构，可直接复用其 `electron-vite` 配置、`src/backend` `src/renderer` `src/shared` 分层、entitlements 与打包脚本。

## 为什么是 Electron —— 约束链，不是偏好

duetlens 选 Electron 的理由是渲染一致性 + 主进程即 Node。这里有一条更硬的约束把它顶死：

**overview §3 的整套控制语义（`canUseTool` 改写 / deny+message、`setPermissionMode`、`interrupt(cancel_queued)`）和 §5 的 `createSdkMcpServer`，全部是 SDK 控制协议的能力，不是 CLI flag。** 裸 spawn `claude` 只拿得到 stdout 事件流，要自己实现 control_request 双向协议——等于重写 SDK。由此：

1. 必须有**常驻 Node 进程**持有 SDK 的 `query()` 句柄 → Electron main 天然就是
2. `ask_operator` 的 handler 要返回一个**由 UI 操作 resolve 的 Promise**（overview §5）→ 必须与窗口同进程共享内存。这里比 duetlens 还省一层：codex 是外部进程只能走 HTTP MCP，SDK MCP 就是函数调用
3. `better-sqlite3` 的同步 API 在 main 里写 event sourcing 很顺

**代价**沿用 duetlens 的判断：体积（~100MB 级）与内存显著高于 Tauri，且须按 Electron 安全基线配置（`contextIsolation` 开、`nodeIntegration` 关、preload + `contextBridge`）。

### 可执行文件：用用户已装的那份

SDK 不打包 cli.js，而是通过 platform 专属 optionalDependency 拉一份**原生二进制**（~257MB）。所以"打包后的 Electron 没有独立 node"这条风险不成立——SDK spawn 的是原生二进制，与 node 无关。但换来一个选择：

| 方案 | 体积 | 版本 | 风险 |
| --- | --- | --- | --- |
| 用 SDK 自带二进制 | app 体积 **+257MB**（Electron 本体才 ~100MB 级） | 与 SDK 锁死，可复现 | 体积劝退；升级即再下一份 |
| `pathToClaudeCodeExecutable` 指向用户已装的 `claude` | +0 | 随用户漂移 | 需环境检查 + 版本下限校验；未装则引导安装 |

**取后者**：本工具的用户就是已经在用 Claude Code 调查问题的人（overview §1.1），"已装"是合理前提；配合环境检查屏（缺件时给绝对路径输入框）成本很低。两条路径都能起进程、都能握手。

### 剩余的环境风险

本机形态：`~/.local/bin/claude` → `~/.local/share/claude/versions/<ver>`，Mach-O arm64。

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| PATH | Finder/Dock 启动的 app 只有 `/usr/bin:/bin:/usr/sbin:/sbin` | 抄 duetlens `src/backend/env/shell-path.ts`，其 `fallbackDirs()` 已含 `~/.local/bin` |
| 签名 | 打包签名后 entitlements 需允许 spawn 子进程 | duetlens 已有 entitlements plist 经验 |
| **OAuth 过期** | 凭据在 Keychain；过期时子进程直接返回 `401 OAuth access token has expired`，**且无法在 app 内重新登录**（长效令牌那条路走不通，见 overview §2） | 环境检查须覆盖"已装但未登录/已过期"，并明确引导用户去终端跑 `claude` 登录 |

## 后端分层

- **`InvestigationSession`（会话层）**：持有 SDK 句柄，管生命周期，把 SDK 事件归一成领域事件。接口面与能力协商见 [agent-backends](agent-backends.md) §2.2 / §2.3
- **工具层**：`open_step` / `close_step` / `ask_operator` 的 schema + handler，**传输无关的纯函数**，由 adapter 挂到 MCP server 上
- **PendingRequests registry**：见下节，架构必需件
- **投影层**：从事件流写物化表，供 UI 与报告查询
- **持久化层**：sqlite + blob store

### 活跃会话并发上限

一个活跃 case = 一个常驻 `claude` 子进程 + 一个 MCP server，故设上限并按 LRU 逐出。duetlens 的血泪结论**原样适用**，不重新推导：

- **只逐出空闲会话**，忙碌一律避让——拆掉正在跑的会话等于替用户打断一轮调查
- **「忙」从入口算起**，不只是在途 turn；建 MCP、起 session 的那段一个 turn 都没有，拆掉照样打断在起跑线上
- **会话位原子预留**，不是先判一下；判定与建出会话之间隔着若干 await
- **满载拦下并告知**，列出在跑的是哪几条、可直达
- 错误跨 IPC 只剩 message（Electron 丢自定义字段），满载错误需在消息里嵌可识别标记

overview §3.4 的「转后台」会让支线活得很久，进程比 duetlens 更容易攒，这条约束在这里只会更紧。

⚠️ **降级绝不能挑挂着待办的那个**（[ui](ui.md) §8.3）：那会把等着人回答的 pending 就地作废，等于替人做了「这条不查了」的决定。

## 存储：事件、投影、blob 三分

### 领域事件 ≠ SDK 原始流

**`--include-partial-messages` 的打字机 chunk 不落库**，只走 IPC 送 UI。落库的是领域事件（step opened / tool call completed / evidence attached / pending resolved）。否则库被逐字 chunk 撑爆，而回放时没人想看打字机。

### event sourcing 的落地形态

**append-only `events` 表是真相，同事务写物化投影表**（cases / sessions / steps / tool_calls / evidence_refs）。投影表可随时从 events 重放重建——schema 迁移就靠这个。

overview §4.6 说的"UI 从库投影"是这个意思：**不是读时投影**。纯读时投影会让两条时间线的查询和 FTS5 都很难受。

### 大 payload 分层

overview §1.2 要求"每一次工具调用的原始输入/输出完整落库"，单次云日志查询可达 MB 级、一次调查几十次调用。

```
events 表          → 元数据 + payload 引用（sha256 / size / mime）
blobs/<sha256>     → 原始输出落盘（Application Support/Inquestry/）
fts5 表            → 从 payload 抽取的可索引文本
```

好处：同一份日志被多个 EvidenceRef 引用不重复存；FTS5 索引文本而非 blob。

### IPC 策略

- **绝不推原始 payload**。renderer 拿节点摘要 + 前 N 行 preview，展开才 lazy 拉；EvidenceRef 高亮按 `lineRange` 取片段
- **partial chunk 在 main 侧合流**（~16ms flush 一批）再发，否则一个 turn 上万次 IPC
- **事件按 broadcast 语义发**（发给所有 window，不是 reply-to-sender）。第一阶段只做单窗口，但这样写以后开多窗口（overview §4.6）零成本

## 前端：状态分层

duetlens 的三层直接沿用，**但 Inquestry 多一类**：

| 层 | 是什么 | 来源 |
| --- | --- | --- |
| **Server state** | case / session / step / toolCall / evidence / 报告 | main 的 sqlite + agent 事件流 |
| **Pending requests** | 挂起的 `canUseTool` 与 `ask_operator` | **main 内活着的 Promise**，见下 |
| **Persisted UI state** | 栏宽 / 主题 / 上次视图 / 默认展开 | 后端表，不用 `localStorage` |
| **Ephemeral UI state** | 编辑草稿、popover、hover | 组件本地 `useState` |

**Server state 的写路径始终经后端命令**，前端不本地臆造权威数据。

### Pending 为什么必须在 main

它们不是数据，是活着的 Promise。硬要求：

1. **超时兜底（D9）的计时器在 main**。放 renderer 的话，用户关个窗口 agent 就永久挂死
2. **registry 在 main 单例**，renderer 只是只读投影 + 操作入口。overview §5.1⑤ 的重连 re-arm、`request_id` 的 live/replay 双帧去重全在这层做，UI 看到的永远是干净的列表

### 领域事件面编译期收敛

沿用 duetlens：事件名→载荷单一来源、`emit` 私有、renderer 侧 `switch` + never 哨兵。事件种类多得多（step / tool / evidence / pending / 泳道），漏接一个就是某类节点在 UI 上静默消失。

## 屏幕与 Timeline 布局

SPA，屏幕划分沿用 duetlens 的 `screens/` 组织：

- **entry**：Case 列表 + 跨 case 检索（FTS5）
- **case**：工作区——舞台（信息卡 / 待办 / 轨道）+ 输入框 + 状态栏
- **report**：报告页与两种导出（Markdown / 长图）

### 两条时间线分属两个屏，不是同一屏的两个 tab

两条线是同一批证据的两次投影（[data-model](data-model.md) §3），但**人在它们面前做的事完全不同**：调查线服务于"进行中要及时介入"，系统线服务于"定稿后要讲清楚"。因此调查线留在 case 屏，系统线属于 report 屏。

推论：case 屏顶栏没有时间线切换器；report 屏也不实时刷新，它读的是定稿时冻结的投影。

**布局可以换，数据模型换不了**——屏幕怎么分是前端局部决定，不影响 EvidenceRef 的双时间戳设计。
