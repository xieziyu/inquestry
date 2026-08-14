/**
 * 报告章节的组装：形态决定装哪几块（D25 / overview.md §6.1.1）。
 *
 * **纯函数，报告屏与两种导出共用这一份**（ui.md §7）：Markdown 与长图只是换个渲染目标，
 * 章节的取舍与顺序不该各写一遍——写两遍的结果必然是导出的那份与屏幕上的那份对不上，
 * 而报告是这个工具唯一交出去的东西。
 *
 * **这里不挑根因。** 选择器只有 `queries.reportSections()` 那一条，结论由 `rootCause` 带进来。
 * 在这儿再挑一次的后果见 data-model.md：报告的结构与内容会指着两条不同的根因，且毫无报错。
 */

import type { CaseMeta, IncidentEntry, ReportStepRef, Snapshot, StepNode, VerdictShape } from './ipc.js';

/**
 * 五种形态的文案。**确认条与报告屏共用**：人在确认条上按的是「主体是什么」，
 * 报告屏上就该看到同一句话，两处各写一份的话，选的时候说的和装出来的会对不上。
 */
export const SHAPE_COPY: Record<VerdictShape, { label: string; when: string; body: string }> = {
  sequence: { label: '时序型', when: '顺序 / 竞态错了', body: '系统时间线' },
  state: { label: '状态型', when: '某个东西一直就是错的', body: '应然 / 实然对照' },
  chain: { label: '因果链型', when: '一处变更连锁放大', body: '因果链 + 最弱一环' },
  distribution: { label: '分布型', when: '问题只在某一小撮上', body: '归因切分' },
  open: { label: '未决型', when: '没查出来', body: '排除矩阵 + 遗留问题' },
};

export type ChainLink = {
  stepId: string;
  ordinal: number;
  sessionIndex: number;
  direction: string | null;
  verdict: string | null;
  confidence: number | null;
  /** 这一环就是报告认定的根因。链条的末端，不是"最重要的一环"。 */
  isRoot: boolean;
};

/** `claims` 连证据 id 一起带：导出要给每一条挂脚注（ui.md §7.1），只有文本就对不上索引。 */
export type SplitGroup = {
  actor: string;
  count: number;
  claims: { evidenceId: string; claim: string }[];
};

export type ReportBody =
  | { kind: 'verdict'; text: string; confidence: number | null }
  | { kind: 'contrast'; expected: string | null; actual: string | null }
  | { kind: 'timeline'; rows: IncidentEntry[] }
  | { kind: 'chain'; links: ChainLink[]; weakestId: string | null }
  | { kind: 'split'; groups: SplitGroup[]; expected: string | null; actual: string | null }
  | { kind: 'matrix'; rows: ReportStepRef[] }
  | { kind: 'path'; rows: StepNode[] }
  | { kind: 'notes'; rows: ReportStepRef[] }
  | { kind: 'prose'; text: string | null }
  /** 这一节**故意**是空的，且写出为什么。缺席写出来比整节消失可信（overview.md §6.1.1）。 */
  | { kind: 'absent'; why: string };

export type ReportSection = {
  /** 锚点 id，同时是导出时的稳定键。**同一 id 在一份报告里只出现一次**，见 `dedupe`。 */
  id: string;
  title: string;
  /** 右侧那行「这一节哪来的」。把 D17「报告是投影」变成读者能自己验证的承诺（ui.md §6）。 */
  source: string;
  body: ReportBody;
};

export type ReportInput = {
  case: CaseMeta;
  /** 冻结的那个形态；还没收尾时是推断出来的预览值，由 `reportInput()` 挑。 */
  shape: VerdictShape;
  /** 形态已经冻住了没有。false = 这份报告只是按当前数据的预览，还会变。 */
  frozen: boolean;
  steps: StepNode[];
  incident: IncidentEntry[];
  report: Snapshot['report'];
};

export type ReportPlan = {
  shape: VerdictShape;
  frozen: boolean;
  /**
   * stepId → 读者看得见的编号。**`ordinal` 是会话内序号，一次排查重开一次就从 1 重来**，
   * 直接印的话跨会话的报告里会有两个 `#1`，而"被 stX 推翻"这类引用也就无处可对。
   * 多会话时带上会话号（`S2#1`），单会话时保持 `#N` 不加噪声。
   *
   * 报告是冻住的文档，不受工作区那条"序号不许回头改写"的约束（[ui] §3）——
   * 那一条防的是实时图里已读节点位移，这里没有实时。
   */
  labels: Record<string, string>;
  /**
   * 全案证据数，页脚水印用（[ui] §7.2）。**不是系统时间线的条数**：
   * 后者只留了带时间戳的那些，拿它当总数会把报告的证据量报少。
   */
  evidenceCount: number;
  /**
   * 归档的半程报告顶上那句「排查在第 N 步被人为终止」（ui.md §8.4）。
   * 其余一律为 null——它是**人为放弃**的标记，不是"步数"这个中性事实。
   */
  abortedAt: number | null;
  sections: ReportSection[];
};

