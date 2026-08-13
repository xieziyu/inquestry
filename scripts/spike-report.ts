/**
 * Spike Report —— 验报告章节的组装（D22 / D25 / overview.md §6.1.1）。
 *
 * 纯函数，不碰库也不起会话，因此**不用 rebuild ABI**：跑 `npm run spike:report` 即可。
 *
 * 这一带的错法有个共同形状：**"有数据就装"**。它一条都不会报错，装出来的报告看着还更完整——
 *
 *   1. 归档的残报告明写着"没查出来"，却顶着一条根因（库里确实躺着一条已证实的）
 *   2. 时序型把应然/实然也一并印上，把该看的时间顺序挤到后面
 *   3. 状态型默默少一节时间线，读者不知道是没有还是漏了
 *
 * 另一个形状是**自己再挑一次根因**：报告的结构（装哪几块）与内容（印哪条结论）
 * 就此指着两条不同的步，同样毫无报错。所以夹具里投影给的根因**故意不是置信度最高的那条**。
 *
 * 夹具在 `fixtures/report-case.ts`，与 `spike:markdown` 共用：它的每一条都是为了让某个错法
 * 算错（应然/实然填着、时间线有两条、未决型那份带着一条已证实根因），否则"不装"的检查全是空的。
 */

import { EMPTY_SNAPSHOT, VERDICT_SHAPES, type Snapshot } from '../src/shared/ipc.js';
import { reportInput, reportPlan, type ReportInput } from '../src/shared/report.js';
// 夹具与 spike:markdown 共用一份（`fixtures/report-case.ts`）：章节的取舍与它的渲染是
// 同一条链路的前后两段，各自造一份的话，一边补了字段另一边没补，那边的检查就变成空的
import { base, FIX_TEXT, incident, report, steps } from './fixtures/report-case.js';

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

const ids = (over: Partial<ReportInput>) => reportPlan(base(over)).sections.map((s) => s.id);
const bodyOf = (over: Partial<ReportInput>, id: string) =>
  reportPlan(base(over)).sections.find((s) => s.id === id)?.body;

// ── 形态决定装哪几块，「不投影」那一列同样是规则 ──────────────────────────

check(
  '未决型没有根因栏，哪怕库里正躺着一条已证实的',
  !ids({ shape: 'open' }).includes('verdict'),
  '归档强制未决型，而被归档的案子多半已经查出了点什么——按"有就装"写的话，残报告会顶着一条根因，而它明写的是没查出来',
);

check(
  '其余四种都有根因栏',
  VERDICT_SHAPES.filter((s) => s !== 'open').every((s) => ids({ shape: s }).includes('verdict')),
  '连未决型一起砍掉就把结论从报告里抹了',
);

check(
  '未决型的遗留疑点只装一次，且排在影响面之前',
  (() => {
    const l = ids({ shape: 'open' });
    return l.filter((i) => i === 'leftover').length === 1 && l.indexOf('leftover') < l.indexOf('impact');
  })(),
  '它在未决型里是主体块，又在通用四块里——不去重就会同一节印两遍，去重时留错那一份则会把主体挪到末尾',
);

check(
  '状态型显式写出为什么没有事故时间线',
  (() => {
    const b = bodyOf({ shape: 'state' }, 'timeline');
    return b?.kind === 'absent' && b.why.length > 0;
  })(),
  '默默少一节的话，读者分不出是本来就没有还是漏了。缺席写出来比省略可信',
);

check(
  '时序型与因果链型不装应然实然，哪怕填着',
  !ids({ shape: 'sequence' }).includes('contrast') && !ids({ shape: 'chain' }).includes('contrast'),
  '夹具里 expected/actual 是有值的：按"有就装"写的话，该看时间顺序的报告会先被一段对照岔开',
);

check(
  '分布型不装事故时间线，哪怕有带时间的证据',
  !ids({ shape: 'distribution' }).includes('timeline'),
  '夹具里事故时间线有两条：装了就把"问题只在某一小撮"这件事稀释掉了',
);

check(
  '通用四块在五种形态里都在',
  VERDICT_SHAPES.every((s) => {
    const l = ids({ shape: s });
    return ['impact', 'path', 'leftover', 'fix'].every((k) => l.includes(k));
  }),
  '影响面 / 排查路径 / 遗留疑点 / 修复建议不跟形态走（overview §6.1.1）',
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
  '跟着根因取的话，归档的残报告与整个未决型会永远少一栏——而"没查出来，下一步先加哪些观测"正是那种案子最该留下的',
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
  '每一节都标了来源',
  VERDICT_SHAPES.every((s) => reportPlan(base({ shape: s })).sections.every((x) => x.source.length > 0)),
  '「哪些是投影、哪些是生成」要对读者可见——这是 D17 唯一能被读者自己核的形式',
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
  '归因切分按全部证据算，不是事故时间线那一份',
  (() => {
    const b = bodyOf({ shape: 'distribution' }, 'split');
    return b?.kind === 'split' && b.groups.map((g) => `${g.actor}:${g.count}`).join() === 'svc-a:2,svc-b:1';
  })(),
  'svc-b 那条没有时间戳、不在事故时间线里——按它算就会凭空少掉一组，而"只在某一小撮上"与有没有时间戳无关',
);

// ── 编号与计数 ────────────────────────────────────────────────────────

check(
  '单会话的案子编号就是 #N，不加会话前缀',
  reportPlan(base()).labels.st1 === '#1',
  '绝大多数案子只有一次会话，给每一行挂个恒等于 S1 的前缀只是噪声',
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
  '证据数按全案证据算，不是事故时间线的条数',
  reportPlan(base()).evidenceCount === 3,
  '页脚水印写的是"N 条证据可在 Inquestry 溯源"；拿只含带时间戳那份的事故时间线当总数，正式报告会把证据量报少（夹具里 e3 就没有时间戳）',
);

// ── 归档 / 冻结 ────────────────────────────────────────────────────────

check(
  '归档的报告顶上说得出在第几步被终止',
  reportPlan(base({ case: { ...base().case, status: 'aborted' } })).abortedAt === steps.length,
  '残报告没有根因栏，不说清是人为终止的话，读起来像是查完了什么都没查到',
);

check(
  '结案的报告没有这句',
  reportPlan(base()).abortedAt === null,
  '结案是查完了，不是放弃',
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

console.log('\n===== Spike Report 结果 =====');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
