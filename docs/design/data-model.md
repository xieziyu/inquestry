# 数据模型

> 返回 [总设计纪要](overview.md)
>
> 展开 overview §4。**schema 本体在 [`src/backend/db/schema.ts`](../../src/backend/db/schema.ts)，
> 迁移与检索的实现在 `db/database.ts` / `db/queries.ts`——本文只讲为什么有这些字段、
> 为什么是这个形状，不复述实现。结论由 `npm run spike:db` / `spike:cases` 兜底。

## 1. 三层结构

| 层 | 表 | 性质 |
| --- | --- | --- |
| **真相** | `events`、`blobs` | append-only，唯一权威 |
| **投影** | `cases` / `sessions` / `steps` / `tool_calls` / `evidence_refs` | 可 truncate 后重放重建 |
| **检索** | `narrative_fts`、`payload_fts` | 同上，跟着重建 |

**写路径与重放路径必须共用同一个投影函数**，否则"可重放"只是句口号——`apply(db, event)` 既是写入口也是重放入口，回归检查比对的是重建前后**全表指纹**，不是行数。

大 payload 不进库：`blobs` 只存 `sha256 / size / mime / line_count`，原始输出内容寻址落盘。`line_count` 是给 `lineRange` 锚点做边界校验的——锚点指向不存在的行是"看起来溯源了其实没有"的典型形态。

## 2. 不显眼但省不掉的字段

### `sessions.backend` + `native_session_ref` + `model` / `effort`

D20 纪律 1。Claude 的 sessionId 与 codex 的 threadId 收进同一列，接第二个 backend 时不必迁移历史数据——而历史数据正是本工具的全部价值。

`model` 与 `effort` 也在这一层，**不在 `cases`**：一次排查跨多个会话，中途换模型是常态（先用便宜的扫一遍，再换强的推）。挂在 case 上会让"这一步是哪个模型跑的"永远答不上来，而报告里要标它。`effort` 允许为空——不是所有 backend 都有这个概念（D19 能力协商）。

### `evidence_refs.occurred_at_raw`（不只是 `occurred_at_ms`）

`occurred_at_ms` 是系统时间线的唯一来源（D11），但**原始时间串必须同存**：各日志源的时区与精度千奇百怪，解析出错时没有原始串就无法回溯纠正，只能重查。

配套 `occurred_source ∈ (auto | operator | agent)` —— 自动抽取的可信度与人工填的不同，报告里该能区分。

### `evidence_refs.anchor_resolved`（行号只是提示，内容才是依据）

**实跑打出来的字段。** agent 给的行号来自它看到的正文，而正文常常自带另一套编号——日志工具普遍打 `1 | …` 的行首序号，前面还有表头。直接拿这个行号去 blob 里按物理行高亮，会**悄悄指错行**，错得毫无提示，比取不到更糟。

`blobs.ts` 的 `locateEvidence` 因此是双轨的：按行号取片段 → 片段里找不到该证据声称的时间串 → 全文搜该时间串并返回真实行号。校正结果落 `anchor_resolved`，**UI 高亮一律用它**，`anchor` 只留作 agent 原话。

### `steps.kind ∈ (normal | unclassified | impact | leftover)`

把三条散落的约束固化进 schema，而不是靠 prompt 纪律：

- `unclassified` —— agent 忘了 `open_step` 时 PreToolUse hook 的兜底归属
- `impact` —— 强制影响面节点，定稿前必经（overview §6.2）
- `leftover` —— 遗留问题，"哪怕是空的也要出现"

### `steps.status` 里的 `converged`

前五档说的都是**对一个命题的结论**（`open` 还在验 · `confirmed` / `refuted` / `inconclusive` 是三种结果 · `superseded` 被顶掉了）。子 agent 泳道的兜底步没有命题——它是 harness 替一条支线开的账本，`direction` 恒为 NULL——所以那五档没有一档说得出"这条支线跑完了"。