const TITLES: Record<string, string> = {
  verdict: '根因',
  timeline: '系统时间线',
  contrast: '应然 / 实然',
  chain: '因果链',
  split: '归因切分',
  matrix: '排除矩阵',
  impact: '影响面',
  path: '排查路径',
  leftover: '遗留问题',
  fix: '修复建议',
};

/** 报告屏与导出都从快照进来，形态怎么挑只此一处。 */
export function reportInput(snap: Snapshot): ReportInput | null {
  if (!snap.case) return null;
  return {
    case: snap.case,
    // 收尾那一下才落形态；在那之前照推断值预览——预览与冻结之后装的是同几块，
    // 人于是在按下不可逆那一下之前就见过这份报告长什么样
    shape: snap.case.verdictShape ?? snap.shapeSuggestion.shape,
    frozen: snap.case.verdictShape !== null,
    steps: snap.steps,
    incident: snap.incident,
    report: snap.report,
  };
}

export function reportPlan(input: ReportInput): ReportPlan {
  const { shape, report } = input;
  const sections: ReportSection[] = [];

  /**
   * **未决型没有根因栏，哪怕库里正躺着一条已证实的结论**（ui.md §8.4）。
   * 归档强制未决型，而被归档的排查多半已经查出了点什么——按"有就装"写的话，
   * 半程报告会顶着一条根因，而它明写的是"没查出来"。
   */
  if (shape !== 'open' && report.rootCause) {
    sections.push(
      sec('verdict', '投影 · 置信度最高的那条已证实结论', {
        kind: 'verdict',
        text: report.rootCause.text,
        confidence: report.rootCause.confidence,
      }),
    );
  }

  sections.push(...mainBody(input));
  // 四块在所有形态里都出现（overview.md §6.1.1）。未决型把遗留问题提成了主体，
  // 于是它在这儿会撞上——**同一节不装两遍**，位置以先出现的那次为准
  sections.push(
    sec('impact', '投影 · 影响面 step 的结论', { kind: 'prose', text: report.impact }),
    sec('path', '投影 · step 树，含走错的分支', { kind: 'path', rows: input.steps }),
    sec('leftover', '投影 · 未查清的 step', { kind: 'notes', rows: report.leftovers }),
    // 四栏里唯一没有投影来源的一块：`close_step` 的 `remediation`，取最新一条仍然成立的声明
    sec('fix', 'agent 生成 · 挂在给出判断的那一步上', { kind: 'prose', text: report.remediation }),
  );

  return {
    shape,
    frozen: input.frozen,
    labels: stepLabels(input.steps),
    evidenceCount: input.steps.reduce((n, s) => n + s.evidence.length, 0),
    abortedAt: input.case.status === 'aborted' ? input.steps.length : null,
    sections: dedupe(sections),
  };
}

/** 形态的主体块。**「不投影」那一列同样是规则**：有数据也不装，装了就稀释掉真正该看的对照。 */
function mainBody(input: ReportInput): ReportSection[] {
  const { report } = input;
  switch (input.shape) {
    case 'sequence':
      return [sec('timeline', '投影 · ORDER BY occurred_at_ms', { kind: 'timeline', rows: input.incident })];
    case 'state':
      return [
        sec('contrast', 'agent 填写 · 挂在根因那一步', {
          kind: 'contrast',
          expected: report.expected,
          actual: report.actual,
        }),
        // 状态型**显式写出为什么没有系统时间线**，而不是默默少一节（overview.md §6.1.1）
        sec('timeline', '——', {
          kind: 'absent',
          why: '状态型故障没有"事发瞬间"：它一直就是错的，直到被发现。硬排一条时间线只会得到「某天变更、某天发现」两行，还会把真正该看的应然 / 实然对照挤到后面去。',
        }),
      ];
    case 'chain':
      return [sec('chain', '投影 · 已证实的 step 按先后', chainBody(input))];
    case 'distribution':
      return [
        sec('split', '投影 · 证据按 actor 归组', {
          kind: 'split',
          groups: splitGroups(input.steps),
          expected: report.expected,
          actual: report.actual,
        }),
      ];
    case 'open':
      return [
        sec('matrix', '投影 · 被推翻的 step', { kind: 'matrix', rows: report.refuted }),
        sec('leftover', '投影 · 未查清的 step', { kind: 'notes', rows: report.leftovers }),
      ];
  }
}

