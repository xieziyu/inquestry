/**
 * 三个工具的输入契约。字段要求由 data-model.md 倒推而来。
 *
 * 这里导出的是 zod **raw shape**（不是 z.object），因为 MCP adapter 两边都要它：
 * SDK 的 `tool()` 收 shape，HTTP MCP server 收 JSON Schema。
 */

import { z } from 'zod';
import { DECLARABLE_SHAPES, METRIC_BOUNDS, METRICS_MAX, ROSTER_MAX } from '../../shared/ipc.js';

/**
 * `callRef` 认的几种写法，序号从 1 起：`[call #2]` / `call #2` / `#2` / `2`（大小写与空白宽容）。
 *
 * **`[call #2]` 必须收**：工具正文的行内前缀就是这个格式（`case-runner.ts` 的 PostToolUse），
 * 而提示词让 agent 照抄它——只收 `#2` 的话，一条完全合规的引用会在 zod 那层就被打回去。
 *
 * 方括号配不配对不较真（`2]` 也放行）：那一档没有第二种读法，为它退回一整批不值得。
 * 真正要挡住的是**歧义与越界**，见 `parseCallRef`。
 */
export const CALL_REF_RE = /^\[?\s*(?:call\s*)?#?\s*([1-9]\d*)\s*\]?$/i;

/**
 * `callRef` → 序号；认不出来回 null（调用方据此整批退回这次 close）。
 *
 * 🔴 **必须整串匹配，不能"从串里抽个数字出来"。** 抽数字的写法（`/\d+/`）把 `#0` 读成 0、
 * 把 `#-1` 读成 1——**一个无效引用被解析成一次真实调用**，证据于是挂到了它根本没查过的地方，
 * 而"有坏 ref 就整批退回"那道闸对它完全不响。序号从 1 起也是同一件事：0 不是编号。
 *
 * 🔴 **`isSafeInteger` 不能省。** 一串足够长的数字过得了正则，`Number` 之后是 Infinity 或一个
 * 精度已经丢掉的数，绑给 SQLite 的 OFFSET 会**抛 datatype mismatch**——于是一个坏引用不再是
 * 一次"整批退回"，而是一个异常，agent 拿到的是崩溃而不是那句"改好 callRef 再重发"。
 *
 * 上界不在这儿判（这里不知道那一步有几次调用），由调用方按自己的记录兜住。
 */
export function parseCallRef(ref: string): number | null {
  const m = CALL_REF_RE.exec(String(ref).trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** 证据引用。`callRef` 用 step 内的调用序号而非 toolUseId —— 让 agent 抄 uuid 不可靠。 */
export const evidenceItemShape = {
  callRef: z
    .string()
    // 第一道闸而已：**store 那侧的严格校验不能省**——schema 绕得过去（假 store、重放、别的调用方），
    // 而落库那一步是最后一道
    .regex(
      CALL_REF_RE,
      'callRef 是本 step 内第几次工具调用（序号从 1 起）：照抄正文开头的 "[call #2]"，或只写 "#2"',
    )
    .describe(
      '这条证据来自本 step 内的第几次工具调用。工具返回的正文开头会标出它自己的编号，' +
        '照抄那个 "[call #2]" 或只写 "#2" 都行（序号从 1 起）。',
    ),
  anchor: z
    .string()
    .optional()
    .describe('精确到位置：行号区间如 "12-18"，或 JSON 路径如 "$.hits[3].message"。给不出就留空。'),
  claim: z.string().describe('这条证据说明了什么，一句话。'),
  occurredAt: z
    .string()
    .optional()
    .describe(
      '这条证据描述的事件**真实发生的时间**（不是你查到它的时间）。原样抄日志里的时间串，别自己换算时区。' +
        '日志类证据必须填——系统时间线完全靠它重建。',
    ),
  actor: z.string().optional().describe('谁/哪个组件做的：gateway / db-primary / client / app …'),
};

export const openStepShape = {
  direction: z
    .string()
    .describe(
      '这一步要验证的**假设**，必须是可证伪的命题。' +
        '写「我怀疑主从复制延迟导致重试时读不到刚写入的记录」，' +
        '不要写「我要进一步分析日志」「排查一下数据库」这种无法被推翻的话。',
    ),
  kind: z
    .enum(['normal', 'impact', 'leftover'])
    .optional()
    .describe(
      'normal = 普通排查方向；impact = 定稿前量化影响面的那一步；leftover = 汇总没查清的问题。' +
        '后两者定稿前各需要至少一次。',
    ),
  parentStepId: z.string().optional().describe('若这一步是在某个已有 step 之下细分，填其 id。'),
};

/**
 * 名单：一组同类实体 + 口径（overview.md 的「产出物」）。
 *
 * 🔴 **`complete` 与 `basis` 是这个类型存在的理由，不是修饰。** 一列 id 塞进 verdict 散文里
 * 也能读，先丢的永远是「这是不是全集」——而那句话决定读者敢不敢直接拿它去封号 / 去订正数据。
 * 所以两者都必填：留成可选的话，agent 不写没有任何东西会提醒它，事后也没人看得出来少了什么。
 *
 * 🔴 **展示字段一律 `.trim().min(1)`，不是 `.min(1)`。** 后者对 `"   "` 是放行的（长度是 3），
 * 于是一个"必填"的约束在最常见的绕过方式上恰好不生效——**看着有、其实没有的检查比没有更糟**。
 *
 * 这几条是这个文件里少见的**硬退回**（其余多半只 warning）。分界在于：形态声明在哪一步、
 * remediation 填在哪个 kind，这些是 harness 判不了意图的**语义**问题，只能提醒；
 * 而一个必填串是不是空的没有判断余地，与 `confidence` 的 0..1 同类。
 * 退回的代价也只是一次重发——证据按 step 内调用序号引用（`callRef`），原样再发一次照旧落得进去。
 */
export const rosterShape = {
  label: z
    .string()
    .trim()
    .min(1)
    .describe('这批东西是什么，读者看的那句话：「关联账号」「受影响订单」「引入问题的提交」。'),
  idKind: z
    .string()
    .trim()
    .min(1)
    .describe('id 的种类：userId / orderId / commit / apiKey。印在表头上，读者靠它知道这一列能拿去做什么。'),
  complete: z
    .boolean()
    .describe(
      '这份名单是不是**全集**。拿不准就填 false —— 报告会明写「这是下界，不是全集」。' +
        '**一条也算名单**（「是哪次变更引入的」答案就是一个 commit），不必凑条数。',
    ),
  basis: z
    .string()
    .trim()
    .min(1)
    .describe(
      '口径：这批是**怎么圈出来的**、边界在哪。`complete=false` 时它就是「为什么不全」。' +
        '写「按 userdevices 里 users 数组做两跳设备聚合，换过手机的马甲抓不到」，' +
        '别写「经过分析得出」这种说明不了边界的话。' +
        '**留空或只写空格会被当场退回**——这一条不填，整次 close_step 不算数。',
    ),
  items: z
    .array(
      z.object({
        id: z.string().describe('实体的 id，原样照抄，不要加引号或前缀。'),
        note: z.string().optional().describe('这一条的补充，如「被举报本号」「桥接号」。没有就不填。'),
      }),
    )
    .describe(
      '名单本身。重复的会被去掉并回你一条提醒——手抄一长串 id 最容易在这里出错。' +
        `**超过 ${ROSTER_MAX} 条会被截断**（多出的丢掉、按下界处理，报告上印出截了多少）：` +
        '名单长到那个量级说明它该是一次数据导出，不是一份读给人看的报告——' +
        '换个更窄的口径，或者把范围写进 basis 里只列代表性的那些。',
    ),
};

/**
 * 指标：一个带口径的数（overview.md 的「产出物」）。
 *
 * 🔴 **`bound` 是枚举而不是让你在 `value` 里写 `≥`**，理由同 `rosterShape` 的 `complete`：
 * 「这个数只是下界」是影响面里最重要也最先被磨掉的一句话。
 */
export const metricShape = {
  label: z.string().trim().min(1).describe('这个数是什么：「受害者数」「团伙时间跨度」「存量未封账号」。'),
  value: z
    .string()
    .trim()
    .min(1)
    .describe('值**连单位一起**：`13 / 16`、`375 天`、`2`。不要在这里写 ≥ 或「约」，那是 bound 的事。'),
  bound: z
    .enum(METRIC_BOUNDS)
    .describe(
      'exact = 准数；lower = 这只是下界（真实值只会更大）；upper = 上界。' +
        '日志有保留期、样本只覆盖一段时间、查询做了截断——这几种一律是 lower，别填 exact。',
    ),
  basis: z
    .string()
    .trim()
    .min(1)
    .describe(
      '口径：这个数**覆盖什么范围、怎么算出来的**。`bound` 非 exact 时它就是「为什么只是个界」。' +
        '写「近 30 天，k8s-log 保留期只有这么长，更早的查不到」。' +
        '**留空或只写空格会被当场退回**——这一条不填，整次 close_step 不算数。',
    ),
};

export const closeStepShape = {
  stepId: z.string(),
  status: z
    .enum(['confirmed', 'refuted', 'inconclusive'])
    .describe('假设被证实 / 被推翻 / 没查清。被推翻同样是有价值的结果，不要为了好看写成 confirmed。'),
  verdict: z
    .string()
    .trim()
    .min(1)
    .describe(
      '结论，一到两句。**不能留空**——报告的根因栏、影响面、遗留问题印的都是它，' +
        '空着的话那几节会是视觉上的一片白，而纸上看不出是"没查出来"还是"忘了写"。',
    ),
  confidence: z.number().min(0).max(1),
  supersedes: z
    .array(z.string())
    .optional()
    .describe('本步的结论推翻了此前哪些 step，填它们的 id。'),
  shape: z
    .enum(DECLARABLE_SHAPES)
    .optional()
    .describe(
      '这是哪一类故障——它决定报告把哪一块排在最前。**给出整个调查根因的那一步必须填**，其余步一律留空。' +
        '按这个顺序判，第一个成立的就是它：' +
        'sequence = 顺序 / 竞态错了，先后本身就是解释，主体是系统时间线；' +
        'state = 某个东西一直就是错的（配置写错、索引缺失、证书过期），主体是应然/实然对照，' +
        '选它就必须把 expected / actual 成对填上，那一对就是主体；' +
        'distribution = 问题只压在某一小撮上（某几个租户 / 分片 / 机器），别的同类是干净的，主体是归因切分；' +
        'chain = 其余一切，一处变更连锁放大，主体是因果链。' +
        '**判错不会让报告少一块**（其余块照旧按数据补上），只是重点排错了序——所以别因为拿不准就空着。',
    ),
  expected: z
    .string()
    .optional()
    .describe('**本该是什么**。状态型故障（shape=state）的报告主体就是这一对，与 actual 成对填。'),
  actual: z.string().optional().describe('**实际是什么**。与 expected 成对填。'),
  remediation: z
    .string()
    .optional()
    .describe(
      '**下一步该怎么查、先加哪些观测**——只在没查出根因的调查里填，落在汇总遗留问题' +
        '（kind=leftover）的那一步上；它是未决型报告里唯一由你生成的一块，不填那一栏就写「无」。' +
        '**查出了根因就不要填**：修复方案由动手修的人评估，排查报告只交事实，别的步上填了也不进报告。' +
        '写得可执行：先加哪条观测 / 找谁拿什么权限，别写「建议加强监控」这种落不了地的话。',
    ),
  roster: z
    .object(rosterShape)
    .optional()
    .describe(
      '**这次调查要交的那份名单**——问题的答案本身是一组实体时填它（「排查出关联的小号」' +
        '「哪些订单受影响」「是哪次变更引入的」）。报告会把它排在根因之后印成干净的一列，' +
        '直接复制得走。填在**得出这份名单的那一步**上——只要求那一步 status 是 confirmed，' +
        '**kind 不限**：「受影响的订单」落在量化影响面（kind="impact"）那一步上同样正当，' +
        '不必为它另开一个 normal 步。一次调查只有一份生效：多处声明时取最新那条还成立的。' +
        '**别再把 id 抄进 verdict 里**——那一段是散文，读者复制不走。',
    ),
  metrics: z
    .array(z.object(metricShape))
    // 🔴 **超了就退回，不截断**——与名单相反，理由见 `shared/ipc.ts` 的 `METRICS_MAX`：
    // 这张表是你亲手写的，条数完全由你定，超过这个数说明把明细当成了指标
    .max(METRICS_MAX)
    .optional()
    .describe(
      '影响面的那几个数，**只填在量化影响面的那一步上**（kind="impact"），别处填了不进报告。' +
        '把「影响了多少用户、多长时间窗口」拆成一条条带口径的数，而不是揉进 verdict 那段话里：' +
        `揉进去之后，「这两个数都是下界」这种限定最先被读丢。**最多 ${METRICS_MAX} 条**——` +
        '超过说明你把明细当成了指标，那种东西该进名单（roster）或者干脆不进报告。',
    ),
  evidence: z
    .array(z.object(evidenceItemShape))
    .describe(
      '结论所依据的证据。status 非 inconclusive 时必须至少一条，否则这个结论无法被复核。' +
        '**这是这一步证据的全量，不是增量**：同一步再 close 一次时，这份数组会把上一批整个换掉，' +
        '上次那些还要留下的必须一并重发（`callRef` 是 step 内的调用序号，原样再发一次就落得回去）。' +
        '只补别的字段（比如 remediation）那一次给 `[]`，上一批照旧留着。' +
        '**有一条 callRef 认不出来，这次 close 就整个退回**：一条都不落、这一步原样不动，' +
        '改好之后整批重发（落一半等于把上一批换成半批）。',
    ),
};

export const askOperatorShape = {
  engine: z.enum(['mysql', 'postgres', 'redis', 'mongo', 'other']),
  statement: z.string().describe('要人工执行的语句。人不会替你改——表名字段名猜错了，回来的是数据库的报错。'),
  why: z.string().describe('为什么需要这条 —— 会直接成为节点的 direction。'),
  expect: z
    .string()
    .describe(
      '**你预期看到什么**。先说预期再看结果，看到数据之后再倒推解释是无效的。' +
        '写「预期只有一条 id=X 的记录；若有两条则说明写入路径重复」。',
    ),
  env: z.string().optional().describe('哪个环境/实例，如 prod-replica-1。'),
};

export type EvidenceItem = z.infer<z.ZodObject<typeof evidenceItemShape>>;
export type RosterArg = z.infer<z.ZodObject<typeof rosterShape>>;
export type MetricArg = z.infer<z.ZodObject<typeof metricShape>>;
export type OpenStepArgs = z.infer<z.ZodObject<typeof openStepShape>>;
export type CloseStepArgs = z.infer<z.ZodObject<typeof closeStepShape>>;
export type AskOperatorArgs = z.infer<z.ZodObject<typeof askOperatorShape>>;
