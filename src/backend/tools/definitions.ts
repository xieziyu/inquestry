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
    /**
     * 人把结果贴回来的时刻，由 harness 自己盖（`localStamp`）。
     * **不是语句真正执行的时刻**，也不问人要——那个数没有可验的来源，
     * 而这个数至少是真的，够把这条证据排进时间线。
     *
     * 超时作废、被停止散掉这两条路径上没有人贴过任何东西，所以是选填的。
     */
    filledAt?: string;
    /**
     * 人拒绝执行这一条（他自己也没权限、或这条不该在生产上跑）。
     * `answer` 此时是拒绝理由，**可为空**——理由是选填的。
     */
    declined?: boolean;
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
      '这一步若给出了整个调查的根因，顺手填 shape（报告按它装块）；' +
      '若根因是「某个东西一直就是错的」，再补上 expected / actual 这一对。' +
      '同一步再 close 一次（比如按提示补证据）时，' +
      'shape / expected / actual / remediation 不重填就保持原样，要改就重新填。',
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
      '会阻塞到人回复为止，所以**把需要人跑的查询攒成一批再逐条发**，不要一条一条来回。' +
      '人也可能拒绝执行（他自己也没权限、或这条不该在生产上跑），回复里会说清是拒绝还是结果。',
    shape: askOperatorShape,
    async run(store, args) {
      const a = args as unknown as AskOperatorArgs;
      const r = await store.askOperator(a);
      // 拒绝要与「跑了但没数据」当场分开：混作一谈的话，下一步推理会把一次没发生的查询
      // 当成一条阴性结论用。也要挡住原样再问一遍——人的拒绝不会因为再问一次而变
      if (r.declined) {
        const why = r.answer.trim();
        return [
          `⛔ 人没有执行这一条${why ? `：${why}` : '，也没说为什么（多半是他自己也没这个权限）'}`,
          '这不是查询结果为空：换个你自己够得到的来源，或者换个方向，别把同一条再发一遍。',
        ].join('\n');
      }
      // 语句不回传：卡上是只读的，人要改是在自己的客户端里改（见 `PendingCard`）。
      // 字段名写错这类事因此只能由人在结果里说一句，而结果是原样喂回去的。
      return [r.filledAt ? `回填时间：${r.filledAt}` : null, '结果：', r.answer].filter(Boolean).join('\n');
    },
  },
];
