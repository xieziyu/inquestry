# 数据模型

> 返回 [总设计纪要](overview.md)
>
> 展开 overview §4。**schema 本体在 [`src/backend/db/schema.sql`](../../src/backend/db/schema.sql)，本文只讲为什么。**
> 全部结论由 `npm run spike:db` 实跑验证（2026-08-10，SQLite 3.53.2 / better-sqlite3 12.x）。

## 1. 三层结构

| 层 | 表 | 性质 |
| --- | --- | --- |
| **真相** | `events`、`blobs` | append-only，唯一权威 |
| **投影** | `cases` / `sessions` / `steps` / `tool_calls` / `evidence_refs` | 可 truncate 后重放重建 |
| **检索** | `narrative_fts`、`payload_fts` | 同上，跟着重建 |

**写路径与重放路径必须共用同一个投影函数**，否则"可重放"只是句口号——spike 里 `apply(db, event)` 既是写入口也是重放入口，断言 1 比对的是重建前后**全表指纹**，不是行数。

大 payload 不进库：`blobs` 只存 `sha256 / size / mime / line_count`，原始输出内容寻址落盘。`line_count` 是给 `lineRange` 锚点做边界校验的——锚点指向不存在的行是"看起来溯源了其实没有"的典型形态。

## 2. 五个不显眼但省不掉的字段

### `sessions.backend` + `native_session_ref`

D20 纪律 1。Claude 的 sessionId 与 codex 的 threadId 收进同一列，接第二个 backend 时不必迁移历史数据——而历史数据正是本工具的全部价值。

### `evidence_refs.occurred_at_raw`（不只是 `occurred_at_ms`）

`occurred_at_ms` 是事故时间线的唯一来源（D11），但**原始时间串必须同存**：各日志源的时区与精度千奇百怪，解析出错时没有原始串就无法回溯纠正，只能重查。

配套 `occurred_source ∈ (auto | operator | agent)` —— 自动抽取的可信度与人工填的不同，报告里该能区分。

### `steps.kind ∈ (normal | unclassified | impact | leftover)`

把三条散落的约束固化进 schema，而不是靠 prompt 纪律：

- `unclassified` —— agent 忘了 `open_step` 时 PreToolUse hook 的兜底归属（§8.2 风险表）
- `impact` —— §6.2 的强制影响面节点，结案前必经
- `leftover` —— §6.2 的遗留疑点，"哪怕是空的也要出现"

### `tool_calls.gate_decision` + `input_rewritten`

`canUseTool` 的决策要留痕：哪些是自动放行、哪些是人改写过参数、哪些被拒。§5.1① 要求**改写后的语句一起回传给 agent**（让它学到真实 schema），这个字段是那条回传的依据，也是回看"我当时拦了什么"的唯一记录。

### `evidence_refs.anchor_resolved`（行号只是提示，内容才是依据）

**实跑打出来的字段。** agent 给的行号来自它看到的正文，而正文常常自带另一套编号——日志工具普遍打 `1 | …` 的行首序号，前面还有表头。直接拿这个行号去 blob 里按物理行高亮，会**悄悄指错行**，错得毫无提示，比取不到更糟。

`blobs.ts` 的 `locateEvidence` 因此是双轨的：按行号取片段 → 片段里找不到该证据声称的时间串 → 全文搜该时间串并返回真实行号。校正结果落 `anchor_resolved`，**UI 高亮一律用它**，`anchor` 只留作 agent 原话。

第一次接线时这条 0/17 全错（还叠加了 blob 存成 JSON 的 bug）；修好后 17/17 全部能回到真实那一行。

### `sessions` 之外还需要 case 级的 `incidentDate` / `tzOffset`

日志时间串大多**既无日期也无时区**（`12:03:01.220`）。没有基准日与时区，`occurred_at_ms` 落不成绝对时刻，事故时间线就排不出来。目前挂在会话上下文里，正式实现应落到 `cases` 表。

### `tool_calls.origin ∈ (agent | operator)`

`ask_operator` 的人工回填与普通工具调用**同构落表**，只差 origin 一列。这不是省事，是 §5 的定性：人肉通道是权限边界，不是二等公民；它产出的证据与自动查询的证据在事故时间线上完全平权。

