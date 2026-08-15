/**
 * Spike Report —— 验报告章节的组装（D22 / D25 / overview.md §6.1.1）。
 *
 * 纯函数，不碰库也不起会话，因此**不用 rebuild ABI**：跑 `npm run spike:report` 即可。
 *
 * 这一带的错法有两个方向，且都不会报错：
 *
 *   1. **有数据就装**——归档的半程报告明写着"没查出来"却顶着一条根因；每份报告都挂着一节
 *      按 actor 分的归因切分，而那张表说明不了任何事
 *   2. **该装的被硬丢**——形态判错一次就少一整块，而定稿不可逆。所以现在形态只管排序，
 *      取舍交给各块自己的门槛（overview.md §6.1.1）
 *
 * 于是缺席分两种，验的时候别混：**主体块缺席要写出为什么，非主体块缺席就隐藏。**
 *
 * 另一个形状是**自己再挑一次根因**：报告的结构（装哪几块）与内容（印哪条结论）
 * 就此指着两条不同的步，同样毫无报错。所以夹具里投影给的根因**故意不是置信度最高的那条**。
 *
 * 夹具在 `fixtures/report-case.ts`，与 `spike:markdown` 共用：它的每一条都是为了让某个错法
 * 算错（应然/实然填着、时间线有两条、未决型那份带着一条已证实根因），否则"不装"的检查全是空的。
 */

import { EMPTY_SNAPSHOT, VERDICT_SHAPES, type Snapshot } from '../src/shared/ipc.js';
import {
  reportInput,
  reportPlan,
  SHAPE_SOURCE_COPY,
  tailSummary,
  type ReportInput,
} from '../src/shared/report.js';
// 夹具与 spike:markdown 共用一份（`fixtures/report-case.ts`）：章节的取舍与它的渲染是
// 同一条链路的前后两段，各自造一份的话，一边补了字段另一边没补，那边的检查就变成空的
import { reportMarkdown } from '../src/shared/markdown.js';
import { base, FIX_TEXT, incident, report, step, steps } from './fixtures/report-case.js';

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

const ids = (over: Partial<ReportInput>) => reportPlan(base(over)).sections.map((s) => s.id);
const bodyOf = (over: Partial<ReportInput>, id: string) =>
  reportPlan(base(over)).sections.find((s) => s.id === id)?.body;

// ── 形态决定哪一块排最前，其余块按门槛补 ────────────────────────────────

check(
  '未决型没有根因栏，哪怕库里正躺着一条已证实的',
  !ids({ shape: 'open' }).includes('verdict'),
  '归档强制未决型，而被归档的调查多半已经查出了点什么——按"有就装"写的话，半程报告会顶着一条根因，而它明写的是没查出来',
);

check(
  '其余四种都有根因栏',
  VERDICT_SHAPES.filter((s) => s !== 'open').every((s) => ids({ shape: s }).includes('verdict')),
  '连未决型一起砍掉就把结论从报告里抹了',
);

check(
  '未决型的遗留问题只装一次，且排在影响面之前',
  (() => {
    const l = ids({ shape: 'open' });
    return l.filter((i) => i === 'leftover').length === 1 && l.indexOf('leftover') < l.indexOf('impact');
  })(),
  '它在未决型里是主体块，又在通用四块里——不去重就会同一节印两遍，去重时留错那一份则会把主体挪到末尾',
);

check(
  '形态挑的那一块紧跟根因栏排最前',
  (() => {
    const want = { sequence: 'timeline', state: 'contrast', chain: 'chain', distribution: 'split', open: 'matrix' } as const;
    return VERDICT_SHAPES.every((s) => {
      const l = ids({ shape: s });
      // 未决型没有根因栏，主体就是第一块；其余四种排在它后面
      return l[s === 'open' ? 0 : 1] === want[s];
    });
  })(),
  '形态现在只决定顺序（D25）：排错了序，读者得先读完两块不相干的才看到这次故障的解释',
);

check(
  '非主体块照旧按门槛补上，不再被形态硬丢',
  (() => {
    const l = ids({ shape: 'sequence' });
    return l.includes('contrast') && l.includes('chain') && l.includes('matrix');
  })(),
  '夹具里应然实然填着、已证实的环有两条、被推翻的有一条：硬丢的代价是 agent 判错一次就少一整块，而定稿不可逆',
);

