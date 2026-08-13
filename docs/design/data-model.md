# 数据模型

> 返回 [总设计纪要](overview.md)
>
> 展开 overview §4。**schema 本体在 [`src/backend/db/schema.ts`](../../src/backend/db/schema.ts)，本文只讲为什么。**
> 全部结论由 `npm run spike:db` 实跑验证（2026-08-10，SQLite 3.53.2 / better-sqlite3 12.x）。

## 1. 三层结构

| 层 | 表 | 性质 |
| --- | --- | --- |
| **真相** | `events`、`blobs` | append-only，唯一权威 |
| **投影** | `cases` / `sessions` / `steps` / `tool_calls` / `evidence_refs` | 可 truncate 后重放重建 |
| **检索** | `narrative_fts`、`payload_fts` | 同上，跟着重建 |

**写路径与重放路径必须共用同一个投影函数**，否则"可重放"只是句口号——spike 里 `apply(db, event)` 既是写入口也是重放入口，断言 1 比对的是重建前后**全表指纹**，不是行数。

大 payload 不进库：`blobs` 只存 `sha256 / size / mime / line_count`，原始输出内容寻址落盘。`line_count` 是给 `lineRange` 锚点做边界校验的——锚点指向不存在的行是"看起来溯源了其实没有"的典型形态。

## 2. 不显眼但省不掉的字段

### `sessions.backend` + `native_session_ref` + `model` / `effort`

D20 纪律 1。Claude 的 sessionId 与 codex 的 threadId 收进同一列，接第二个 backend 时不必迁移历史数据——而历史数据正是本工具的全部价值。

`model` 与 `effort` 也在这一层，**不在 `cases`**：一个案子跨多个会话，中途换模型是常态（先用便宜的扫一遍，再换强的推）。挂在 case 上会让"这一步是哪个模型跑的"永远答不上来，而报告里要标它。`effort` 允许为空——不是所有 backend 都有这个概念（D19 能力协商）。

### `evidence_refs.occurred_at_raw`（不只是 `occurred_at_ms`）

`occurred_at_ms` 是事故时间线的唯一来源（D11），但**原始时间串必须同存**：各日志源的时区与精度千奇百怪，解析出错时没有原始串就无法回溯纠正，只能重查。

配套 `occurred_source ∈ (auto | operator | agent)` —— 自动抽取的可信度与人工填的不同，报告里该能区分。

### `steps.kind ∈ (normal | unclassified | impact | leftover)`

把三条散落的约束固化进 schema，而不是靠 prompt 纪律：

- `unclassified` —— agent 忘了 `open_step` 时 PreToolUse hook 的兜底归属（§8.2 风险表）
- `impact` —— §6.2 的强制影响面节点，结案前必经
- `leftover` —— §6.2 的遗留疑点，"哪怕是空的也要出现"

### `steps.status` 里的 `converged`（schema v4 起）

前五档说的都是**对一个命题的判定**（`open` 还在验 · `confirmed` / `refuted` / `inconclusive` 是三种结果 · `superseded` 被顶掉了）。子 agent 泳道的兜底步没有命题——它是 harness 替一条支线开的账本，`direction` 恒为 NULL——所以那五档没有一档说得出"这条支线跑完了"。

- 借 `inconclusive` 的代价是**每条跑完的支线都会变成报告里的一条「遗留疑点」**：那一栏按 `status` 取，不看 `kind`（`queries.ts`）。而它谁都没落下，只是没有人替它下判断
- 留在 `open` 的代价是轨道上永远有一条"还在查"的支线，而它早就结束了
- 报告那几栏都按具体 status 取，`converged` 因此哪一栏都不进——**这正是它该有的样子**，也是"它与那五档正交"的证据：加这一档没有改动任何一条报告查询

写入方**只有 harness**（`lane.converged` 事件）：支线自己开不了步也收不了步，主线拿不到那一步的 id。内容是**支线自己的话**（`SubagentStop` 的 `last_assistant_message`，退回 `task_notification.summary`），不是 harness 编的判定。三处发它：支线跑完（通知到达）· 会话收尾时还开着的（`close()`）· 上一个进程留下的（启动清扫）。后两种记 `outcome='orphaned'` 并在正文里明写"没有收尾"。

