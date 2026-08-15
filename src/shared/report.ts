/**
 * 报告章节的组装：形态决定**哪一块排最前**，其余块各按自己的门槛补（D25 / overview.md §6.1.1）。
 *
 * **纯函数，报告屏与两种导出共用这一份**（ui.md §7）：Markdown 与长图只是换个渲染目标，
 * 章节的取舍与顺序不该各写一遍——写两遍的结果必然是导出的那份与屏幕上的那份对不上，
 * 而报告是这个工具唯一交出去的东西。
 *
 * **这里不挑根因。** 选择器只有 `queries.reportSections()` 那一条，结论由 `rootCause` 带进来。
 * 在这儿再挑一次的后果见 data-model.md：报告的结构与内容会指着两条不同的根因，且毫无报错。
 */

import type {
  CaseMeta,
  ClosingStepKind,
  IncidentEntry,
  ReportStepRef,
  Snapshot,
  StepNode,
  VerdictShape,
} from './ipc.js';

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

/**
 * 形态是谁定的。**人不再选之后这个信号反而更要紧**：`inferred` 说的是"没人判断过，
 * harness 按现有数据兜的底"，读报告的人凭它决定信到什么程度。
 * 冻住之后一律 `frozen`——那时实时建议早就换过好几轮，拿它当出处会说出一句不属于这份报告的话。
 */
export type ShapeSource = 'frozen' | 'agent' | 'inferred';

/**
 * 形态是谁定的，印在纸头 / Markdown 元信息那一行。**长图与 Markdown 共用这一份**，
 * 理由同 `SHAPE_COPY`：各写一份的话两种导出迟早说出两句不一样的话。
 *
 * 三档不能合成一句：`inferred` 说的是"没人判断过，harness 按现有数据兜的底"，
 * 而读的人正是凭这句决定这个形态信到什么程度。
 */
export const SHAPE_SOURCE_COPY: Record<ShapeSource, string> = {
  // 「收尾」而不是「定稿」：归档同样落形态（强制 `open`），说成定稿等于替一次明写的放弃改口
  frozen: '收尾时冻住的',
  agent: 'agent 声明的',
  inferred: '没人声明过，按现有数据推的',
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
  body: ReportBody;
};

export type ReportInput = {
  case: CaseMeta;
  /** 冻结的那个形态；还没收尾时是推断出来的预览值，由 `reportInput()` 挑。 */
  shape: VerdictShape;
  shapeSource: ShapeSource;
  /** 形态已经冻住了没有。false = 这份报告只是按当前数据的预览，还会变。 */
  frozen: boolean;
  steps: StepNode[];
  incident: IncidentEntry[];
  report: Snapshot['report'];
};