check(
  '归因切分只在它是主体时才装',
  (() => {
    const others = VERDICT_SHAPES.filter((s) => s !== 'distribution');
    return ids({ shape: 'distribution' }).includes('split') && others.every((s) => !ids({ shape: s }).includes('split'));
  })(),
  '它的门槛数据里没有——证据的 actor 分布反映的是 agent 查了哪儿，不是问题压在哪儿。夹具切得出两组，所以"按有就装"这个错法在这儿真会算错',
);

// ── 门槛：主体块缺席要写出来，非主体块缺席就隐藏 ──────────────────────────

check(
  '主体块装不出来时留一句说明，且仍在最前',
  (() => {
    // 声明了状态型，而根因那一步没给应然/实然——这一对补不回来，因为那一步已经收口了
    const over = { shape: 'state' as const, report: { ...report, expected: null, actual: null } };
    const l = ids(over);
    const b = bodyOf(over, 'contrast');
    return l[1] === 'contrast' && b?.kind === 'absent' && b.why.length > 0;
  })(),
  '主体是形态承诺的那一块，默默少掉的话纸头写着"按状态型装"而状态型的主体不在。位置也要保住：掉到末尾等于换了一份报告',
);

check(
  '只给了一半的应然实然按没填算，状态型照样落进"装不出来"',
  (() => {
    // 写入侧对单边只 warning、不拒绝，所以库里真会躺着这一半（`shapeWarnings()`）
    const halves = [{ actual: null }, { expected: null }];
    return halves.every((half) => {
      const over = { shape: 'state' as const, report: { ...report, ...half } };
      return bodyOf(over, 'contrast')?.kind === 'absent';
    });
  })(),
  '🔴 与 `suggestVerdictShape()` 的 stateFillable 是同一个判断（那边用 AND）。这边放宽成 || 的话，定稿确认块说着"这一块装不出来"，而纸上正印着一行「实际 ——」——两处各自看都自洽',
);

check(
  '一半的应然实然也不会作为非主体块补进别的形态',
  !ids({ shape: 'chain', report: { ...report, actual: null } }).includes('contrast'),
  '"只有一半的对照说明不了任何事"（提示词里对 agent 就是这么说的），那它也不该因为形态换了就成立',
);

check(
  '归因切分里的干净组 / 出问题组同样成对才印',
  (() => {
    const b = bodyOf({ shape: 'distribution', report: { ...report, actual: null } }, 'split');
    return b?.kind === 'split' && b.expected === null && b.actual === null;
  })(),
  '它是 split 这一块里的一对，不是单独一节——门槛仍旧写在 report.ts 里，别下放到两个渲染器各判一次',
);

/**
 * 只有一条已证实结论的调查：没时间戳、没应然实然，`suggestVerdictShape()` 推到终点档 `chain`，
 * 而五种主体这时一个都装不出来。**这是正常可达的数据形状，不是异常路径。**
 */
const loneRoot = () =>
  base({
    shape: 'chain',
    shapeSource: 'inferred',
    steps: [
      step({ id: 'sx1', status: 'confirmed', confidence: 0.8, evidence: [] }),
      step({ id: 'sx2', kind: 'impact', status: 'confirmed', confidence: 0.7 }),
      step({ id: 'sx3', kind: 'leftover', status: 'inconclusive' }),
    ],
    incident: [],
    report: {
      ...report,
      rootCause: { stepId: 'sx1', text: '就这一步查出来了', confidence: 0.8 },
      expected: null,
      actual: null,
      refuted: [],
    },
  });

check(
  '一条已证实结论的调查：主体装不出来，但报告仍是完整的一份',
  (() => {
    const plan = reportPlan(loneRoot());
    const l = plan.sections.map((s) => s.id);
    return (
      plan.mainAssembled === false &&
      l[0] === 'verdict' &&
      ['impact', 'path', 'leftover', 'fix'].every((k) => l.includes(k))
    );
  })(),
  '推断的终点档是 chain，而链要两环——那种调查本来就没有"重点"这一块，报告是根因加通用四块。别为了凑一个装得出来的去改推断',
);

check(
  '主体装不出来时，纸头不承诺「最前是 X」',
  (() => {
    const md = reportMarkdown(loneRoot(), { generatedAt: 0 });
    return md.includes('这次装不出来') && !md.includes('最前是因果链');
  })(),
  '🔴 承诺一句、紧接着同一块在解释自己为什么不在——两句都出自 harness，读的人只会以为报告坏了',
);

