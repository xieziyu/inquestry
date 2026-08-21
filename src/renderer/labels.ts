import type { ChatLine, StepNode } from '../shared/ipc.js';

/**
 * 卡面与浮层共用的那几个枚举 → 中文文案。
 *
 * 自成一个模块是因为舞台与详情浮层都要用它：搭在 `Stage.tsx` 上的话，`StepSheet` 这样的
 * 叶子得反过来运行时导入容器，两边成环——现在能跑只是因为绑定要到渲染那一刻才读。
 */

/** 「补充」而不是「你」：人在这儿说的话语义是**异步入队的补充**（ui.md §8.2），不是聊天。 */
export function sayLabel(role: ChatLine['role']) {
  return ({ assistant: 'agent', user: '补充', system: '系统' } as const)[role];
}

/** 只管 step 的状态。会话那几档由底部状态栏自己说——那儿要分"这一轮"与"这次调查"。 */
export function statusLabel(s: StepNode['status']) {
  return (
    {
      open: '进行中',
      confirmed: '已证实',
      refuted: '已推翻',
      inconclusive: '未查清',
      superseded: '被推翻',
      converged: '已收口',
    } as const
  )[s];
}

/**
 * 徽标。**兜底步要按 `lane` 分派**（同 `directionText`）：舞台上剩下的 `unclassified`
 * 只有支线兜底那一种，把子 agent 的账本标成「未归类」是纯粹的错标——它没有命题不是
 * 因为分类失败，是因为方向由主线收敛回来时才给。主干那种在这儿已经没有出处（不出卡），
 * 留着是因为带证据的老数据还在库里。
 */
export function kindLabel(k: StepNode['kind'], lane: string | null = null) {
  if (k === 'unclassified') return lane ? '支线' : '未归类';
  return ({ normal: '排查', unclassified: '未归类', impact: '影响面', leftover: '遗留问题' } as const)[k];
}
