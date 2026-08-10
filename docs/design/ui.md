# UI

> 返回 [总设计纪要](overview.md)
>
> v0.1 的 Electron 壳与 Timeline 控制面。跑法：`npm start`（或 `npm run build && npx electron-vite preview`）。

## 1. 形态

单窗口 SPA，三段式：

```
┌ 顶栏  案件标题 ·「排查时间线 | 事故时间线」· 会话状态 · 停止 ─┐
│ 主区  step 卡片流 / 事故线行；pending 回填卡置顶            │
│ 底栏  对话带（默认只露最后一句）+ 输入框                    │
└──────────────────────────────────────────────────────────┘
```

**D2 初步成立**：Timeline 占满主区，对话被压到底部一条带，默认只显示最后一句 assistant 文本。实跑下来看的确实是节点，不是对话——agent 的文字里已经没有证据搬运，只剩判断，压缩掉不损失信息。这条仍需长期使用验证，但第一版没有出现「必须展开对话才能理解发生了什么」的情况。

**两条线用同屏切换而非两栏并置**（architecture.md 已决）。实跑印证：75 秒时事故线只有 3 行，两栏会有一半时间是空屏。

## 2. 每个设计决策在 UI 上的落点

| 设计 | UI |
| --- | --- |
| step 状态可被推翻（D12） | 卡片左边框着色；`refuted` / `superseded` 的 direction 加删除线，并标出「已被 stX 推翻」 |
| 两条时间线（D11） | 顶栏切换；事故线每行右侧标出证据来自哪个 step 及其状态 |
| 证据可溯源（§4.2①） | 证据行与工具调用都可点开，按**校正后**的锚点取原文片段 |
| 原始输出不进 IPC | 卡片里只给前 6 行 preview，展开才按需拉全文 |
| 人工回填三要点（§5.1） | pending 卡：语句可编辑（改了会标注"会连同结果一起回传"）、执行时间输入框、`expect` 排在结果框之前 |
| 未归类兜底（§4.4） | 虚线边框的 `#1` 卡片，文案直说「agent 在声明方向之前就先查了一次」 |
| 报告是投影（D17） | 排查线底部常驻「报告投影」条：根因 / 影响面 / 遗留数 / 被推翻数，全部来自 SQL |

## 3. 全量快照推送，不做增量 diff

main 每次领域事件后重算整个 `Snapshot` 推给 renderer（60ms 合流）。

理由不是"数据小所以偷懒"，而是**增量 diff 的错法是静默的**：漏推一类节点，UI 上就是那类东西不存在，没有任何报错——duetlens 上「Discussion 栏整个为空却无人报错」正是这个形态。等数据量真的顶不住再换增量，那时至少有个能对照的正确实现。

## 4. 装起来才暴露的四个问题

前面四个 spike 全在 tsx 里跑，这些一个都不会出现：

| 问题 | 现象 | 结论 |
| --- | --- | --- |
| **ESM preload 需要 `sandbox: false`** | 窗口全黑、无任何报错 | Electron 只在关掉 sandbox 时加载 ESM preload，否则**静默失败**，`window.inquestry` 未定义、React 首个 effect 抛错整树卸载 |
| **schema 不幂等** | 第二次启动崩在 `table events already exists` | 全部 `CREATE ... IF NOT EXISTS` + `user_version`。投影可从 events 重放重建，所以迁移不必写数据搬运 |
| **case 每次启动都重开** | `UNIQUE constraint failed: cases.id` | 一次事故跨多会话（§4.1）：case 只开一次，每次启动是它下面的**新 session**。这条崩溃反而印证了 Case > Session 分层是对的 |
| **schema / 提示词用 `readFileSync` 读源码目录** | 开发期正常，打包必炸 | schema 改成 TS 常量；提示词由构建期 `?raw` 内联。两者都是启动必需品，这类失败只会在装机后才暴露 |

renderer 的报错默认只留在它自己的 devtools 里——`console-message` / `did-fail-load` / `preload-error` 三个事件必须转发到 main 的 stdout，否则每次都只能盯着黑屏猜。

## 5. 开发期自检

无人值守跑一轮并截图，用于没人盯着屏幕时验证 UI：

```bash
INQUESTRY_AUTOSTART="<问题>" INQUESTRY_AUTO_OPERATOR=1 \
INQUESTRY_SHOT="a.png@25000,b.png@75000,c.png@150000" \
INQUESTRY_SHOT_INCIDENT=incident.png INQUESTRY_SHOT_QUIT=1 \
npx electron-vite preview
```

`INQUESTRY_AUTO_OPERATOR` 用数据源给的建议答案代替人回填。**它同时暴露了一个真实风险**：建议答案对不上问题时（拿订单行去答"索引是什么"），agent 当场识破并拒绝把结论算作已验证——与 tools.md §5 观测到的行为一致。

> ⚠️ 窗口未获焦点时 `capturePage()` 可能返回**过期帧**，截图看起来"停在几十秒前"。判断进度以库里的数据为准，不要以截图的时间戳为准。

## 6. 已知欠缺

- **原生模块要按运行环境重建**：`npm run rebuild:electron` 给 app 用，`npm run rebuild:node` 给 tsx spike 用；装完 electron 后 `better-sqlite3` 只对其中一个 ABI 有效
- 只有一个内置演示数据源，真实用法要接用户已有的 skill / MCP（overview §2）
- 对话带只存内存，不进库，刷新即丢
- `canUseTool` 目前只做白名单，**§3.1 的改写参数 / deny+message 两个手势还没有 UI 入口**——控制面最值钱的部分尚未接上