check(
  '主体装得出来时照旧说「最前是 X」',
  reportPlan(base({ shape: 'chain' })).mainAssembled === true,
  '反过来一律说"装不出来"的话，这个标记就是个恒假的摆设，上面那条也就验不出东西',
);

check(
  '归因切分切不出组时，说的是"只归得出一组"，不是"没标注 actor"',
  (() => {
    // 证据全都规规矩矩标着同一个 actor —— 数据一点没缺，只是分不出两组
    const oneActor = steps.map((s) => ({
      ...s,
      evidence: s.evidence.map((e) => ({ ...e, actor: 'gateway' })),
    }));
    const b = bodyOf({ shape: 'distribution', steps: oneActor }, 'split');
    return b?.kind === 'absent' && !b.why.includes('标注') && b.why.includes('一组');
  })(),
  '门槛是分不分得出两组，不是有没有标 actor。按"没标注"写的话，读的人会去补一份本来就不缺的数据',
);

check(
  '归档的报告说形态是"收尾时冻住的"，不说"定稿"',
  (() => {
    const plan = reportPlan(base({ case: { ...base().case, status: 'aborted' }, shape: 'open', shapeSource: 'frozen' }));
    return SHAPE_SOURCE_COPY[plan.shapeSource] === '收尾时冻住的';
  })(),
  '归档同样落形态（强制 open）。说成"定稿时冻住的"，等于替一次明写的放弃改口——工作区那侧早就分开说了（尾卡的「已归档」/「已定稿」）',
);

check(
  '非主体块装不出来就静静隐藏，不留空节也不留说明',
  (() => {
    const over = { shape: 'chain' as const, report: { ...report, expected: null, actual: null, refuted: [] } };
    const l = ids(over);
    return !l.includes('contrast') && !l.includes('matrix');
  })(),
  '"有则展示、无则隐藏"的另一半。每一块缺席都写一句的话，一份报告要顶着四句"这一块没有"',
);

check(
  '时间线不足两条就不装：一行孤零零的记录排不出顺序',
  (() => {
    const one = [incident[0]!];
    // 非主体时隐藏，主体时留说明——同一个门槛，两种缺席方式
    return !ids({ shape: 'chain', incident: one }).includes('timeline')
      && bodyOf({ shape: 'sequence', incident: one }, 'timeline')?.kind === 'absent';
  })(),
  '🔴 两条这个数与 `suggestVerdictShape()` 推 sequence 的门槛是同一个：两边分叉的话，推出来的时序型会配上一个装不出主体的报告，而两处都不报错',
);

check(
  '因果链不足两环就不装：一环的"链"根因栏已经说完了',
  (() => {
    const oneLink = steps.map((s) => (s.id === 'st1' ? { ...s, status: 'open' as const } : s));
    return !ids({ shape: 'state', steps: oneLink }).includes('chain');
  })(),
  '夹具里默认两环（st1 → st4），去掉一环才触发得到这条——否则这个检查是空的',
);

check(
  '归因切分切不出两组就不装，哪怕它是主体',
  (() => {
    const oneActor = steps.map((s) => ({ ...s, evidence: s.evidence.map((e) => ({ ...e, actor: 'svc-a' })) }));
    const b = bodyOf({ shape: 'distribution', steps: oneActor }, 'split');
    return b?.kind === 'absent';
  })(),
  '"只在某一小撮上"要成立，至少得有另一撮。一组的切分是在给一句没有依据的话配一张表',
);

check(
  '通用四块在五种形态里都在',
  VERDICT_SHAPES.every((s) => {
    const l = ids({ shape: s });
    return ['impact', 'path', 'leftover', 'fix'].every((k) => l.includes(k));
  }),
  '影响面 / 排查路径 / 遗留问题 / 修复建议不跟形态走（overview §6.1.1）',
);

check(
  '修复建议装的是 report.remediation，不是恒空',
  VERDICT_SHAPES.every((sh) => {
    const b = bodyOf({ shape: sh }, 'fix');
    return b?.kind === 'prose' && b.text === FIX_TEXT;
  }),
  '这一栏一度写死 text:null，于是五种形态下都印「无」——四栏缺一栏，而且没有任何检查会红',
);

