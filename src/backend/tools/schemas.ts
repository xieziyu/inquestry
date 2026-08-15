/**
 * 三个工具的输入契约。字段要求由 data-model.md 倒推而来。
 *
 * 这里导出的是 zod **raw shape**（不是 z.object），因为 MCP adapter 两边都要它：
 * SDK 的 `tool()` 收 shape，HTTP MCP server 收 JSON Schema。
 */

import { z } from 'zod';

/** 证据引用。`callRef` 用 step 内的调用序号而非 toolUseId —— 让 agent 抄 uuid 不可靠。 */
export const evidenceItemShape = {
  callRef: z
    .string()
    .describe(
      '这条证据来自本 step 内的第几次工具调用，写 "#1" / "#2"。工具返回的正文开头会标出它自己的编号。',
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

export const closeStepShape = {
  stepId: z.string(),
  status: z
    .enum(['confirmed', 'refuted', 'inconclusive'])
    .describe('假设被证实 / 被推翻 / 没查清。被推翻同样是有价值的结果，不要为了好看写成 confirmed。'),
  verdict: z.string().describe('结论，一到两句。'),
  confidence: z.number().min(0).max(1),
  supersedes: z
    .array(z.string())
    .optional()
    .describe('本步的结论推翻了此前哪些 step，填它们的 id。'),
  shape: z
    .enum(['sequence', 'state', 'chain', 'distribution', 'open'])
    .optional()
    .describe(
      '这是哪一类故障——它决定最终报告装哪几块。**只在这一步给出了整个调查的根因时才填**。' +
        'sequence = 顺序/竞态错了，主体是系统时间线；' +
        'state = 某个东西一直就是错的（配置写错、索引缺失、证书过期），主体是应然/实然对照，没有时间线；' +
        'chain = 一处变更连锁放大，主体是因果链；' +
        'distribution = 问题只出在某一小撮上，主体是归因切分；' +
        'open = 没查出来。填错的代价是报告装出一块空的，宁可不填让人来选。',
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
      '**该怎么修**——最终报告四栏里唯一由你生成的那一块，不填报告里就写「无」。' +
        '在给出根因的那一步填；没查出根因就在汇总遗留问题那一步填「下一步该怎么查、先加哪些观测」。' +
        '写得可执行：改哪个配置 / 加哪个索引 / 谁来做，别写「建议加强监控」这种落不了地的话。' +
        '**这一步的结论被后来的 step 推翻时，这条建议跟着失效**——所以要挂在给出判断的那一步上。',
    ),
  evidence: z
    .array(z.object(evidenceItemShape))
    .describe('结论所依据的证据。status 非 inconclusive 时必须至少一条，否则这个结论无法被复核。'),
};

export const askOperatorShape = {
  engine: z.enum(['mysql', 'postgres', 'redis', 'mongo', 'other']),
  statement: z.string().describe('要人工执行的语句。表名字段名不确定时照写，人会改。'),
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
export type OpenStepArgs = z.infer<z.ZodObject<typeof openStepShape>>;
export type CloseStepArgs = z.infer<z.ZodObject<typeof closeStepShape>>;
export type AskOperatorArgs = z.infer<z.ZodObject<typeof askOperatorShape>>;
