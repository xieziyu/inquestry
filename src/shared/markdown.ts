/**
 * Markdown 导出（D26 / ui.md §7.1）。
 *
 * **章节的取舍不在这儿。** 装哪几块、什么顺序由 `reportPlan()` 定，这里只换渲染目标；
 * 长图那一种将来同样吃它。各写一份的结果必然是导出的那份与屏幕上的那份慢慢对不上，
 * 而报告是这个工具唯一交出去的东西。
 *
 * 目标是**贴到哪儿都能渲染**：时间线用表格不用 mermaid（不少 wiki 与评论区不渲染 mermaid，
 * 一旦不渲染就是一大团噪音），mermaid 只作为末尾 `<details>` 里的附加。
 * 除那一个 `<details>` 外全篇纯 Markdown。
 *
 * **纯函数，不读时钟**：生成时间由调用方给。自己取 `Date.now()` 的话同一个案子导两次的产物
 * 不一致，也就没法拿检查兜住"页脚水印到底印了没有"。
 */

import type { CallNode, EvidenceNode, IncidentEntry, ReportStepRef, StepNode } from './ipc.js';
import { localTzOffset } from './time.js';
import {
  SHAPE_COPY,
  reportPlan,
  type ChainLink,
  type ReportInput,
  type ReportPlan,
  type ReportSection,
  type SplitGroup,
} from './report.js';

export type MarkdownOptions = {
  /** 页脚水印上的生成时间（epoch ms）。 */
  generatedAt: number;
};

/** 导出时用得着的三份对照：编号、脚注键、证据的出处。 */
type Ctx = {
  plan: ReportPlan;
  label: (stepId: string) => string;
  /** evidenceId → 脚注键（`e1`、`e2`……）。**按 step 顺序编**，与正文出现的顺序无关。 */
  key: (evidenceId: string) => string;
  calls: Map<string, CallNode>;
};

export function reportMarkdown(input: ReportInput, opts: MarkdownOptions): string {
  const plan = reportPlan(input);
  const evidence = input.steps.flatMap((s) => s.evidence);
  const keys = new Map(evidence.map((e, i) => [e.id, `e${i + 1}`]));
  const ctx: Ctx = {
    plan,
    // 认不出的引用原样印 id：印错一个编号比印一个陌生 id 更糟（同报告屏）
    label: (stepId) => plan.labels[stepId] ?? stepId,
    // 认不出的证据也照样出声。静默省掉脚注的后果是正文那条事实忽然没了出处
    key: (id) => keys.get(id) ?? id,
    calls: new Map(input.steps.flatMap((s) => s.calls).map((c) => [c.id, c])),
  };

  const blocks: string[] = [`# ${inline(input.case.title)}`, lede(input, ctx), meta(input, ctx)];

  for (const section of plan.sections) {
    // 根因判定已经在置顶的引用块里了（§7.1：很多平台的预览只显示前几行，
    // 第一屏必须是结论本身）。再印一节就是同一句话说两遍
    if (section.id === 'verdict') continue;
    blocks.push(sectionMd(section, ctx));
  }

  blocks.push(footer(input, ctx, opts));
  blocks.push(footnotes(input, ctx));
  // mermaid 排在脚注之后：支持脚注的渲染器会把定义搬到页面最底下，附加图跟着往下挪最不打扰正文
  const extra = mermaid(plan, ctx);
  if (extra) blocks.push(extra);

  return `${blocks.filter((b) => b.length > 0).join('\n\n')}\n`;
}

/**
 * 置顶的引用块：**第一屏必须是结论本身**（§7.1）。
 *
 * 装不装根因这一条**只认 `plan`**，不看 `report.rootCause` 有没有值——未决型的残报告
 * 库里往往正躺着一条已证实的结论，按"有就装"写的话第一行就会印上它，
 * 而这份报告明写的是"没查出来"（同 `reportPlan()` 里那一条，这次换到了渲染侧）。
 */