/**
 * 因果链：已证实的排查 step 按先后串起来，**在根因那一步收束**。
 *
 * 根因之后那些已证实的结论是另一件事，不是这条链上的一环——不截断的话根因会出现在链条中间，
 * 而这一节的整个意思就是"一路推到这里"。它们没有丢，排查路径那一节照旧全列。
 *
 * ⚠️ 库里**没有真正表达因果关系的字段**（`parent_step_id` 说的是"在这一步之下细分"，不是"由它引起"），
 * 所以这条链的先后取的是排查先后，不是因果先后。并行分支上的已证实结论仍会被串进来。
 * 拿 `parent_step_id` 当因果用是在编一个数据里没有的东西，宁可不编。
 *
 * 最弱一环取置信度最低的那一环——它是这条链上最先该被追问的地方。
 * 一条都没标置信度时**不给最弱一环**，而不是随手指一个：没有依据的"最弱"比没有更糟。
 */
function chainBody(input: ReportInput): ReportBody {
  const rootId = input.report.rootCause?.stepId ?? null;
  const confirmed = input.steps.filter((s) => s.kind === 'normal' && s.status === 'confirmed');
  // 认不出根因就整条都留着。**这个兜底方向是有意的**：截空的话主体块会是空的，
  // 而"根因不在已证实的普通 step 里"本就只有一种可能——压根没有根因（未决型走不到这儿）
  const end = rootId ? confirmed.findIndex((s) => s.id === rootId) : -1;
  const links: ChainLink[] = (end >= 0 ? confirmed.slice(0, end + 1) : confirmed)
    .map((s) => ({
      stepId: s.id,
      ordinal: s.ordinal,
      sessionIndex: s.sessionIndex,
      direction: s.direction,
      verdict: s.verdict,
      confidence: s.confidence,
      isRoot: s.id === rootId,
    }));
  const scored = links.filter((l) => l.confidence !== null);
  const weakest = scored.length
    ? scored.reduce((a, b) => (b.confidence! < a.confidence! ? b : a))
    : null;
  return { kind: 'chain', links, weakestId: weakest?.stepId ?? null };
}

/**
 * 归因切分：证据按 `actor` 归组，多的排前面——分布型要看的正是"问题压在谁身上"。
 *
 * 取的是**所有**证据，不是系统时间线那一份：后者只留了带时间戳的，
 * 而"只在某一小撮上"这件事与有没有时间戳无关，按它切会凭空少掉一批。
 * 被推翻的 step 提供的证据照样在列——结论可以被推翻，事实不会。
 */
function splitGroups(steps: StepNode[]): SplitGroup[] {
  const by = new Map<string, SplitGroup>();
  for (const s of steps) {
    for (const e of s.evidence) {
      const actor = e.actor?.trim() || '未标注';
      const g = by.get(actor) ?? { actor, count: 0, claims: [] };
      g.count += 1;
      if (g.claims.length < 6) g.claims.push({ evidenceId: e.id, claim: e.claim });
      by.set(actor, g);
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.actor.localeCompare(b.actor));
}

/**
 * 只有真的跨了会话才加 `S{n}` 前缀：单会话的排查是绝大多数，
 * 给每一行都挂个恒等于 `S1` 的前缀只是噪声。
 */
function stepLabels(steps: StepNode[]): Record<string, string> {
  const multi = new Set(steps.map((s) => s.sessionIndex)).size > 1;
  const out: Record<string, string> = {};
  for (const s of steps) out[s.id] = multi ? `S${s.sessionIndex}#${s.ordinal}` : `#${s.ordinal}`;
  return out;
}

function sec(id: string, source: string, body: ReportBody): ReportSection {
  return { id, title: TITLES[id]!, source, body };
}

/** 先出现的那次为准：主体块的位置是形态定的，通用四块只是兜底补齐。 */
function dedupe(sections: ReportSection[]): ReportSection[] {
  const seen = new Set<string>();
  return sections.filter((s) => !seen.has(s.id) && (seen.add(s.id), true));
}