export type ReportPlan = {
  shape: VerdictShape;
  shapeSource: ShapeSource;
  /**
   * 形态承诺的那一块真的装出来了没有。**纸头那行字靠它决定说不说「最前是 X」**——
   * 装不出来还照说的话，读者会先读到一句承诺、紧接着读到同一块在解释自己为什么不在。
   *
   * 这不是异常路径：一次只有一条已证实结论的调查，`suggestVerdictShape()` 会推 `chain`，
   * 而五种形态的主体这时一个都装不出来（时间线不足两条、没有应然实然、链不足两环）。
   * 那样的报告仍旧是完整的——根因加通用四块，只是没有"重点"这一块。
   */
  mainAssembled: boolean;
  frozen: boolean;
  /**
   * stepId → 读者看得见的编号。**`ordinal` 是会话内序号，一次调查重开一次就从 1 重来**，
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
   * 归档的半程报告顶上那句「调查在第 N 步被人为终止」（ui.md §8.4）。
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

/**
 * 报告屏与两种导出都从快照进来，形态怎么定只此一处。
 *
 * **形态是 agent 的判断，不是人的选择**（D25）。一度在这儿收一个 `pick` 参数，
 * 让人在纸头上五选一，已推翻：那次判断要人读完整个排查过程才做得了，而最清楚过程的是 agent。
 * 现在这里只做一件事——冻住的那个盖过实时建议，因为定稿之后没有入口再改，
 * 让实时值盖住的话，屏上会显示一份与库里不同的报告。
 */
export function reportInput(snap: Snapshot): ReportInput | null {
  if (!snap.case) return null;
  const frozen = snap.case.verdictShape !== null;
  return {
    case: snap.case,
    // 收尾那一下才落形态；在那之前照建议值预览——预览与冻结之后装的是同几块，
    // 于是在按下不可逆那一下之前就见过这份报告长什么样
    shape: snap.case.verdictShape ?? snap.shapeSuggestion.shape,
    shapeSource: frozen ? 'frozen' : snap.shapeSuggestion.source,
    frozen,
    steps: snap.steps,
    incident: snap.incident,
    report: snap.report,
  };
}

/**
 * 这份报告到底**装不装**根因栏。
 *
 * **未决型没有根因栏，哪怕库里正躺着一条已证实的结论**（ui.md §8.4）。归档强制未决型，
 * 而被归档的调查多半已经查出了点什么——按"有就装"写的话，半程报告会顶着一条根因，
 * 而它明写的是"没查出来"。
 *
 * 单拎成一个函数是因为**工作区的尾卡也要按这一条判**（`tailSummary`）。各写一遍的话，
 * 舞台上那张卡会给一条报告里根本不印的根因，两个屏于是指着两个不同的结论——
 * 而这正是 `reportPlan` 顶上那段"不在这儿再挑一次"要防的事，只是换了个屏。
 */
export function reportedRootCause(input: ReportInput): ReportInput['report']['rootCause'] {
  return input.shape === 'open' ? null : input.report.rootCause;
}

export function reportPlan(input: ReportInput): ReportPlan {
  const { report } = input;
  const sections: ReportSection[] = [];

  const root = reportedRootCause(input);
  if (root) {
    sections.push(
      sec('verdict', {
        kind: 'verdict',
        text: root.text,
        confidence: root.confidence,
      }),
    );
  }

  const body = mainBody(input);
  sections.push(...body);
  // 四块在所有形态里都出现（overview.md §6.1.1）。未决型把遗留问题提成了主体，
  // 于是它在这儿会撞上——**同一节不装两遍**，位置以先出现的那次为准
  sections.push(
    sec('impact', { kind: 'prose', text: report.impact }),
    sec('path', { kind: 'path', rows: input.steps }),
    sec('leftover', { kind: 'notes', rows: report.leftovers }),
    // 四栏里唯一没有投影来源的一块：`close_step` 的 `remediation`，取最新一条仍然成立的声明
    sec('fix', { kind: 'prose', text: report.remediation }),
  );

  return {
    shape: input.shape,
    shapeSource: input.shapeSource,
    // 主体那几块里但凡有一块落成了 `absent`，形态承诺的东西就没有全兑现
    mainAssembled: MAIN_BLOCKS[input.shape].every(
      (id) => body.find((s) => s.id === id)?.body.kind !== 'absent',
    ),
    frozen: input.frozen,
    labels: stepLabels(input.steps),
    evidenceCount: input.steps.reduce((n, s) => n + s.evidence.length, 0),
    abortedAt: input.case.status === 'aborted' ? input.steps.length : null,
    sections: dedupe(sections),
  };
}

/**
 * 主体块的 id：形态挑的就是这几个之一。`leftover` 不在其中——它是通用四块之一，
 * 未决型只是把它提前，不需要门槛。
 */
type BodyId = 'timeline' | 'contrast' | 'chain' | 'split' | 'matrix';

/**
 * 形态决定**哪一块排最前**，不决定哪几块不许出现（D25 / overview.md §6.1.1）。
 *
 * 一度是后者（每种形态硬丢掉另外几块），已推翻：硬丢的代价是 agent 判错一次就少一整块，
 * 而定稿不可逆。现在判错的代价降成"重点排错了序"——时序型的调查里 agent 写了 chain，
 * 时间线不会消失，只是排在因果链后面。
 */
const MAIN_BLOCKS: Record<VerdictShape, readonly BodyId[]> = {
  sequence: ['timeline'],
  state: ['contrast'],
  chain: ['chain'],
  distribution: ['split'],
  open: ['matrix'],
};

/** 非主体块补在主体之后的固定顺序：发生了什么 → 本该怎样 → 怎么连锁 → 排除了什么。 */
const BODY_ORDER: readonly BodyId[] = ['timeline', 'contrast', 'chain', 'split', 'matrix'];

/**
 * 主体块装不出来时那句话。**只有主体块缺席要写出来**——它是形态承诺的那一块，
 * 默默少掉的话，报告顶上说着"按 X 装"而 X 的主体不在。
 * 非主体块缺席就静静隐藏，那本来就是"有则展示、无则隐藏"的另一半。
 */
const ABSENT_WHY: Record<BodyId, string> = {
  timeline:
    '这份报告按时序型装，主体本该是系统时间线，但带时间戳的证据不足两条——两条以下排不出"顺序"，那一块会是一行孤零零的记录。',
  contrast:
    '这份报告按状态型装，主体本该是应然 / 实然对照，但根因那一步没有成对地给出这两项。那一步已经收口了，这一块补不回来。',
  chain: '这份报告按因果链型装，但根因之前只有一条已证实的结论，串不成一条链——它要说的话根因那一栏已经说完了。',
  // ⚠️ 门槛是**分不分得出两组**，不是"有没有标 actor"：证据全都规规矩矩标着同一个 actor 时
  // 同样只有一组。按"没标注"写的话，读的人会去补一份本来就不缺的数据
  split:
    '这份报告按分布型装，主体本该是归因切分，但全部证据只归得出一组主体，切不出可对照的另一撮——"问题只压在某一小撮上"这句话于是没有依据。',
  matrix: '没查出根因，也没有哪个方向被明确排除掉。排除矩阵是空的，这份报告能说的只有遗留问题。',
};

/**
 * 章节的主体：形态挑的那一块排最前，其余块各按自己的门槛补上（overview.md §6.1.1）。
 *
 * **门槛不是"有没有数据"，是"装出来说不说得清一件事"。** 一度是纯粹的有数据就装，
 * 已推翻：证据一律要填 `actor`（提示词第 4 条），已证实的 step 也总是有的，
 * 于是归因切分与因果链的原料恒定存在——按"有就装"写的话每份报告都会顶着这两块，
 * 而把十来条证据按 gateway / db / app 分个组，对绝大多数调查说明不了任何事。
 *
 * 🔴 **`split` 是唯一保留"非主体不装"的一块。** 它的门槛数据里没有：证据的 actor 分布
 * 反映的是**agent 查了哪儿**，不是问题压在哪儿——查了 8 次网关、2 次库，
 * 网关那组自然最大，而这与"问题只在某一小撮上"毫无关系。只有 agent 说得出这句话。
 */
function mainBody(input: ReportInput): ReportSection[] {
  const main = MAIN_BLOCKS[input.shape];
  const out: ReportSection[] = main.map((id) => block(id, input) ?? absent(id));
  // 未决型把遗留问题一起提成主体；它没有门槛，通用四块里那一份由 `dedupe` 收掉
  if (input.shape === 'open') out.push(leftoverSection(input));
  for (const id of BODY_ORDER) {
    // 已经在主体里的那几块由 `dedupe` 收掉，不必在这儿再判一次
    if (id === 'split') continue;
    const s = block(id, input);
    if (s) out.push(s);
  }
  return out;
}

/** 一块的门槛与内容。`null` = 门槛没过，这一块装不出来。 */
function block(id: BodyId, input: ReportInput): ReportSection | null {
  const { report } = input;
  switch (id) {
    case 'timeline':
      // 🔴 **两条这个数与 `suggestVerdictShape()` 推 `sequence` 的门槛是同一个**
      // （`backend/store/sqlite-store.ts`）。两边分叉的话，推断出来的时序型会配上一个
      // 装不出主体的报告——而两处都不会报错
      return input.incident.length >= 2
        ? sec('timeline', { kind: 'timeline', rows: input.incident })
        : null;
    case 'contrast':
      // 🔴 **成对才算数，与 `suggestVerdictShape()` 的 `stateFillable` 是同一个判断**
      // （`backend/store/sqlite-store.ts` 用的是 AND）。这里放宽成 `||` 的话，
      // 定稿确认块按 `stateFillable` 说着"这一块装不出来"，而纸上正印着一行
      // 「实际 ——」——两处各自看都自洽，对不上时没有任何报错
      return report.expected && report.actual
        ? sec('contrast', {
            kind: 'contrast',
            expected: report.expected,
            actual: report.actual,
          })
        : null;
    case 'chain': {
      const body = chainBody(input);
      // 一环的"链"不是链，它说的话根因栏已经说完了
      return body.links.length >= 2 ? sec('chain', body) : null;
    }
    case 'split': {
      const groups = splitGroups(input.steps);
      // 一组切不出对照——"只在某一小撮上"要成立，至少得有另一撮
      return groups.length >= 2
        ? sec('split', {
            kind: 'split',
            groups,
            // 干净的那组 / 出问题的那组同样成对才有意义，理由同 `contrast`
            expected: paired(report).expected,
            actual: paired(report).actual,
          })
        : null;
    }
    case 'matrix':
      return report.refuted.length
        ? sec('matrix', { kind: 'matrix', rows: report.refuted })
        : null;
  }
}

/**
 * 应然/实然只有成对才说得出一件事，单边的那一半按没有算。
 * 写入侧只当场 warning、不拒绝（`shapeWarnings()`），所以库里真会躺着单边的。
 */
function paired(report: ReportInput['report']): { expected: string | null; actual: string | null } {
  const ok = !!(report.expected && report.actual);
  return { expected: ok ? report.expected : null, actual: ok ? report.actual : null };
}

function leftoverSection(input: ReportInput): ReportSection {
  return sec('leftover', { kind: 'notes', rows: input.report.leftovers });
}

function absent(id: BodyId): ReportSection {
  return sec(id, { kind: 'absent', why: ABSENT_WHY[id] });
}

/**
 * 因果链：已证实的排查 step 按先后串起来，**在根因那一步收束**。
 *
 * 根因之后那些已证实的结论是另一件事，不是这条链上的一环——不截断的话根因会出现在链条中间，
 * 而这一节的整个意思就是"一路推到这里"。它们没有丢，排查路径那一节照旧全列。
 *
 * ⚠️ 库里**没有真正表达因果关系的字段**（`parent_step_id` 说的是"在这一步之下细分"，不是"由它引起"），
 * 所以这条链的先后取的是调查先后，不是因果先后。并行分支上的已证实结论仍会被串进来。
 * 拿 `parent_step_id` 当因果用是在编一个数据里没有的东西，宁可不编。
 *
 * 最弱一环取置信度最低的那一环——它是这条链上最先该被追问的地方。
 * 一条都没标置信度时**不给最弱一环**，而不是随手指一个：没有依据的"最弱"比没有更糟。
 */
function chainBody(input: ReportInput): Extract<ReportBody, { kind: 'chain' }> {
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
 * 只有真的跨了会话才加 `S{n}` 前缀：单会话的调查是绝大多数，
 * 给每一行都挂个恒等于 `S1` 的前缀只是噪声。
 */
function stepLabels(steps: StepNode[]): Record<string, string> {
  const multi = new Set(steps.map((s) => s.sessionIndex)).size > 1;
  const out: Record<string, string> = {};
  for (const s of steps) out[s.id] = multi ? `S${s.sessionIndex}#${s.ordinal}` : `#${s.ordinal}`;
  return out;
}

function sec(id: string, body: ReportBody): ReportSection {
  return { id, title: TITLES[id]!, body };
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 工作区舞台末端那张**收束卡**要显示的东西（ui.md §3.3）。
 *
 * 它是**投影，不是 agent 新写的一段**——与 D17 同一条：真让 agent 再总结一遍，
 * 就是在报告之外又开了一处会跑偏的叙述。所以这里一个字都不生成，全部从快照里读。
 *
 * 🔴 **卡面要克制。** 结论与证据是报告屏的主角（D21），这张卡回答的只是
 * 「这次调查停在哪儿」。展开成一份迷你报告的话，工作区与报告就成了同一个屏的两份，
 * 而两份迟早对不上——那正是 `reportPlan` 只此一份的理由。
 */
export type TailSummary = {
  status: CaseMeta['status'];
  shape: VerdictShape;
  /** `frozen` = 收尾那一下冻住的；另两档是还会变的建议值（ui.md §8.4.2）。 */
  shapeSource: ShapeSource;
  /** 报告真会印的那条根因（`reportedRootCause`）；null 时读 `why`。 */
  rootCause: { text: string; confidence: number | null } | null;
  /** 没有根因时**写出为什么没有**——缺席写出来比留一块白可信（overview.md §6.1.1 同源）。 */
  why: string;
  /** 定稿闸还差哪几步。分母恒为二，是 §6.2 定死的那两个固定动作，不是"调查进度"。 */
  gaps: ClosingStepKind[];
  leftovers: number;
  hasRemediation: boolean;
};

/**
 * 尾卡出生了没有，以及它这会儿说什么。**null = 还没到该有终点的时候**。
 *
 * 出生条件是「agent 第一次去走定稿前那两个固定动作」，或者调查已经冻结。
 *
 * 🔴 **判据必须单调**，否则尾卡会在结论被推翻时整张消失又出现。所以认的是
 * **`kind` 上曾经开出过 impact / leftover 的 step**（step 一旦落库就不会消失，
 * 推翻只改 `status`），而不是 `closingGaps` 或 `rootCause`——那两者都会往回走：
 * `missingClosingSteps` 判的是当前生效的那一步，影响面被推翻时缺口会重新出现。
 *
 * 反过来说，**调查还在跑的时候画布最低点是旁白，这不是毛病**：agent 刚说出口的那句话
 * 本来就是此刻发生的事。终点落在一句话上只有在"没有下一步了"的时候才是错的。
 */
export function tailSummary(snap: Snapshot): TailSummary | null {
  const input = reportInput(snap);
  if (!input) return null;
  const closing = snap.steps.some((s) => s.kind === 'impact' || s.kind === 'leftover');
  if (!closing && input.case.status === 'open') return null;

  return {
    status: input.case.status,
    shape: input.shape,
    shapeSource: input.shapeSource,
    rootCause: reportedRootCause(input),
    why: whyNoRootCause(input),
    gaps: snap.closingGaps,
    leftovers: snap.report.leftovers.length,
    hasRemediation: !!snap.report.remediation,
  };
}

/**
 * 尾卡上没有根因时那句话。**它要说的是"这份报告实际会装成什么样"**，
 * 所以三档各说各的，不能合成一句。
 *
 * 🔴 **"没有根因" 与 "按未决型装" 是两件事，别当成一件。** 实时那条路上两者现在总是同进同退
 * （`suggestVerdictShape` 没有根因就推 `open`），但**第三档不能因此删掉**：冻住的形态是
 * 定稿那一刻落的库值，它与此刻的根因之间没有任何约束再管着。合成一句的话，
 * 一份冻在 `state`、根因栏因为没有根因而整个不印的报告，会被工作区说成"按未决型装"——
 * 而报告屏上明写着状态型，两边各自看都自洽。
 *
 * 「这会儿」同理只准出现在没冻住的那一档：冻住之后事后没有入口再改，
 * 那句话读起来像还会变。
 */
function whyNoRootCause(input: ReportInput): string {
  // 归档强制未决型（ui.md §8.4），所以它必须排在形态那两档之前——它说的是"人为终止"这件事本身
  if (input.case.status === 'aborted') {
    return '这次调查是人为终止的，半程报告不装根因栏——没查出来就是没查出来。';
  }
  if (input.shape === 'open') {
    return `还没有一条已证实的结论能当根因，报告${input.frozen ? '' : '这会儿'}按未决型装。`;
  }
  return `没有一条已证实的结论能当根因，根因那一栏整个不印；报告其余部分照旧按${SHAPE_COPY[input.shape].label}装。`;
}

/** 先出现的那次为准：主体块的位置是形态定的，通用四块只是兜底补齐。 */
function dedupe(sections: ReportSection[]): ReportSection[] {
  const seen = new Set<string>();
  return sections.filter((s) => !seen.has(s.id) && (seen.add(s.id), true));
}