function lede(input: ReportInput, ctx: Ctx): string {
  const verdict = ctx.plan.sections.find((s) => s.id === 'verdict');
  const lines: string[] = [];

  if (verdict && verdict.body.kind === 'verdict') {
    lines.push(`**根因**：${inline(verdict.body.text)}`);
    const tags = [
      verdict.body.confidence !== null ? `置信度 ${verdict.body.confidence.toFixed(2)}` : null,
      input.report.rootCause ? `出自 ${ctx.label(input.report.rootCause.stepId)}` : null,
    ].filter(Boolean);
    if (tags.length) lines.push(tags.join(' · '));
  } else {
    lines.push('**未决**：这次调查没有得出根因。以下是查过的方向与留下的疑点。');
  }

  // 这两条是对整份结论的限定，必须与结论同屏——挪到正文里就等于让人先读完再知道它不算数
  if (ctx.plan.abortedAt !== null) {
    lines.push(`⚠️ 调查在第 ${ctx.plan.abortedAt} 步被人为终止，以下是查到为止的部分。`);
  }
  if (!ctx.plan.frozen) {
    lines.push('⚠️ 这个案子还没收尾：形态是按现有数据推的，报告会跟着排查一起变。');
  }

  return lines.map((l) => `> ${l}`).join('\n>\n');
}

function meta(input: ReportInput, ctx: Ctx): string {
  const c = input.case;
  const shape = SHAPE_COPY[ctx.plan.shape];
  return [
    `- **问的是**：${inline(c.question)}`,
    `- **按${shape.label}装** · 主体是${shape.body}`,
    `- **基准日**：${codeSpan(c.incidentDate)} ${c.tzOffset}`,
  ].join('\n');
}

function sectionMd(section: ReportSection, ctx: Ctx): string {
  const head = [`## ${section.title}`];
  // 「哪些是投影、哪些是生成」对读者可见（D17）。`——` 是"这一节没有来源"的占位，别印出来
  if (section.source && section.source !== '——') head.push(`*来源：${inline(section.source)}*`);
  return [...head, body(section, ctx)].join('\n\n');
}

function body(section: ReportSection, ctx: Ctx): string {
  const b = section.body;
  switch (b.kind) {
    case 'verdict':
      // 走不到：置顶引用块已经吃掉了它。真走到了也照印，不留空节
      return `${inline(b.text)}${b.confidence !== null ? `（置信度 ${b.confidence.toFixed(2)}）` : ''}`;

    case 'contrast':
      return contrastMd(b.expected, b.actual, ['本该', '实际'], '根因那一步没有填应然 / 实然，这一块是空的。');

    case 'timeline':
      return timelineMd(b.rows, ctx);

    case 'chain':
      return chainMd(b.links, b.weakestId, ctx);

    case 'split':
      return [
        splitMd(b.groups, ctx),
        contrastMd(b.expected, b.actual, ['干净的那组', '出问题的那组'], ''),
      ]
        .filter((x) => x.length > 0)
        .join('\n\n');

    case 'matrix':
      return matrixMd(b.rows, ctx);

    case 'path':
      return pathMd(b.rows, ctx);

    case 'notes':
      return b.rows.length ? b.rows.map((r) => `- ${stepRefMd(r, ctx)}`).join('\n') : '无。';

    case 'prose':
      // 空的一栏照旧写「无」：整节消失读起来像"没这回事"（§7.1 那条对遗留疑点的要求同样适用）
      return b.text ? inline(b.text) : '无。';

    case 'absent':
      return inline(b.why);
  }
}

/**
 * 事故时间线退化成表格：竖线加圆点画不进 Markdown（§7.1），而这也正是长图存在的理由之一。
 *
 * 被推翻的 step 提供的证据照样在列——结论可以被推翻，事实不会。**但不划删除线**：
 * 划掉的是"这条判定不算数"，而这一行说的是当时真的发生过的事。改成在出处上标一句。
 */
function timelineMd(rows: IncidentEntry[], ctx: Ctx): string {
  if (!rows.length) return '一条带时间的证据都没有。事故时间线由 occurredAt 投影而来。';
  const head = ['| 时间 | 主体 | 事实 | 出处 |', '| --- | --- | --- | --- |'];
  const body = rows.map((r) => {
    const when = r.occurredAtRaw ?? new Date(r.occurredAtMs).toISOString();
    // 出处这一格全是我们自己排的（编号 + 一句标注），不走内容那条转义——
    // `#1` 过一遍 blockGuard 会变成 `\#1`，每一行都带一个多余的反斜杠
    const from = refutedStatus(r.stepStatus)
      ? `${ctx.label(r.stepId)}（判定已被推翻）`
      : ctx.label(r.stepId);
    return `| ${valueCell(when)} | ${cell(r.actor ?? '——')} | ${cell(r.claim)}${cite(r.evidenceId, ctx)} | ${from} |`;
  });
  return [...head, ...body].join('\n');
}

