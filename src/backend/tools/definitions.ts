/**
 * 工具定义：schema + 「怎么把结果说给 agent 听」。
 *
 * **传输无关**（agent-backends.md §2.1 / D20 纪律 3）：这里不 import 任何 backend 类型，
 * SDK MCP 与 HTTP MCP 只是两个 adapter，挂的是同一组定义。
 */

import type { z } from 'zod';
import {
  askOperatorShape,
  closeStepShape,
  openStepShape,
  type AskOperatorArgs,
  type CloseStepArgs,
  type OpenStepArgs,
} from './schemas.js';

export interface InvestigationStore {
  openStep(args: OpenStepArgs): Promise<{ stepId: string; ordinal: number; warnings: string[] }>;
  /** warnings 会原样回给 agent —— 缺证据、缺 occurredAt 这类问题要当场说，事后补不回来。 */
  closeStep(args: CloseStepArgs): Promise<{ warnings: string[] }>;
  askOperator(args: AskOperatorArgs): Promise<{
    answer: string;
    /** 人执行前改过的语句。必须回传，否则 agent 学不到真实 schema（overview §5.1①）。 */
    statement: string;
    executedAt?: string;
  }>;
}

export interface ToolDef {
  name: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  /** args 已由 MCP 层按 shape 校验过，adapter 只负责转发。 */
  run(store: InvestigationStore, args: Record<string, unknown>): Promise<string>;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'open_step',
    description:
      '开始一个新的排查方向。**动手查之前先调它**——它是你把意图说出来的地方，' +
      '人要靠它决定是否介入。之后的所有工具调用会自动归到这一步下面，你不需要复述它们的输出。',
    shape: openStepShape,
    async run(store, args) {
      const r = await store.openStep(args as unknown as OpenStepArgs);
      const head = `step #${r.ordinal} 已开启，stepId=${r.stepId}。接下来的工具调用会自动归属到它下面。`;
      return r.warnings.length ? `${head}\n\n注意：\n${r.warnings.map((w) => `- ${w}`).join('\n')}` : head;
    },
  },
  {
    name: 'close_step',
    description:
      '给当前方向下结论并收口。结论必须挂上证据：证据的原文已经在库里了，' +
      '你只要指出「在第几次调用的哪几行」以及「它描述的事件何时发生」。' +
      '这一步若给出了整个案子的根因，顺手填 shape（报告按它装块）与 remediation（该怎么修）；' +
      '若根因是「某个东西一直就是错的」，再补上 expected / actual 这一对。' +
      '同一步再 close 一次（比如按提示补证据、或只补 remediation）时，' +
      '这四项不重填就保持原样，要改就重新填。',
    shape: closeStepShape,
    async run(store, args) {
      const a = args as unknown as CloseStepArgs;
      const { warnings } = await store.closeStep(a);
      const head = `step ${a.stepId} 已关闭（${a.status}），收到 ${a.evidence.length} 条证据。`;
      return warnings.length ? `${head}\n注意：\n- ${warnings.join('\n- ')}` : head;
    },
  },
  {
    name: 'ask_operator',
    description:
      '请人工执行一条你无权直连的查询（生产库 / Redis / 任何写操作）并回填结果。' +
      '会阻塞到人回复为止，所以**把需要人跑的查询攒成一批再逐条发**，不要一条一条来回。',
    shape: askOperatorShape,
    async run(store, args) {
      const a = args as unknown as AskOperatorArgs;
      const r = await store.askOperator(a);
      const changed = r.statement !== a.statement;
      return [
        changed ? `⚠️ 人把语句改成了：\n${r.statement}\n（按这个真实 schema 写后续查询）` : null,
        r.executedAt ? `执行时间：${r.executedAt}` : null,
        '结果：',
        r.answer,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
];