## 3. 两条时间线 = 同一批数据的两次投影

```sql
-- 排查时间线：我按什么顺序做了什么
SELECT ordinal, status, direction, verdict_text, superseded_by
FROM steps WHERE session_id = ? ORDER BY ordinal;

-- 事故时间线：系统当时到底发生了什么
SELECT occurred_at_raw, actor, claim, step_id
FROM evidence_refs e JOIN steps st ON st.id = e.step_id
                     JOIN sessions se ON se.id = st.session_id
WHERE se.case_id = ? AND occurred_at_ms IS NOT NULL
ORDER BY occurred_at_ms;
```

spike 用 overview §1.4 那个"两条重复记录"的样例跑通，事故线逐行重建出文档里的示例。**证据的来源 step 序列是 `[st1, st2, st3, st3, st3, st2]`** —— 非单调，即两条线的顺序确实无关。这是 D11 成立的直接证据：事故线不需要 agent 再写一遍。

### ⚠️ 被推翻的 step，它的证据不作废

事故线第一行 `12:03:01.220 网关只收到一次用户点击提交` 来自 `st1`，而 `st1` 的结论已被 `st3` 推翻。

**结论可以被推翻，事实不会。** `st1` 猜错了原因（以为是前端没防抖），但它查到的网关日志本身是对的，而且是事故线的起点。所以：

- 事故时间线**不能**按 `step.status` 过滤 —— 那会凭空删掉真实发生过的事件
- 报告里"排查路径"栏才需要显示 `superseded` 标记
- 反过来，若某条证据本身被证伪（不是结论被推翻，是这条数据读错了），要的是删除/更正 evidence，不是标记 step

## 4. pending 与进程边界

`tool_calls.status` 含 `pending` 与 `abandoned`。`ask_operator` 与 `canUseTool` 挂起时落 `pending`，UI 刷新后据此恢复挂起节点（§5.1⑤）。

**但 `pending` 跨不过进程重启**：resolve 靠的是 main 进程里活着的 Promise，进程没了就永远 resolve 不了。启动时必须把上一进程遗留的 `pending` 一律改判 `abandoned`，否则库里会攒下永不落地的僵尸节点。

## 5. FTS5 的中文坑（实测，影响 schema）

默认 tokenizer 对中文**完全不可用**：

| tokenizer | 中文 3 字 | 中文 2 字 | 英文 | 索引体积 |
| --- | --- | --- | --- | --- |
| `unicode61`（默认） | ✗ | ✗ | ✓ | 小 |
| `trigram` | ✓ | **✗** | ✓ | 显著更大 |

`unicode61` 不切分连续汉字，整段中文成一个 token，等于搜不到。`trigram` 可用，但 **MATCH 的查询串至少 3 个字符**——搜"延迟"（2 字）返回 0 命中，这是 trigram 的结构性下限，不是 bug。

因此**两张 FTS 表用不同 tokenizer**：

- `narrative_fts`（`trigram`）—— `direction` / `verdict` / `claim`，都是短中文，值得付索引体积
- `payload_fts`（`unicode61`）—— 原始日志，多为英文 + error code + id，且体量大（MB 级 × 几十次调用），不能用 trigram

> 2 字中文搜不到的兜底：`trigram` 表支持 `LIKE '%x%'` 走索引，UI 侧对 <3 字的查询串回退到 LIKE。已实测可行。

## 6. 未定项

- **blob 的落盘位置与清理策略**：`Application Support/Inquestry/blobs/<sha256>`；case 删除后的孤儿 blob 何时回收（引用计数 vs 定期扫）尚未定
- **`payload_fts` 索引什么**：全量原始输出会让索引接近原始数据体积。倾向只索引"抽取后的可检索文本"（日志行的 message 字段等），但抽取规则依赖各数据源，与 `occurred_at` 自动抽取是同一个问题（§8.1）
- **`steps.ordinal` 在子 agent 泳道内的分配**：主线与泳道共用一个序号空间还是各自独立，取决于 Spike A2 的泳道验证结果