- 借 `inconclusive` 的代价是**每条跑完的支线都会变成报告里的一条「遗留问题」**：那一栏按 `status` 取，不看 `kind`。而它谁都没落下，只是没有人替它下判断
- 留在 `open` 的代价是轨道上永远有一条"还在查"的支线，而它早就结束了
- 报告那几栏都按具体 status 取，`converged` 因此哪一栏都不进——**这正是它该有的样子**，也是"它与那五档正交"的证据：加这一档没有改动任何一条报告查询

写入方**只有 harness**（`lane.converged` 事件）：支线自己开不了步也收不了步，主线拿不到那一步的 id。内容是**支线自己的话**（`SubagentStop` 的 `last_assistant_message`，退回 `task_notification.summary`），不是 harness 编的结论。三处发它：支线跑完（通知到达）· 会话收尾时还开着的 · 上一个进程留下的（启动清扫）。后两种记 `outcome='orphaned'` 并在正文里明写"没有收尾"。

### `steps.lane` 与序号空间

**主线与泳道共用一个 `ordinal` 序号空间**，按到达顺序单调追加，`lane` 只是另一列。这是 D23 的直接后果：两套序号意味着渲染时要另找一个跨泳道的排序键，而任何"排漂亮"的重排都会让已读节点位移。实测**支线的到达顺序会与发起顺序反过来**，所以序号必须记到达顺序。

- **`lane` 的写入方是 harness 不是 agent**（`agent_id ↔ lane` 那座桥只有 harness 走得了，工具面压根传不进泳道）
- **每条泳道各有一个「当前 open 的 step」**，取的时候是 `lane IS ?`（主干那侧绑 NULL）——共用一个的话，一条后台支线查到的东西会记进主线正开着的那一步
- **`tool_calls` 上不加 `lane` 列**：泳道挂在步上，调用侧已有 `agent_id`，要按泳道查调用 join 一次 `steps` 就够。加一列换来的是一次 schema 升版加整个开发库归档，而它推不出任何新东西

### `steps.remediation`

报告四栏里唯一由 agent 生成的那一块（overview §6.1），写入方是 `close_step` 的可选 `remediation`，与 `shape` / `expected` / `actual` 同为 patch 语义（缺省=不动，投影走 COALESCE）。

**挂 step 不挂 case**，理由与 `shape` 同源：建议是基于那一步的判断给的，那一步被推翻时它得跟着失效，否则报告里会躺一条基于作废判断的修复方案。

**但取哪一条与 `shape` 相反**：`shape` 只认根因那一步（形态描述的正是那条根因），而修复建议**不跟着根因走**——未决型与归档的半程报告压根没有根因，而"没查出来，下一步先加哪些观测"恰恰是那种排查最该留下的东西。选择器因此是「最新一条仍然成立的声明」（`effectiveRemediation`）：排除 `superseded`（判断被顶掉）与 `refuted`（假设自己被否掉）。

> **同一个问题在两处可以有相反的正确答案**，别把下面「形态是两层的」那条纪律直接搬过来：那一条防的是"报告的结构与内容指着两条不同的根因"，而这一条防的是"整整一栏在最需要它的那类排查里永远是空的"。判断的方法是**分别问两个方向的失败长什么样**。

### `chat_lines`：唯一重建不出来的那一份

步骤、证据、结论、两条时间线，全都是 `events` 的投影，删了能重建。**对话带不是**——人当时那句"别查网关了，先看从库"没有别的来源。只存内存的话，关掉 app 就只剩 agent 的结论，读起来像是它自己想通的。

- 走事件（`chat.appended`）而不是直接 INSERT，理由同 `case.status_changed`：直接写的库值一重放就没了
- **按 case 取，不按 session 取**（同两条时间线）：重开旧排查时按会话取只能看到空的，而上一轮说过什么正是重开时最该看见的
- `session_id` 可空——建完单还没开会话时也会有系统提示，为了一句提示把会话提前开出来，库里就多一个空会话
- 快照只推最近 `CHAT_TAIL` 句：全量推的话，一个跨几轮会话的排查每 60ms 就要搬一遍整段对话
- 报告不印它（正文只认 step 与证据），但它进 `narrative_fts`：跨案找"上次那个从库延迟的"时，人自己说过的话往往比结论更好记