check(
  '修复建议不跟着根因走：未决型与没有根因时照旧装得出来',
  (() => {
    const b = bodyOf({ shape: 'open', report: { ...report, rootCause: null } }, 'fix');
    return b?.kind === 'prose' && b.text === FIX_TEXT;
  })(),
  '跟着根因取的话，归档的半程报告与整个未决型会永远少一栏——而"没查出来，下一步先加哪些观测"正是那种调查最该留下的',
);

check(
  '空的一栏照旧装，只是写"无"',
  (() => {
    const b = bodyOf({ report: { ...report, impact: null } }, 'impact');
    return b?.kind === 'prose' && b.text === null;
  })(),
  '整节消失读起来像"没这回事"；写「无」才是"查过，没有"',
);

check(
  '同一节不会在一份报告里出现两次',
  VERDICT_SHAPES.every((s) => {
    const l = ids({ shape: s });
    return new Set(l).size === l.length;
  }),
  '锚点导航按 id 滚动，重复 id 会让导航跳到第一份而正文在第二份',
);

// ── 排查路径 / 因果链 / 归因切分 ────────────────────────────────────────

check(
  '排查路径含被推翻的那一步',
  (() => {
    const b = bodyOf({}, 'path');
    return b?.kind === 'path' && b.rows.some((r) => r.id === 'st2');
  })(),
  '洗成一路顺利的叙事就是假历史，而"查过哪些方向"正是下一个人最需要的',
);

check(
  '因果链在根因那一步收束，不越过它',
  (() => {
    const b = bodyOf({ shape: 'chain' }, 'chain');
    return b?.kind === 'chain' && b.links.at(-1)?.stepId === 'st4' && b.links.every((l) => l.stepId !== 'st5');
  })(),
  '夹具里 st5 是根因之后才收好的一条已证实结论：不截断的话根因会出现在链条中间，而这一节的整个意思就是"一路推到这里"',
);

check(
  '认不出根因时整条链都留着，不截成空的',
  (() => {
    const b = bodyOf({ shape: 'chain', report: { ...report, rootCause: null } }, 'chain');
    return b?.kind === 'chain' && b.links.length === 3;
  })(),
  '截空的话主体块就是空的——比"链条长了一点"糟得多',
);

check(
  '因果链只收已证实的排查 step',
  (() => {
    const b = bodyOf({ shape: 'chain' }, 'chain');
    return b?.kind === 'chain' && b.links.map((l) => l.stepId).join() === 'st1,st4';
  })(),
  '被推翻的 st2 与影响面 st3 都不是因果链上的一环（st5 在根因之后，由上一条管）',
);

check(
  '最弱一环取置信度最低的，没标置信度的不参与',
  (() => {
    const b = bodyOf({ shape: 'chain' }, 'chain');
    return b?.kind === 'chain' && b.weakestId === 'st4';
  })(),
  'st5 没有置信度：拿它当"最低"就把一条没有依据的判断印成了结论',
);

check(
  '一条置信度都没有时不指最弱一环',
  (() => {
    const bare = steps.map((s) => ({ ...s, confidence: null }));
    const b = bodyOf({ shape: 'chain', steps: bare }, 'chain');
    return b?.kind === 'chain' && b.weakestId === null;
  })(),
  '随手指一个"最弱"比没有更糟：它会被当成下一步该追问的地方',
);

check(
  '因果链的根因认投影给的那一条，不自己按置信度挑',
  (() => {
    const b = bodyOf({ shape: 'chain' }, 'chain');
    return b?.kind === 'chain' && b.links.filter((l) => l.isRoot).map((l) => l.stepId).join() === 'st4';
  })(),
  '夹具里 st1 的置信度更高：自己挑一次的话，链条标的根因与根因栏印的结论会是两步',
);

check(
  '归因切分按全部证据算，不是系统时间线那一份',
  (() => {
    const b = bodyOf({ shape: 'distribution' }, 'split');
    return b?.kind === 'split' && b.groups.map((g) => `${g.actor}:${g.count}`).join() === 'svc-a:2,svc-b:1';
  })(),
  'svc-b 那条没有时间戳、不在系统时间线里——按它算就会凭空少掉一组，而"只在某一小撮上"与有没有时间戳无关',
);

// ── 编号与计数 ────────────────────────────────────────────────────────

