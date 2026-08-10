# 三个工具与提示词

> 返回 [总设计纪要](overview.md)
>
> 展开 overview §9.2。契约在 [`src/backend/tools/`](../../src/backend/tools/)，提示词在 [`src/backend/prompt/investigation.md`](../../src/backend/prompt/investigation.md)。
> 全部结论来自 `npm run spike:tools` 的 4 轮实跑（2026-08-10，真 agent + 玩具事故）。

## 1. 分层

```
schemas.ts        zod raw shape —— 字段要求由 data-model.md 倒推
definitions.ts    schema + 「结果怎么说给 agent 听」，不 import 任何 backend 类型
sdk-mcp-adapter   Claude：createSdkMcpServer          ← 第一阶段只有这个
（http-mcp-adapter codex：in-process HTTP，挂同一组 TOOL_DEFS）
```

这是 D19 三段接缝里的第一段（agent-backends.md §2.1）。`InvestigationStore` 是工具与持久化之间的唯一接口，spike 里挂的是内存实现，正式实现挂 SQLite。

## 2. `callRef`：证据怎么指回原始输出

agent 下结论时要指明"第几次调用的哪几行"。**不让它抄 toolUseId**——uuid 抄错的概率太高，且它本来就不该关心内部 id。

改用 **step 内的调用序号**：工具返回的正文开头带 `[call #2]` 标记，agent 照抄。

**注入机制已实测通过**（`npm run spike:wire`）：`PostToolUse` hook 的 `hookSpecificOutput.updatedToolOutput` **替换发给模型的工具输出**，因此标记可以注入到**任何**工具的结果里——包括用户自己的 skill 与 MCP，不只是我们自建的三个。这是 D5「工具调用自动归属」能覆盖全量工具的前提。

两个接线时踩到的坑：

- **`tool_response` 对 MCP 工具直接就是 content 数组本身**，不是 `{ content: [...] }`。只认后者的话 blob 里存进去的是一段 JSON，行号锚点全部失真
- 标记要**行内前缀**（`[call #1] 正文`）而不是单独一行，否则模型看到的行号与 blob 物理行号整体错位一行

> **harness 侧解析必须宽容**：实测 agent 会照抄整个标记写成 `call #1` 而不是 `#1`——它照做了提示词说的"照抄"。取第一个整数即可，不要精确匹配格式。这是 harness 的活，不是 agent 的错。

## 3. `occurredAt` 的强制规则收敛了三次

**这是本轮最值钱的发现**，因为踩错的代价直接落在报告主体上。

| 版本 | 规则 | 实测结果 |
| --- | --- | --- |
| v1 | 所有证据一律要求 `occurredAt` | ❌ **agent 拿查询执行时间凑数**（`12:41:20` 那个人工回填时刻），假时间直接混进事故时间线 |
| v2 | 提示词补「没有对应事件时间就留空」+ 按数据源类型要求 | ⚠️ agent 正确留空并注明"schema 事实，无对应事件时间"，但 harness 仍误报警告 |
| v3 | **数据源自带时间戳 且 本次调用有命中** 才要求 | ✅ 8/8 |

三次踩的是同一个坑：**这条规则的归属是 harness 对"这次调用是否真的产出了带时间戳的记录"的判定，不是 prompt 纪律。** 三类证据天然没有事件时间：

- schema / 配置类事实（"cart_key 上只有普通索引"）
- 聚合结论（"窗口内共 3 组重复"）
- **阴性证据**（"以 req_id=abc 检索 sentry 零命中"）—— 这类最容易漏掉，它来自日志源却没有任何命中行

v1 的失败模式尤其要记住：**一刀切的强制不会让字段变完整，只会让它被假数据填满**，而且填的是最不该出错的那个字段。

## 4. 遵从性：§8.2 的头号风险被证伪

overview §8.2 把「agent 填 `direction` 敷衍」列为头号风险。实测**没有发生**，而且反过来超出预期：

| 观测 | 结果 |
| --- | --- |
| `direction` 是可证伪命题 | ✅ 全部。agent 主动写出证伪条件：「若 gateway 日志中 u1001 只有一次下单请求，该假设即被推翻」 |
| 结论敢填 `refuted` | ✅ 最终一轮的 `#1` 就是 refuted（"不是网关重试"），没有为了好看写成 confirmed |
| 每个方向先 `open_step` | ✅ 7/7，未归类调用 0 次 |
| 证据引用准确 | ✅ 16 条证据全部指得回真实调用 |
| `ask_operator` 写 `expect` | ✅ 6 次全写 |
| 学到被改写的真实 schema | ✅ 首条 `orders` 被人改成 `t_order` 后，后续语句全部用新表名（§5.1① 成立） |
| 结案前的 impact / leftover | ✅ 各 1 个 |

**风险等级应下调**：`direction` 敷衍不再是头号风险，`occurredAt` 的规则设计才是。

## 5. 一个意外观测：agent 不会将就自相矛盾的数据

第一轮 spike 里我的假 operator 有 bug——第二批起一律返回 `(0 rows)`。agent 没有接受，而是写进 leftover：

> 「按 cart_key 分组找重复至少该返回 u1001:cart7 那一组，却返回 0 行，且执行时间戳与更早一条查询完全相同，属于回填卡住而非真实为空。**这一项必须重跑聚合查询才能结案。**」

设计含义：**`ask_operator` 的回填质量直接决定排查质量**，而 agent 有能力发现回填出了问题。UI 上要让这类"agent 认为你贴错了"的信号显眼——它比 agent 默默接受烂数据然后给出错误根因好得多。

## 6. 因这次实跑改掉的设计

- **`open_step` 加了 `kind` 字段**（`normal` / `impact` / `leftover`）。提示词要求结案前有两个固定动作，但没有字段就落不进 `steps.kind`，schema 里的枚举永远填不满
- **`leftover` 的 `direction` 豁免可证伪性**。它是汇总，不是假设；提示词与校验都要明说，否则两边打架

## 7. 仍待验证

- **`close_step` 的 warnings 是否真能触发补救**：warnings 会原样回给 agent，但没观测到它据此重新 close 一次。要么构造一个必然触发的场景验，要么把"必须补"的情形改成直接拒绝（返回 error 而非 warning）
- 真实数据源下 `occurredAt` 的自动抽取覆盖率（overview §8.1 未决）
- 多轮长会话下 `open_step` 的遵从性是否衰减——本次玩具事故只跑了 7 个 step