### `tool_calls.gate_decision` + `input_rewritten`

**`auto` 与 `auto_deny` 是 backend 那侧自己定的，其余几种都是人按的**。分不开的话，读轨道的人会把分类器拒掉的当成自己当时拦下的——而按后果分档之后（overview §3.5），人压根不参与判定，那句"我拦过它"没有任何人说过。细到"是分类器还是项目规则"看留话。

`input_rewritten` 是「改写后的语句一起回传给 agent」（overview §5.1①）的依据，也是回看"我当时拦了什么"的唯一记录。

### `tool_calls.origin ∈ (agent | operator)`

`ask_operator` 的人工回填与普通工具调用**同构落表**，只差 origin 一列。这不是省事，是 overview §5 的定性：人肉通道是权限边界，不是二等公民；它产出的证据与自动查询的证据在系统时间线上完全平权。

### `cases` 上的建单信息

日志时间串大多**既无日期也无时区**（`12:03:01.220`）。没有基准日期与时区，`occurred_at_ms` 落不成绝对时刻，系统时间线就排不出来。所以它们**在新建排查时收**，不能等定稿（D27）。

| 字段 | 为什么 |
| --- | --- |
| `incident_date` / `tz_offset` | 上述基准，`NOT NULL`。基准日期由新建排查面板收，**时区不收**——取新建排查机器的本机偏移落库。重开旧排查时一律以库里那份为准：重算或改动都会让新证据与老证据错开 |
| `project_root` | agent 的运行目录（`Options.cwd`），决定它继承哪套 skill / MCP，也决定会话记录落盘位置。为空即演示模式，玩具数据源只在这时挂上去 |
| `question` / `clues` | 新建排查时写的完整问题与已知现象。新开 session 时由它们拼出首轮提问，基准日期也一并写进正文——harness 与 agent 两边补齐时间串的基准必须一致 |
| `verdict_shape ∈ (sequence \| state \| chain \| distribution \| open)` | 决定报告装哪几块（overview §6.1.1）。**收尾那一下才写**，在那之前是 NULL |
| `status ∈ (open \| closed \| aborted)` | 区分"停下来还能接着查"与"放弃了"。后者仍可导出半程报告，形态强制 `open`（D29） |

`incident_date` / `tz_offset` 是 `NOT NULL`：**没有基准的排查不该存在**，缺了就该在写入时炸，而不是留个空值让下游各自现算一个"今天"——那会让同一个 case 的证据按不同的日子解析，全程无报错。

### 形态是两层的：`steps.shape` 声明，`cases.verdict_shape` 定案

agent 在 `close_step` 里填的 `shape` 落**那一步**，不直接写进 `cases`。理由与 `expected` / `actual` 挂 step 完全同源：**它是某一步的结论内容，不是排查属性**——形态说的是"这个结论属于哪一类故障"，那条结论被推翻时，这句话跟着一起不成立。写进 `cases` 的话它不会跟着失效，报告就会按一份已经作废的判断装块。

`cases.verdict_shape` 是收尾那一下定下来的终值，来源三选一：

| 来源 | 什么时候 |
| --- | --- |
| agent 声明 | **报告认定的那条根因**上的 `shape`。只认它一条：别处（比如一条误填了 `shape` 的 impact step）说了不算，否则报告会按 A 步的形态装块、却填 B 步的内容，且毫无报错。**与影响面共用 `effectiveStep` 是同一条纪律** |
| harness 推断 | 没人声明过。准绳只有一条：**宁可少装一块，也不装一块空的**——没有已证实的根因 → `open`；根因带应然实然 → `state`；系统时间线上有两条以上证据 → `sequence`；其余 → `chain`（它的主体能从 step 树直接投影，任何排查都装得出来） |
| 人选的 | 定稿确认条上的五选一，预选值就是上面那个。它优先——报告怎么装是人看着后果按下去的那个选择 |