function chainMd(links: ChainLink[], weakestId: string | null, ctx: Ctx): string {
  if (!links.length) return '还没有已证实的环节。';
  return links
    .map((l) => {
      const tags = [
        l.confidence !== null ? `置信度 ${l.confidence.toFixed(2)}` : null,
        l.stepId === weakestId ? '**最弱一环**' : null,
        l.isRoot ? '**根因**' : null,
      ].filter(Boolean);
      const what = [l.direction, l.verdict].filter((x): x is string => !!x).map(inline).join(' —— ');
      return `1. \`${ctx.label(l.stepId)}\` ${what}${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
    })
    .join('\n');
}

function splitMd(groups: SplitGroup[], ctx: Ctx): string {
  if (!groups.length) return '证据上没有标出主体，切不出分组。';
  return [
    '| 主体 | 证据数 | 说了什么 |',
    '| --- | --- | --- |',
    ...groups.map(
      (g) =>
        `| ${cell(g.actor)} | ${g.count} | ${g.claims.map((c) => `${cell(c.claim)}${cite(c.evidenceId, ctx)}`).join(' · ')} |`,
    ),
  ].join('\n');
}

/** 排除矩阵：**被推翻的用删除线**（§7.1）——删掉整行就成了假历史。 */
function matrixMd(rows: ReportStepRef[], ctx: Ctx): string {
  if (!rows.length) return '没有排除掉任何方向。';
  return [
    '| 查过的方向 | 结论 |',
    '| --- | --- |',
    // 方向是内容，编号是我们自己的：只有前者要转义
    ...rows.map(
      (r) => `| ${r.direction ? cell(r.direction) : ctx.label(r.stepId)} | ${stepRefMd(r, ctx)} |`,
    ),
  ].join('\n');
}

/**
 * 排查路径含走错的分支，被推翻的划掉留在原处。
 *
 * **每一步的证据在这里挂上脚注**，而不只是报个条数：这一节是通用四块里唯一"所有 step 都在"的，
 * 脚注的完备性就挂在它上面。少了它，只在主体块里被引到的那些证据之外的条目
 * 会在渲染时整条消失（多数渲染器只渲染被正文引用过的脚注定义），
 * 而页脚水印仍然写着「N 条证据可在 Inquestry 溯源」——数目对不上，且毫无报错。
 */
function pathMd(rows: StepNode[], ctx: Ctx): string {
  if (!rows.length) return '还没有任何一步。';
  return rows
    .map((s) => {
      const what = strike(
        [inline(s.direction ?? '（未归类）'), s.verdict ? inline(s.verdict) : null]
          .filter(Boolean)
          .join(' —— '),
        refutedStatus(s.status),
      );
      const by = s.supersededBy ? ` ← 被 ${ctx.label(s.supersededBy)} 推翻` : '';
      const counts = `${s.calls.length} 次调用 · ${s.evidence.length} 条证据${cites(s.evidence, ctx)}`;
      return `1. \`${ctx.label(s.id)}\` ${what}${by} · ${counts}`;
    })
    .join('\n');
}

/** 遗留疑点与排除矩阵共用：命题 + 被谁推翻，推翻的划掉。 */
function stepRefMd(r: ReportStepRef, ctx: Ctx): string {
  const text = strike(inline(r.text), r.supersededBy !== null);
  const head = r.direction && !r.supersededBy ? `**${inline(r.direction)}** ` : '';
  return `${head}${text}${r.supersededBy ? ` ← 被 ${ctx.label(r.supersededBy)} 推翻` : ''}`;
}

/**
 * 应然 / 实然那一对。两列并排在 Markdown 里挤成一团，改成两行的表格——
 * 左边是标签、右边是内容，长文本因此还读得下去。
 */
function contrastMd(
  expected: string | null,
  actual: string | null,
  [a, b]: [string, string],
  empty: string,
): string {
  if (!expected && !actual) return empty;
  return [
    '| | |',
    '| --- | --- |',
    `| **${a}** | ${cell(expected ?? '——')} |`,
    `| **${b}** | ${cell(actual ?? '——')} |`,
  ].join('\n');
}

function footer(input: ReportInput, ctx: Ctx, opts: MarkdownOptions): string {
  return `---\n\nCase \`${input.case.id}\` · 生成于 ${stamp(opts.generatedAt)} · ${ctx.plan.evidenceCount} 条证据可在 Inquestry 溯源`;
}

/**
 * 文末的证据索引：正文只留 `[^e9]`，工具 / 锚点 / 时间戳来源统一落在这里（§7.1），
 * 正文因此保持可读。
 *
 * **不给这一段加小标题**：支持脚注的渲染器（GitHub 等）会把定义搬到页面最底下，
 * 留在原处的标题下面就空了。不支持的那些则把定义当普通文本印在文末，照样读得懂。
 */