check(
  '单会话的调查编号就是 #N，不加会话前缀',
  reportPlan(base()).labels.st1 === '#1',
  '绝大多数调查只有一次会话，给每一行挂个恒等于 S1 的前缀只是噪声',
);

check(
  '跨会话时编号带上会话号，两个 #1 分得开',
  (() => {
    // 第二次会话的 ordinal 从 1 重来——库里就是这么记的（MAX(ordinal) WHERE session_id=?）
    const two = [
      ...steps.slice(0, 2),
      { ...steps[2]!, id: 'st9', sessionId: 'se2', sessionIndex: 2, ordinal: 1 },
    ];
    const l = reportPlan(base({ steps: two })).labels;
    return l.st1 === 'S1#1' && l.st9 === 'S2#1';
  })(),
  'ordinal 是会话内序号：直接印的话跨会话的报告里会有两个 #1，而"被 stX 推翻"这类引用也就无处可对',
);

check(
  '证据数按全案证据算，不是系统时间线的条数',
  reportPlan(base()).evidenceCount === 3,
  '页脚水印写的是"N 条证据可在 Inquestry 溯源"；拿只含带时间戳那份的系统时间线当总数，正式报告会把证据量报少（夹具里 e3 就没有时间戳）',
);

// ── 归档 / 冻结 ────────────────────────────────────────────────────────

check(
  '归档的报告顶上说得出在第几步被终止',
  reportPlan(base({ case: { ...base().case, status: 'aborted' } })).abortedAt === steps.length,
  '半程报告没有根因栏，不说清是人为终止的话，读起来像是查完了什么都没查到',
);

check(
  '定稿的报告没有这句',
  reportPlan(base()).abortedAt === null,
  '定稿是查完了，不是放弃',
);

check(
  '没收尾时用推断的形态，且标明还没冻',
  (() => {
    const snap: Snapshot = {
      ...EMPTY_SNAPSHOT,
      case: { ...base().case, status: 'open', verdictShape: null },
      steps,
      incident,
      report,
      shapeSuggestion: { shape: 'chain', source: 'inferred', rootStepId: 'st4', stateFillable: true },
    };
    const i = reportInput(snap)!;
    return i.shape === 'chain' && !i.frozen;
  })(),
  '预览与冻结之后装的是同几块，人于是在按下不可逆那一下之前就见过报告长什么样',
);

check(
  '收尾之后认冻住的那个形态，不再看推断值',
  (() => {
    const snap: Snapshot = {
      ...EMPTY_SNAPSHOT,
      case: { ...base().case, status: 'aborted', verdictShape: 'open' },
      steps,
      incident,
      report,
      shapeSuggestion: { shape: 'sequence', source: 'agent', rootStepId: 'st4', stateFillable: true },
    };
    const i = reportInput(snap)!;
    return i.shape === 'open' && i.frozen;
  })(),
  '形态是收尾那一下人按下去的判断，事后没有入口再改——这里让推断值盖回去就等于把它改了',
);