**归档一律 `open`，盖掉一切声明**：半程报告的主体是排除掉的方向与遗留问题，没有根因栏（ui.md §8.4）。

`expected` / `actual` 同样挂 `confirmed` step，成对才有意义；报告取的是根因那一步的那一对，所以根因换了人，它跟着换。

### 两类升级，两种手段

**贵不贵取决于变更类型，不取决于时间**：

| 变更 | 手段 | 代价 |
| --- | --- | --- |
| 加新事件类型 · 给已有事件加**可选**字段 · 加 nullable 列 · 改索引 | **重放**（`rebuildProjections`） | 老事件不受影响，投影侧走 COALESCE / 显式默认 |
| 改 CHECK 约束 · 加 NOT NULL 列 · **改已有字段的语义或必填项** | 重建库（旧库挪开）；发版后要写 upcaster | 老事件形状对不上，重放不成立 |

前提是那条纪律：**事件只加不改**——要加信息就加新事件类型，或加可选字段 + 投影侧显式默认，别动老字段的含义。守住它，绝大多数升级都落在第一行。

**第二类一律是「把旧库挪开，新建一个空的」，不写迁移。** 一度写成"DROP 投影表 → 按 events 重放"，它跑得通——但那只是因为 better-sqlite3 把 `undefined` 绑成 NULL：**老事件缺的字段一路静默落 NULL，看起来迁移成功，实际是一批半残的排查**。重放只在"事件载荷形状没变过"时才真的成立，而破坏性升级改的就是形状。开发阶段的数据本来就是随手造的，重新补一份远比维护一条没人验过的迁移路径便宜。旧库改名留在原地不删——排查记录哪怕格式过时也不该被工具自己抹掉。

**重放的第一步是体检，不是重放**：一级"其实改了载荷形状"的升级被写进阶梯时，体检要在动土之前拦下，此时**退回挪库而不是抛错**。硬迁会落出一批半残的排查（与一次成功的迁移长得一模一样），抛错则是让 app 起不来——声明错的代价该是"这次没迁成"，不该是"今天用不了这个工具"。

> ⚠️ 三条这一带特有的、错了没有任何报错的：
>
> - **`user_version = 0` 有两种含义**（空文件 / 没打过版本号的老库），靠有没有应用表来分。放过它的话 `CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，却照样把它标成当前版本，等第一次查新列才炸，而那时错误已经离原因很远了
> - **重放会顺手清空 `case_ui_state`**（它对 `cases(id)` 带 `ON DELETE CASCADE`，而清投影第一句就是 `DELETE FROM cases`）。里面装的是**重建不出来的两样**：新建排查时选的 agent 与接管开关。丢了不报错、排查还在，表现是"升级完模型悄悄换回默认、接管自己关掉了"
> - **重放时 `caseId` 必须取每条事件自己的**——传单个 caseId 会把所有排查的 FTS 行标成同一个 case，检索时静默串台
>
> 顺序、DDL 与幂等 schema 的先后、体检的 `REQUIRED_KEYS`（写成映射类型，漏键漏事件都编译不过），全在 `db/database.ts` 与 `db/projector.ts` 里。

## 3. 两条时间线 = 同一批数据的两次投影

```sql
-- 排查时间线：我按什么顺序做了什么
SELECT ordinal, status, direction, verdict_text, superseded_by
FROM steps WHERE session_id = ? ORDER BY ordinal;

-- 系统时间线：系统当时到底发生了什么
SELECT occurred_at_raw, actor, claim, step_id
FROM evidence_refs e JOIN steps st ON st.id = e.step_id
                     JOIN sessions se ON se.id = st.session_id