function footnotes(input: ReportInput, ctx: Ctx): string {
  const lines = input.steps.flatMap((s) =>
    s.evidence.map((e) => {
      const call = ctx.calls.get(e.callId);
      const parts = [
        // 认不出那次调用也要出声：静默印成"工具未知"以外的任何写法都会让人以为溯源是全的
        call
          ? `${codeSpan(call.toolName)} 第 ${call.callNumber} 次调用`
          : `调用 ${codeSpan(e.callId)}（本案里找不到这次调用）`,
        e.anchor ? `锚点 ${codeSpan(e.anchor)}` : '无锚点（整份输出）',
        e.occurredAtRaw
          ? `时间戳 ${codeSpan(e.occurredAtRaw)}`
          : '无时间戳（不进事故时间线）',
        e.actor ? `主体 ${cell(e.actor)}` : null,
        `出自 ${ctx.label(s.id)}`,
      ].filter(Boolean);
      return `[^${ctx.key(e.id)}]: ${inline(e.claim)} —— ${parts.join(' · ')}`;
    }),
  );
  return lines.join('\n');
}

/**
 * mermaid 只作为**附加**，且只在这份报告真的装了事故时间线时才给（§7.1）。
 *
 * 形态说不投影时间线（状态型、分布型）就一张都没有——从这条侧门把它塞回去，
 * 等于让"不投影"那一列在导出里失效。
 */
function mermaid(plan: ReportPlan, ctx: Ctx): string | null {
  const section = plan.sections.find((s) => s.id === 'timeline');
  if (!section || section.body.kind !== 'timeline' || !section.body.rows.length) return null;
  const nodes = section.body.rows.map((r, i) => {
    const when = r.occurredAtRaw ?? new Date(r.occurredAtMs).toISOString();
    const who = r.actor ? `${r.actor}：` : '';
    return `  n${i}["${mm(when)}<br/>${mm(who + r.claim)}"]`;
  });
  const edges = section.body.rows.slice(1).map((_, i) => `  n${i} --> n${i + 1}`);
  return [
    '<details>',
    '<summary>事故时间线（mermaid，渲染不出来时看上面那张表）</summary>',
    '',
    '```mermaid',
    'flowchart TD',
    ...nodes,
    ...edges,
    '```',
    '',
    '</details>',
  ].join('\n');
}

const cite = (evidenceId: string, ctx: Ctx) => `[^${ctx.key(evidenceId)}]`;
const cites = (evidence: EvidenceNode[], ctx: Ctx) =>
  evidence.length ? ` ${evidence.map((e) => cite(e.id, ctx)).join('')}` : '';

const refutedStatus = (status: string) => status === 'refuted' || status === 'superseded';

/** 删除线只用在"这条判定不算数"上，事实不划（见 `timelineMd`）。 */
const strike = (text: string, on: boolean) => (on && text ? `~~${text}~~` : text);

/**
 * 进表格单元格：`|` 会凭空多切一列。反斜杠已经由 `inline()` 转义过了，
 * 所以这里只管竖线本身——内容里本来就带 `\|` 时，那个反斜杠此刻已经是 `\\`，
 * 再给竖线加一个转义正好渲染成字面的 `\|`。
 */
const cell = (text: string) => inline(text).replace(/\|/g, '\\|');

/**
 * 折掉空白，并把内容里的 **Markdown 元字符全部转义**。
 *
 * **这是唯一的转义点**：标题、问题、判定、证据、影响面都从这儿过一遍，而它们全都来自
 * agent 与工具输出（日志原文），在界面上只是纯文本，进了 `.md` 就会被渲染器当语法解释。
 * 那不只是排版走形，这份文档是要贴进 PR 与 wiki 的，几种后果各不相同：
 *
 * - `<img onerror=…>` —— 允许 raw HTML 的渲染器上是一条注入
 * - `![x](http://…)` —— 别人一打开报告就替攻击者拉一次外链（追踪像素），链接文字还能伪造去处
 * - 反引号 —— 从代码块里逃出去。**我们自己就把时间戳裹在反引号里**，证据里带一个就撑破它
 * - `~~…~~` / `**…**` —— 在这份文档里**是有语义的**（划掉 = 判定被推翻、粗体 = 根因 / 最弱一环），
 *   伪造得出来就等于伪造结论
 * - `[^e1]` —— 伪造一条脚注引用，指到别人的证据上去
 *
 * `\\` 必须第一个换，否则后面新加的反斜杠会被自己再转一遍。
 *
 * **`_` 故意不转**：CommonMark 里被字母数字夹住的下划线开不了强调，而 `req_id=abc` 这类
 * 日志文本在本工具里满屏都是——转了之后满篇 `req\_id`，换来的只是挡住一种纯装饰性的斜体。
 *
 * **我们自己那个 `<details>` 与所有排版记号都不走这里**，它们是代码里的字面量。
 */