// ── 工作区尾卡：与报告同一条规则（ui.md §3.3）────────────────────────────
/**
 * 尾卡的内容全部是投影，而它最容易错的一条恰恰是这一节验的那条：**归档不印根因**。
 * 在舞台上另写一遍判断的话，同一次调查会在工作区顶着一条根因、在报告里写着"没查出来"，
 * 而两个屏各自看都自洽。所以它与 `reportPlan` 共用 `reportedRootCause()`，这里验的是那一点。
 */
{
  const snap = (over: Partial<Snapshot>): Snapshot => ({
    ...EMPTY_SNAPSHOT,
    case: { ...base().case, status: 'open', verdictShape: null },
    steps,
    incident,
    report,
    shapeSuggestion: { shape: 'chain', source: 'agent', rootStepId: 'st4', stateFillable: true },
    closingGaps: [],
    ...over,
  });

  check(
    '一步都没开就没有尾卡',
    tailSummary(snap({ steps: [] })) === null,
    '刚建完的调查在舞台末端挂一张大半是空的卡，等于让它一直跟着主干往下挪，而它这时什么都说不出',
  );

  check(
    '只有普通 step 时仍然没有尾卡（还没开始收尾）',
    tailSummary(snap({ steps: steps.filter((s) => s.kind === 'normal') })) === null,
    '调查在跑的时候画布最低点是旁白，这不是毛病——agent 刚说的那句话本来就是此刻发生的事',
  );

  check(
    'agent 开出影响面 / 遗留问题那一刻，尾卡出生',
    !!tailSummary(snap({})),
    '认的是 kind 上开过 impact/leftover 没有——step 一旦落库就不会消失，判据因此单调',
  );

  /**
   * 🔴 **出生条件必须单调**：认 `closingGaps` 或 `rootCause` 的话，
   * 影响面被推翻、根因被推翻时尾卡会整张消失又出现。
   */
  check(
    '影响面被推翻、闸门缺口重新出现时，尾卡不消失',
    !!tailSummary(snap({ closingGaps: ['impact'] })) &&
      !!tailSummary(snap({ report: { ...report, rootCause: null } })),
    '按 closingGaps / rootCause 判的话，这两下各会让主干末端的卡凭空闪一次',
  );

  check(
    '归档的尾卡不印根因，且写出为什么没有',
    (() => {
      const t = tailSummary(snap({ case: { ...base().case, status: 'aborted', verdictShape: 'open' } }))!;
      return t.rootCause === null && t.why.includes('人为终止') && t.status === 'aborted';
    })(),
    '库里正躺着一条已证实的结论——在舞台上另判一次的话，工作区会顶着一条报告里根本不印的根因',
  );

  check(
    '定稿的尾卡认冻住的那个形态，出处标成 frozen',
    (() => {
      const t = tailSummary(snap({ case: { ...base().case, status: 'closed', verdictShape: 'state' } }))!;
      return t.shape === 'state' && t.shapeSource === 'frozen';
    })(),
    '还会变的预选值与已经冻住的那个是两回事（ui.md §8.4.2）；标错等于替人认了一个判断',
  );

  /**
   * 🔴 **"没有根因"与"按未决型装"是两件事。** 定稿闸只挡影响面与遗留问题两步，
   * 一条已证实的根因都没有照样结得了案，而确认条上五种形态任人选（ui.md §8.4.2：
   * 状态型缺应然/实然时只压暗、不禁用）。合成一句的话，冻在 state 的那份报告
   * 主体是应然/实然对照，尾卡却说按未决型装——两个屏各自看都自洽。
   */
  check(
    '定稿成状态型却没有根因：尾卡说的是它实际装成什么样，不是"按未决型装"',
    (() => {
      const t = tailSummary(
        snap({
          case: { ...base().case, status: 'closed', verdictShape: 'state' },
          report: { ...report, rootCause: null },
        }),
      )!;
      const plan = reportPlan(base({ shape: 'state', report: { ...report, rootCause: null } }));
      const printsRoot = plan.sections.some((s) => s.id === 'verdict');
      return (
        t.rootCause === null &&
        !printsRoot &&
        t.why.includes('状态型') &&
        !t.why.includes('未决型') &&
        !t.why.includes('这会儿')
      );
    })(),
    '报告这时的主体是应然 / 实然对照，只是没有根因栏；「这会儿」同理不能出现在冻住的那一档，它读起来像还会变',
  );

  check(
    '真按未决型冻住时才说未决型，且不带「这会儿」',
    (() => {
      const t = tailSummary(
        snap({
          case: { ...base().case, status: 'closed', verdictShape: 'open' },
          report: { ...report, rootCause: null },
        }),
      )!;
      return t.why.includes('未决型') && !t.why.includes('这会儿');
    })(),
    '定稿成未决型是人按下去的判断，事后没有入口再改',
  );

  check(
    '还没收尾时才带「这会儿」',
    tailSummary(
      snap({
        shapeSuggestion: { shape: 'open', source: 'inferred', rootStepId: null, stateFillable: false },
        report: { ...report, rootCause: null },
      }),
    )!.why.includes('这会儿'),
    '预览这一档形态还会变，说死了等于替人认了一个判断',
  );

  check(
    '没收尾时形态取预选值，出处照实说是 agent 还是推的',
    (() => {
      const a = tailSummary(snap({}))!;
      const b = tailSummary(
        snap({ shapeSuggestion: { shape: 'open', source: 'inferred', rootStepId: null, stateFillable: false } }),
      )!;
      return a.shapeSource === 'agent' && b.shapeSource === 'inferred' && b.rootCause === null;
    })(),
    '推断成未决型时根因栏跟着不印——两处判断是同一条，所以这里顺带守住了它',
  );
}

console.log('\n===== Spike Report 结果 =====');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