WHERE se.case_id = ? AND occurred_at_ms IS NOT NULL
ORDER BY occurred_at_ms;
```

**两条都按 case 取，不按 session 取**：一次排查跨多会话，按 session 取时重开旧排查主区是空的，看起来像数据丢了而不像查错了表。代价是 `ordinal` 每个会话都从 1 重来，轨道上要标出会话断点。

实跑样例里证据的来源 step 序列是非单调的（`[st1, st2, st3, st3, st3, st2]`），即两条线的顺序确实无关。这是 D11 成立的直接证据：系统线不需要 agent 再写一遍。

### ⚠️ 被推翻的 step，它的证据不作废

**结论可以被推翻，事实不会。** 一步猜错了原因，但它查到的网关日志本身是对的，而且往往就是系统线的起点。所以：

- 系统时间线**不能**按 `step.status` 过滤 —— 那会凭空删掉真实发生过的事件
- 报告里"排查路径"栏才需要显示 `superseded` 标记
- 反过来，若某条证据本身被证伪（不是结论被推翻，是这条数据读错了），要的是删除/更正 evidence，不是标记 step

## 4. pending 与进程边界

`tool_calls.status` 含 `pending` 与 `abandoned`。`ask_operator` 与 `canUseTool` 挂起时落 `pending`，UI 刷新后据此恢复挂起节点。

**但 `pending` 跨不过进程重启**：resolve 靠的是 main 进程里活着的 Promise，进程没了就永远 resolve 不了。启动时必须把上一进程遗留的 `pending` 一律改判 `abandoned`，否则库里会攒下永不落地的僵尸节点。

已落成 `sweepZombies()`（`store/sqlite-store.ts`），同批也把上次遗留的 `live` 会话收成 `crashed`。两条约束：

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

- `narrative_fts`（`trigram`）—— `direction` / `verdict` / `claim` / 对话 / 建单信息，都是短中文，值得付索引体积
- `payload_fts`（`unicode61`）—— 原始日志，多为英文 + error code + id，且体量大（MB 级 × 几十次调用），不能用 trigram

2 字中文的兜底是回退 `LIKE '%x%'`。⚠️ **"走索引"这句要打个折**：trigram 的 LIKE 优化要求模式里有**连续 3 个非通配字符**，所以 2 字那条本来就走不到索引。实测的增长（一行 = 一条 direction / verdict / claim / 对话句 / 建单信息）：

| 表大小 | 2 字**无命中** | 2 字常见词 | ≥3 字罕见词 |
| --- | --- | --- | --- |
| 1 万行 | 1.1ms | 1.2ms | 0.05ms |
| 5 万行 | 5.4ms | 0.9ms | 0.07ms |
| 20 万行 | 21.8ms | 0.9ms | 0.26ms |
| 50 万行 | 56.0ms | 0.9ms | 0.24ms |

**有命中的短词不吃亏**（`LIMIT` 提前收，恒 ~1ms）；线性增长的只有"这个词库里没有"那一种。短词因此**用一条更长的防抖**（400ms vs 120ms）：把"边打边扫"换成"停下来扫一次"，代价与打字速度脱钩。**没有为短词另建索引**——SQLite 没有 bigram tokenizer，而真正的坎不在建索引：`narrative_fts` 的 `ref_id` 是 `UNINDEXED`，拿到它换不回 `(case_id, text)`，一次反查就是一次全扫，比现在还慢。要根治得把正文挪进普通表、`narrative_fts` 改成 `content=` 的 external-content 表，那是搜索层的一次结构重构。

**检索接在历史排查页上**（ui.md §8.3）。两条这一带特有的坑，都是量出来才知道的：

- 🔴 **`ESCAPE` 子句会把 trigram 的 LIKE 优化整个关掉**（`EXPLAIN QUERY PLAN` 从 `INDEX 0:L3` 变成 `INDEX 0:`，罕见词 0.1ms → 5.1ms 且随表增长），所以只在查询串真的含通配符时才带它
- 🔴 **主导成本不是扫描，是把命中全搬回来**：5 万行的表上一个常见词走 MATCH 会搬回 5 万行、30ms **全在 main 线程上**，加了 `LIMIT` 之后 0.2ms——而这条查询是**人每打一个字就跑一次**的同步 IPC

其余落地约束（两条路的分界只此一处、归并在 JS 里做、`INNER JOIN cases` 挡脏索引）在 `db/queries.ts` 的 `searchNarrative` / `searchCases` 上。