const inline = (text: string) => blockGuard(escapeMeta(text.replace(/\s+/g, ' ').trim()));

/**
 * 元字符转义本身。**`\\` 必须第一个换**，否则后面新加的反斜杠会被自己再转一遍。
 * 散文（`inline`）与值（`valueCell`）共用这一份：转义规则各写一遍迟早会分家。
 */
const escapeMeta = (text: string) =>
  text.replace(/\\/g, '\\\\').replace(/[`*[\]<>~]/g, (c) => `\\${c}`);

/**
 * **只**把换行折成空格。表格行与脚注定义都是按行来的，换行会把一行拆成两行；
 * 其余空白一个不动——溯源字段要能按导出的值回查原文（`Aug  7` 折了就按不着了）。
 */
const oneLine = (text: string) => text.replace(/\r\n|[\r\n]/g, ' ');

/**
 * 行首那几个记号只有在**行首**才有意义，而内容确实会占满一整行（影响面那一节就是）。
 * 一段以 `#` 开头的判定会变成一级标题，以 `-` 开头会变成列表——都不是注入，但读者看到的
 * 结构不是我们排的那个。**`1.` 这种要转的是那个点**：反斜杠加数字在 CommonMark 里不是转义，
 * 会留下一个多余的反斜杠。
 */
const blockGuard = (text: string) =>
  text.replace(/^([#\-+=])/, '\\$1').replace(/^(\d{1,9})([.)])/, '$1\\$2');

/**
 * 把一个**值**包成完整的 code span（锚点、工具名、基准日——来自 agent 与工具输出）。
 * **返回的是连围栏在内的整段**，调用方不要再自己加反引号。
 *
 * 这三个字段是读者回查原始日志的依据，**一个字符都不能改**：
 *
 * - 既不能走 `inline()`（代码块里反斜杠不是转义符，那些转义符会原样显示成 `\~`、`\*`）
 * - 也不能把反引号删掉（锚点 `` foo`bar `` 删成 `foobar` 就可能指到另一行去）。
 *   CommonMark 的正解是**围栏取比内容里最长那串反引号多一个**
 * - 更不能折空白：syslog 的 `Aug  7 03:04:05` 折成一个空格之后就按不着原文了。
 *   **只把换行折成空格**——那一条是被格式逼的，表格行与脚注定义都是按行来的
 *
 * 垫空格有两个理由：内容顶着反引号时不垫会与围栏连成一片；内容首尾是空白时不垫会被
 * CommonMark 的"首尾各去掉一个空格"规则吃掉。整段都是空白时反而不垫——那条规则此时不生效。
 */
function codeSpan(text: string): string {
  const value = oneLine(text);
  // 空值也得是个合法的 code span：`` `` `` 什么都不是，一个空格则渲染成空的代码块
  if (!value) return '` `';
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[`\s]|[`\s]$/.test(value) && value.trim() !== '' ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * 值进表格：**不用 code span，用普通文本加转义。**
 *
 * 表格里的竖线连在代码块里也会切列（GFM 先按竖线切单元格再解析内容），而代码块里
 * 反斜杠是字面量、没法拿它转义——于是"要么表格走形、要么值里多出反斜杠"，两头堵。
 * 换成普通文本就没有这个两难了：`\\` 与 `\|` 都是正经转义，渲染回来一字不差，
 * 而且**在"切单元格只认 `\|`"和"先按通用反斜杠配对算"两种读法下结果相同**。
 *
 * 代价只是这一格不再是等宽字体。拿一格字体换"时间戳与文末索引里的同一个值对不上"，不值。
 */
const valueCell = (text: string) => escapeMeta(oneLine(text)).replace(/\|/g, '\\|');

/** mermaid 的标签里 `"` 直接截断节点，`|`、反引号与反斜杠同样会把它带歪。 */
const mm = (text: string) => {
  const one = inline(text).replace(/["`|[\]{}<>\\]/g, '');
  return one.length > 48 ? `${one.slice(0, 47)}…` : one;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** 页脚水印上的生成时间。带偏移，否则跨时区转手之后没人知道这是谁的几点。 */
function stamp(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} ${localTzOffset(at)}`;
}
