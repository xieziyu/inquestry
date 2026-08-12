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

三个接线时踩到的坑：

- **`tool_response` 对 MCP 工具直接就是 content 数组本身**，不是 `{ content: [...] }`。只认后者的话 blob 里存进去的是一段 JSON，行号锚点全部失真
- 标记要**行内前缀**（`[call #1] 正文`）而不是单独一行，否则模型看到的行号与 blob 物理行号整体错位一行
- **一次调用的收尾散在三个 hook 上**，只接 `PostToolUse` 的话，凡是没跑成的调用就只有 `toolcall.started`，库里和 UI 上永远停在 `pending`，正文也进不了 blob——而"查不到东西"的原因常常就写在那句报错里

| 收尾 | 走哪个 hook | 载荷 | 记成 |
| --- | --- | --- | --- |
| 跑完了 | `PostToolUse` | `tool_response` | `done` |
| 工具报错 | `PostToolUseFailure` | `error`（不是 `tool_response`） | `failed`；`is_interrupt` 记 `abandoned`——人按了停止不是工具坏了 |
| 规则拒绝 | `PermissionDenied` | `reason` | `denied`。项目 settings 里 deny 掉的（比如不许读 `.env`）走这条，**不经过本地闸门** |
| 停止 / 关案时散掉的闸门 | 没有 hook，harness 自己收 | —— | `abandoned` |

> 我们自己在 PreToolUse 里硬拒的**不发** `PermissionDenied`（SDK 契约），那些在记账那一刻就收完了；闸门（`canUseTool`）拒的会发。
>
> 三者会**互相重叠**：一次规则拒绝同时也是一次失败，两个 hook 都到，顺序不保证。所以收尾要按当前状态判——已经是 `denied` 就不动（别用规则给的理由顶掉闸门的留话），是 `failed` 则允许被 `denied` 纠正，只有 `pending` 才认失败。少这一层，「这里有一道权限边界」会被记成「这个工具坏了」，报告里是两句完全不同的话。
>
> **最后一行没有 hook 可接**：人按停止时，还卡在闸门上的调用得由 harness 自己收。agent 那侧只有 allow / deny 两种收法，所以照样回一个 deny——**但账上不能记成 `denied`**：被拒的意思是有人看过这一条并说了不行，中断连"这次调用该不该跑"都没问到。真按被拒记，轨道上会多出一条从没有人下过的判断。`gate_decision` 也保持原样不动，闸门确实没做出判决，补一个反而是编的。

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

## 6.1 `close_step` 上的形态与应然实然（D25）

`close_step` 后来又加了三个可选字段：`shape`（五种结论形态）与 `expected` / `actual`。**只在某一步给出了整个案子的根因时才填**，其余步一律留空。

agent 的负担刻意压到"多填一个枚举"：形态最终由人在结案确认条上按下去（[ui](ui.md) §8.4.2），这里给的只是预选值。**所以拿不准就别填**——不填由人选，填错的代价是报告里多出一块空的。

"填了不生效"由 warnings 当场说，理由与 `occurredAt` 那三次收敛同源：不当场说，agent 以为已经交代过了，而报告要到结案那天才发现那一栏是空的。**静默忽略并不比错误采纳好多少**——两者都让 agent 以为形态已经交代过了。

**判断一律按合成之后的最终值。** 投影是 patch 语义，按本次入参判会两头错：只补了 evidence 的那次看不见库里已经躺着的 `state`（缺主体不报警），只补了 `expected` 的那次又被当成"只给了一半"（另一半上次就填过了）。合成规则要与投影里的 `COALESCE` 一致。

**纯空白按没填算。** `" "` 过得了 `z.string()`，而完整性判断全是 truthiness——不归一的话既不报"缺主体"、`stateFillable` 也成了 `true`，报告最后拿到的是一块视觉上的空白。写入侧统一 `trim()`，空的落 NULL。

**同一步 close 第二次时，这三项不重填就保持原样。** 补证据那一次多半只带 `evidence`，把"没再填"当成"清空"的话，第一次填好的形态与报告主体会被静默抹掉——而重新 close 这条路正是上面这些 warning 指使 agent 走的。要改就重新填。

但警告**只陈述现状，不给处置**。一度写成「要让它算数，得先把那条根因推翻」——那等于教 agent 去推翻一条有效结论、或把置信度往上凑。该不该推翻只有查过的它自己判得了，harness 越过这条线就是在替它下结论。

| 情形 | 为什么不生效 |
| --- | --- |
| 声明在非 `confirmed` 的结论上 | 形态说的是"这是哪一类故障"，只有已证实的结论说得出这句话 |
| 声明在非 `normal` 的 step 上（影响面 / 遗留疑点） | 形态只由根因那一步说了算，而根因一定是 `normal` |
| 声明在一条**当前不是根因**的 `normal` step 上 | 报告取的是置信度最高那条。这一条只有落库之后才判得出来，所以警告在事件发出之后才算；也**只对够得着根因资格的说**（`confirmed` 的 `normal`）——上面两种已经被告知永不生效，再补一句"现在的根因是谁"只会把它引向一条不该走的路 |
| `shape=state` 却没给 `expected` / `actual` | 那一对**就是**状态型报告的主体，缺了那一栏是空的 |
| `expected` / `actual` 只给一半 | 半边对照说明不了任何事 |

## 7. 仍待验证

- **`close_step` 的 warnings 是否真能触发补救**：warnings 会原样回给 agent，但没观测到它据此重新 close 一次。要么构造一个必然触发的场景验，要么把"必须补"的情形改成直接拒绝（返回 error 而非 warning）
- 真实数据源下 `occurredAt` 的自动抽取覆盖率（overview §8.1 未决）
- 多轮长会话下 `open_step` 的遵从性是否衰减——本次玩具事故只跑了 7 个 step
