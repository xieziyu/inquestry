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
  closeStep(args: CloseStepArgs): Promise<{
    warnings: string[];
    /**
     * **这次 close 被整个退回了：一条都没落下，step 原样不动。**
     * 只有硬拒绝那几条路带它（stepId 认不出来、证据里有解析不了的 callRef），正常收尾不带。
     *
     * 回话的头一句按它分派（下面 `close_step` 的 `run`）：不分派的话，agent 读到的是
     * "已关闭、收到 N 条证据" 后面跟一句 "什么都没落下"——两句矛盾时它多半按前一句往下走，
     * 而这一步其实还开着、上一批证据还等着它重发。
     */
    rejected?: true;
    /**
     * 这一步落下的名单**去重之后**有几条；没给名单时不返回。
     *
     * 由 store 回而不是让调用方数 `args.roster.items`：那是归一前的数组，
     * 而报告印的是归一后的那个数。照 args 数的话，回执上那句话会与报告差几条，
     * 且差的正是"抄重了几条"——这一句存在的全部理由就是让 agent 当场发现它。
     */
    rosterCount?: number;
  }>;
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
      '**问的那个问题答案本身是一组东西时（哪些用户 / 哪些订单 / 哪次变更），填 roster**，' +
      '报告会把它印成能整列复制的一列——别再把 id 抄进 verdict 那段散文里。' +
      '量化影响面那一步把数填进 metrics。' +
      '同一步再 close 一次（比如按提示补证据）时，' +
      'shape / expected / actual / remediation / roster / metrics 不重填就保持原样，要改就重新填；' +
      '**evidence 不在这张单子里，它的语义正相反**：带上证据就整份替换上一批，' +
      '上次那些还要留的一并重发，给 `[]` 才是"这次不动证据"；' +
      '有一条 callRef 认不出来则整次 close 退回，一条都不落，改好后整批重发。',
    shape: closeStepShape,
    async run(store, args) {
      const a = args as unknown as CloseStepArgs;
      const { warnings, rosterCount, rejected } = await store.closeStep(a);
      // 退回那条路**换一句头**：这一步没关上、证据一条没落，说成"已关闭、收到 N 条证据"
      // 就是把 agent 引去干别的，而它手里那批证据再也发不出去了
      if (rejected) {
        return `⛔ step ${a.stepId} 没有关闭，这一次一条都没落下。\n原因：\n- ${warnings.join('\n- ')}`;
      }
      // 名单的条数**回给它自己看**：去重之后的那个数才是报告要印的，
      // 而 agent 刚在 verdict 里写过一个按去重前算的条数——两个数对不上时，
      // 这一句是它唯一能当场发现的地方（warning 里另有一条专门说去掉了几条）
      const roster = rosterCount === undefined ? '' : `，名单 ${rosterCount} 条`;
      const head = `step ${a.stepId} 已关闭（${a.status}），收到 ${a.evidence.length} 条证据${roster}。`;
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