### `tool_calls.gate_decision` + `input_rewritten`

`canUseTool` 的决策要留痕：哪些是自动放行、哪些是人改写过参数、哪些被拒。§5.1① 要求**改写后的语句一起回传给 agent**（让它学到真实 schema），这个字段是那条回传的依据，也是回看"我当时拦了什么"的唯一记录。

### `evidence_refs.anchor_resolved`（行号只是提示，内容才是依据）

**实跑打出来的字段。** agent 给的行号来自它看到的正文，而正文常常自带另一套编号——日志工具普遍打 `1 | …` 的行首序号，前面还有表头。直接拿这个行号去 blob 里按物理行高亮，会**悄悄指错行**，错得毫无提示，比取不到更糟。

`blobs.ts` 的 `locateEvidence` 因此是双轨的：按行号取片段 → 片段里找不到该证据声称的时间串 → 全文搜该时间串并返回真实行号。校正结果落 `anchor_resolved`，**UI 高亮一律用它**，`anchor` 只留作 agent 原话。

第一次接线时这条 0/17 全错（还叠加了 blob 存成 JSON 的 bug）；修好后 17/17 全部能回到真实那一行。

### `cases` 上的立案单（schema v2 起已落库）

日志时间串大多**既无日期也无时区**（`12:03:01.220`）。没有基准日与时区，`occurred_at_ms` 落不成绝对时刻，事故时间线就排不出来。所以它们**在立案时收**，不能等结案（overview D27）。

| 字段 | 为什么 |
| --- | --- |
| `incident_date` / `tz_offset` | 上述基准，`NOT NULL`。基准日由立案面板收，**时区不收**——取立案机器的本机偏移落库。重开旧案时一律以库里那份为准：重算或改动都会让新证据与老证据错开 |
| `project_root` | agent 的运行目录（`Options.cwd`），决定它继承哪套 skill / MCP，也决定会话记录落盘位置。为空即演示模式，玩具数据源只在这时挂上去 |
| `question` / `clues` | 立案时写的完整问题与已知线索。新开 session 时由它们拼出首轮提问，基准日也一并写进正文——harness 与 agent 两边补齐时间串的基准必须一致 |
| `verdict_shape ∈ (sequence \| state \| chain \| distribution \| open)` | 决定报告装哪几块（overview §6.1.1）。**收尾那一下才写**，在那之前是 NULL，见下 |
| `status ∈ (open \| closed \| aborted)` | 区分"停下来还能接着查"（`open`）与"放弃了"（`aborted`）。后者仍可导出残报告，形态强制 `open`（overview D29） |

### 形态是两层的：`steps.shape` 声明，`cases.verdict_shape` 定案

agent 在 `close_step` 里填的 `shape` 落**那一步**，不直接写进 `cases`。理由与 `expected` / `actual` 挂 step 完全同源：**它是某一步的判定内容，不是案件属性**——形态说的是"这个结论属于哪一类故障"，那条结论被推翻时，这句话跟着一起不成立。写进 `cases` 的话它不会跟着失效，报告就会按一份已经作废的判断装块。

`cases.verdict_shape` 是收尾那一下定下来的终值，来源三选一：

| 来源 | 什么时候 |
| --- | --- |
| agent 声明 | **报告认定的那条根因**上的 `shape`。只认它一条：形态说的是"这个案子的根因属于哪一类故障"，别处（比如一条误填了 `shape` 的 impact step）说了不算，否则报告会按 A 步的形态装块、却填 B 步的内容，且毫无报错。与影响面共用 `effectiveStep` 是同一条纪律 |
| harness 推断 | 没人声明过。规则只有一条准绳：**宁可少装一块，也不装一块空的**——没有已证实的根因 → `open`；根因带应然实然 → `state`；事故时间线上有两条以上证据 → `sequence`；其余 → `chain`（它的主体能从 step 树直接投影，任何案子都装得出来） |
| 人选的 | 结案确认条上的五选一，预选值就是上面那个。它优先——报告怎么装是人看着后果按下去的那个选择 |

**归档一律 `open`，盖掉一切声明**：残报告的主体是排除掉的方向与遗留疑点，没有根因栏（ui.md §8.4）。查到一半的案子照它自己的形态装，装出来的正是那份"看着完整实则半截"的报告。

`expected` / `actual` 同样挂 `confirmed` step，成对才有意义；报告取的是根因那一步的那一对，所以根因换了人，它跟着换。

### 开发期不做跨版本迁移：版本对不上就重建库

**发版前，`user_version` 变化一律是「把旧库挪开，新建一个空的」**，不写迁移。

一度写成了"DROP 投影表 → 按 events 重放"。它跑得通——实测老库照样重建出 5 个 step / 9 条证据——但那只是因为 better-sqlite3 把 `undefined` 绑成 NULL：**老事件缺的字段一路静默落 NULL，看起来迁移成功，实际是一批半残的案子**。重放这条路只在"事件载荷形状没变过"时才真的成立，而破坏性升级恰恰改的就是形状。

开发阶段的数据本来就是随手造的，重新补一份远比维护一条没人验过的迁移路径便宜。所以：旧库改名留在原地（连 `-wal` / `-shm` 一起挪，留一个都会让新库读到半截旧状态），不删——事故记录哪怕格式过时也不该被工具自己抹掉。发版后要换成真迁移时，`openDatabase` 里那个判断就是决策点。

> `user_version` 的默认值就是 `0`，所以 0 有两种含义：空文件，或者一个没打过版本号的老库。**靠有没有应用表来分**——有表的 0 号库必须按不兼容处理。放过它的话 `CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，却照样把它标成当前版本，等第一次查新列才炸，而那时错误已经离原因很远了。

> 这不否定 §1「events 是唯一真相」：**同一个 schema 版本内**投影随时可从 events 重建，`rebuildProjections` 仍是排障与自检工具（`spike:wire` 就靠它比对重建前后的全表指纹）。重放时 `caseId` 必须取**每条事件自己的**——传单个 caseId 会把所有案子的 FTS 行标成同一个 case，检索时静默串台。

配套的一条：`incident_date` / `tz_offset` 是 `NOT NULL`。**没有基准的案子不该存在**，缺了就该在写入时炸，而不是留个空值让下游各自现算一个"今天"——那会让同一个 case 的证据按不同的日子解析，全程无报错。

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

已落成 `sweepZombies()`（`store/sqlite-store.ts`），随 D29 的收尾三档一起接上，同批也把上次遗留的 `live` 会话收成 `crashed`。落地时才看清的约束：

- **清扫必须赶在任何 runner 建起来之前**（`main/index.ts` 里紧跟 `openDatabase`）。那一刻库里的 `pending` 与 `live` 才必然全是上次残留的；建完 runner 再扫会把这一轮自己的活计一起判成放弃
- **清扫走事件**，与收尾同理：直接 `UPDATE tool_calls` 的值一重放就被 `toolcall.started` 抹回 `pending`

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
- ~~**`steps.ordinal` 在子 agent 泳道内的分配**~~ —— **已定：主线与泳道共用一个序号空间**，按到达顺序单调追加，`lane` 只是另一列。

  这是 D23 的直接后果（主干纵向单调追加、永不重排，分叉只向右生长）：两套序号意味着渲染时要另找一个跨泳道的排序键，而任何"排漂亮"的重排都会让已读节点位移。Spike A2 顺带验掉了这条的前提——**支线的到达顺序会与发起顺序反过来**（附录 A.1），所以序号必须记到达顺序，不能记发起顺序，否则同一条轨道会在支线回来时被迫重排

  已按这条实现（overview §9.15）。写入侧另有两点：**`lane` 的写入方是 harness 不是 agent**（`agent_id ↔ lane` 那座桥只有 harness 走得了，工具面压根传不进泳道）；**每条泳道各有一个「当前 open 的 step」**，取的时候是 `lane IS ?`（主干那侧绑 NULL）——共用一个的话，一条后台支线查到的东西会记进主线正开着的那一步

- **`tool_calls` 要不要也带 `lane`** —— **暂定不加**：泳道挂在步上，调用侧已有 `agent_id`，要按泳道查调用 join 一次 `steps` 就够。加一列换来的是一次 schema 升版加整个开发库归档，而它推不出任何新东西。等真出现"同一步里的调用分属不同泳道"的形态再说（现在不会：步本身就是按泳道分的）
