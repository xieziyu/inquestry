/**
 * Spike Markdown —— 验 Markdown 导出（D26 / ui.md §7.1）。
 *
 * 纯函数，不碰库也不起会话，因此**不用 rebuild ABI**：跑 `npm run spike:markdown` 即可。
 * 夹具与 `spike:report` 共用 `fixtures/report-case.ts`。
 *
 * 这一带的错法有三个形状：
 *
 *   1. **绕过 `reportPlan()` 自己拿数据**。渲染侧一句 `if (report.rootCause)` 就能让
 *      未决型的残报告在第一行印上一条根因——那份报告明写的是"没查出来"。
 *      mermaid 那张附加图是同一个门：形态说不投影时间线，从侧门塞回去等于让规则失效
 *   2. **脚注只在被引用时才渲染**。多数渲染器（GitHub 等）不渲染没被正文引到的定义，
 *      于是"少引一条"的表现是那条证据在导出的文档里整条消失，而页脚水印照旧写着
 *      「N 条证据可在 Inquestry 溯源」——数目对不上，且毫无报错
 *   3. **内容会被当成语法解释**，而内容全部来自 agent 与工具输出（日志原文）。单元格里一个 `|`
 *      凭空多切一列、一个换行把一行拆成两行、mermaid 标签里一个 `"` 截断节点；更要紧的是
 *      `![x](http://…)` 会让读报告的人替攻击者拉一次外链，`~~…~~` / `**…**` 在这份文档里
 *      **有语义**（划掉 = 被推翻、粗体 = 根因），伪造得出来就等于伪造结论。
 *      ⚠️ **反引号那条既不能靠转义也不该靠删**：代码块里反斜杠不是转义符，而删字符会篡改
 *      时间戳 / 锚点 / 工具名——那三个正是读者回查原始日志的依据。正解是加长围栏。
 *      这类错法在夹具里没有脏数据时全是空检查
 */

import { VERDICT_SHAPES, type IncidentEntry } from '../src/shared/ipc.js';
import { reportMarkdown } from '../src/shared/markdown.js';
import { reportPlan, type ReportInput } from '../src/shared/report.js';
import { FIX_TEXT, ROOT_TEXT, base, ev, incident, report, step, steps } from './fixtures/report-case.js';

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

/** 固定的生成时间：产物要可复现，否则"页脚印了没有"这条根本没法拿检查兜。 */
const AT = Date.parse('2026-08-12T15:04:00+08:00');
const md = (over: Partial<ReportInput> = {}) => reportMarkdown(base(over), { generatedAt: AT });

/** 正文 = 去掉脚注定义与那个 `<details>` 之后剩下的部分。引用与定义得分得开。 */
const prose = (text: string) =>
  text
    .replace(/<details>[\s\S]*?<\/details>/g, '')
    .split('\n')
    .filter((l) => !l.startsWith('[^'))
    .join('\n');

/** 正文，且剥掉**我们自己**那几个行首记号（引用块的 `> `）——只剩内容带进来的字符。 */
const content = (text: string) =>
  prose(text)
    .split('\n')
    .map((l) => l.replace(/^> ?/, ''))
    .join('\n');

/**
 * 真正会切列的竖线：**按前面那串反斜杠的奇偶算**。
 * 只看"前一个字符是不是反斜杠"会被 `\\|`（字面反斜杠 + 没转义的竖线）骗过去。
 */
const bareBars = (row: string) => [...row.matchAll(/(\\*)\|/g)].filter((m) => m[1]!.length % 2 === 0).length;

const detailsOf = (text: string) => /<details>[\s\S]*?<\/details>/.exec(text)?.[0] ?? '';
/**
 * 取某一节的正文。**必须按节取**：整篇里搜「无。」的话，另一个空着的节
 * （修复建议一直是空的）会替这一条作答，于是"整节留白"这个错法照旧通过。
 */
const sectionOf = (text: string, title: string) =>
  text.split(`## ${title}`)[1]?.split(/\n## |\n---/)[0] ?? '';
/** 时间线数据行（表头与分隔行都不算）。**按位置取，不按格式取**——第一列的写法变过一次。 */
const dataRow = (out: string) =>
  out.split('\n').find((l) => l.startsWith('| ') && !l.includes('时间 |') && !l.startsWith('| ---')) ?? '';

/** 时间线那一格的原始文本（第一列）。 */
const whenCell = (out: string) => dataRow(out).split(' | ')[0]!.slice(2);

/** 把每条证据的锚点换掉，用来验文末索引里的 code span。 */
const withAnchor = (anchor: string) =>
  steps.map((x) => ({ ...x, evidence: x.evidence.map((e) => ({ ...e, anchor })) }));

const headings = (text: string) =>
  text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));

// ── 第一屏是结论本身 ────────────────────────────────────────────────────

check(
  '根因用引用块置顶，紧跟在标题后面',
  (() => {
    const lines = md().split('\n');
    return lines[0]!.startsWith('# ') && lines[2]!.startsWith('> ') && lines[2]!.includes(ROOT_TEXT);
  })(),
  '很多平台的预览只显示前几行（§7.1）：结论落到正文中间，转手一次就没人看得见它',
);

check(
  '未决型第一屏不印根因，哪怕库里正躺着一条已证实的',
  !md({ shape: 'open' }).includes(ROOT_TEXT),
  '渲染侧一句 `if (report.rootCause)` 就够了：归档的残报告会顶着一条根因，而它明写的是没查出来。装不装只认 reportPlan 给的章节',
);

check(
  '未决型明说是未决，不留一个空开头',
  md({ shape: 'open' }).split('\n')[2]!.includes('未决'),
  '第一屏什么都不说的话，读者以为报告缺了一块，而"没查出来"本身就是这份报告的结论',
);

check(
  '归档在第一屏就写出人为终止',
  (() => {
    const out = md({ case: { ...base().case, status: 'aborted' }, shape: 'open' });
    const quote = out.split('\n').filter((l) => l.startsWith('>')).join('\n');
    return quote.includes('人为终止') && quote.includes(`第 ${steps.length} 步`);
  })(),
  '它没有根因栏不是漏了。这句挪到正文里，等于让人读完整篇才知道结论不算数',
);

check(
  '没冻的报告在第一屏标明还会变，冻了的没有这句',
  (() => {
    const live = md({ frozen: false });
    return live.split('\n').filter((l) => l.startsWith('>')).join().includes('还没收尾') &&
      !md().includes('还没收尾');
  })(),
  '预览与正式产物长得一样、贴出去却还会变，是这份文档最容易骗人的地方',
);

check(
  '根因判定不再单独印一节',
  !md().includes('## 根因判定'),
  '置顶引用块已经是它了：再印一节就是同一句话说两遍，读者会去找两者的差别',
);

check(
  '章节的顺序与 reportPlan 完全一致',
  VERDICT_SHAPES.every((shape) => {
    const want = reportPlan(base({ shape })).sections.filter((s) => s.id !== 'verdict').map((s) => s.title);
    return headings(md({ shape })).join() === want.join();
  }),
  '导出自己排一次顺序的话，主体块会慢慢漂到通用四块后面，而屏幕上还是对的——两份产物就此分家',
);

check(
  '每一节都印出"哪来的"',
  (() => {
    const out = md();
    const want = reportPlan(base()).sections.filter((s) => s.id !== 'verdict' && s.source !== '——');
    return want.every((s) => out.includes(`*来源：${s.source}*`));
  })(),
  '「哪些是投影、哪些是生成」是 D17 唯一能被读者自己核的形式，导出的那份丢了它就只是一篇文章',
);

// ── 时间线用表格，mermaid 只是附加 ──────────────────────────────────────

check(
  '事故时间线是表格，不是 mermaid',
  (() => {
    const out = prose(md());
    return out.includes('| 时间 | 主体 | 事实 | 出处 |') && !out.includes('```mermaid');
  })(),
  'mermaid 在不少 wiki 与评论区不渲染，一旦不渲染就是一团噪音（§7.1）。正文里必须是表格',
);

check(
  'mermaid 只出现在末尾那个 details 里',
  (() => {
    const out = md();
    return out.includes('```mermaid') && detailsOf(out).includes('```mermaid');
  })(),
  '它是给渲染得出来的地方的附加。放正文里就把"到处都能读"这条前提丢了',
);

check(
  '形态不投影时间线时，一张 mermaid 都不给',
  ['state', 'distribution'].every((shape) => !md({ shape: shape as never }).includes('mermaid')),
  '夹具里事故时间线有两条：从这条侧门塞回去，等于让形态表里「不投影」那一列在导出里失效',
);

check(
  '一条带时间的证据都没有时不给空图，且写出为什么',
  (() => {
    const out = md({ incident: [] });
    return !out.includes('mermaid') && out.includes('一条带时间的证据都没有');
  })(),
  '空 flowchart 在渲染器里是一个空白框；而整节消失读起来像"这个案子没有时间线"',
);

check(
  '状态型写出为什么没有事故时间线',
  md({ shape: 'state' }).includes('状态型故障没有"事发瞬间"'),
  '默默少一节的话，读者分不出是本来就没有还是漏了（同 spike:report 那条，这次验的是它真的印出来了）',
);

check(
  '除那一个 details 外全篇纯 Markdown',
  VERDICT_SHAPES.every((shape) => !prose(md({ shape })).includes('<')),
  '§7.1 的硬要求：夹带一个 HTML 标签，就会在某个只渲染纯 Markdown 的地方原样露出来',
);

/** 一段把各种元字符都用上的脏内容。**每一个都对应一种真实后果**，见文件头注释。 */
const EVIL =
  '<img src=x onerror=alert(1)> ![x](https://attacker.example/pixel) [看这里](https://evil.example) `code` ~~假推翻~~ **假粗体** [^e1]';

/**
 * 影响面那一节的**正文**——整段就是内容，用来验行首记号与转义。
 * 去掉 `*来源：…*` 那行：它是我们自己的斜体，留着会被当成"没转义的 `*`"。
 */
const impactOf = (out: string) =>
  sectionOf(out, '影响面')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('*来源：'))
    .join('\n');

check(
  '内容里的 HTML 标签一律转义，不原样写进去',
  (() => {
    const dirty: IncidentEntry[] = [{ ...incident[0]!, claim: `看到 ${EVIL} 这一段` }];
    const out = md({ incident: dirty, report: { ...report, impact: `影响面里也来一段 ${EVIL}` } });
    return (
      content(out).match(/(?<!\\)[<>]/g) === null &&
      out.includes('\\<img src=x onerror=alert(1)\\>')
    );
  })(),
  '证据、判定、问题这些文本来自工具输出与 agent：原样写进去，在允许 raw HTML 的渲染器里就是一条注入，而这份文档正是要拿去到处贴的',
);

check(
  '内容里的 Markdown 元字符一个都不剩，链接与图片都不成立',
  (() => {
    const dirty: IncidentEntry[] = [{ ...incident[0]!, claim: EVIL }];
    const out = md({ incident: dirty, report: { ...report, impact: EVIL } });
    // **只看我们塞进去的那两处**，不去反过来剥自己排的记号：剥法写歪了（漏算单个 `*`
    // 的斜体、行首前缀吃掉半个 `**`）会留下一堆自己的记号，检查就变成在验剥法
    const impact = impactOf(out).trim();
    const fact = (out.split('\n').find((l) => l.startsWith('| `')) ?? '').split(' | ')[2] ?? '';
    const bare = (t: string) => t.replace(/\[\^e\d+\]$/, '').match(/(?<!\\)[`*[\]<>~]/g);
    return impact.includes('假推翻') && bare(impact) === null && bare(fact) === null;
  })(),
  '`![x](http://…)` 让读报告的人替攻击者拉一次外链、链接文字还能伪造去处；而 `~~…~~` 与 `**…**` 在这份文档里是有语义的（划掉 = 被推翻、粗体 = 根因），伪造得出来就等于伪造结论',
);

check(
  '内容伪造不出一条活的脚注引用',
  (() => {
    const out = md({ report: { ...report, impact: `看 [^e1] 这条` } });
    return /(?<!\\)\[\^/.test(impactOf(out)) === false;
  })(),
  '伪造一条 `[^e1]` 就能把读者指到别人的证据上去，而索引里那条看着完全正常',
);

check(
  '裹进反引号的值原样保留，围栏自己加长',
  (() => {
    const out = md({
      incident: [{ ...incident[0]!, occurredAtRaw: '10:02:11`x`' }],
      steps: withAnchor('foo`bar'),
    });
    const note = out.split('\n').find((l) => l.startsWith('[^e1]:')) ?? '';
    // 索引里是 code span（围栏加长）；表格那一格是普通文本（反引号照常转义）
    return note.includes('锚点 ``foo`bar``') && whenCell(out) === '10:02:11\\`x\\`';
  })(),
  '时间戳 / 锚点 / 工具名是读者回查原始日志的依据：删掉一个反引号，锚点 foo`bar 就成了 foobar，可能指到另一行去。CommonMark 给的正解是围栏取比内容里最长那串反引号多一个',
);

check(
  '内容以反引号开头或结尾时两侧垫空格',
  (() => {
    const note = md({ steps: withAnchor('`整段都是反引号包着的`') }).split('\n').find((l) => l.startsWith('[^e1]:')) ?? '';
    return note.includes('锚点 `` `整段都是反引号包着的` ``');
  })(),
  '不垫的话围栏与内容的反引号连成一片，渲染器数错围栏长度，整条索引从那里开始走形',
);

check(
  '时间戳进表格用普通文本转义：一字不差，且两种读法下都不切列',
  (() => {
    const of = (raw: string) => md({ incident: [{ ...incident[0]!, occurredAtRaw: raw }] });
    const plain = of('10:02:11|y');
    const withSlash = of('10:02:11\\|y');
    return (
      bareBars(dataRow(plain)) === 5 &&
      whenCell(plain) === '10:02:11\\|y' &&
      bareBars(dataRow(withSlash)) === 5 &&
      // `\\` 与 `\|` 都是正经转义，渲染回来正是原值——不像代码块里那样只能二选一
      whenCell(withSlash) === '10:02:11\\\\\\|y'
    );
  })(),
  '表格里的竖线连在代码块里也会切列，而代码块里反斜杠是字面量、没法拿它转义，于是"要么表格走形、要么值里多出反斜杠"两头堵。换成普通文本就没有这个两难：代价只是这一格不再等宽',
);

check(
  '溯源字段里的连续空白原样保留，不折成一个空格',
  (() => {
    const out = md({
      incident: [{ ...incident[0]!, occurredAtRaw: 'Aug  7 03:04:05' }],
      steps: withAnchor('col  17'),
    });
    const note = out.split('\n').find((l) => l.startsWith('[^e1]:')) ?? '';
    return whenCell(out) === 'Aug  7 03:04:05' && note.includes('锚点 `col  17`');
  })(),
  'syslog 的 `Aug  7` 折成一个空格之后就按不着原文了。折的只能是换行——那一条是被格式逼的（表格行与脚注定义都按行来）',
);

check(
  '首尾是空白的值在文末索引里垫一层，不被吃掉',
  (() => {
    const note = md({ steps: withAnchor('  line 42  ') }).split('\n').find((l) => l.startsWith('[^e1]:')) ?? '';
    // CommonMark 首尾各去掉一个空格，所以要各垫一个回来
    return note.includes('锚点 `   line 42   `');
  })(),
  '⚠️ 表格那一格做不到这一点：GFM 本来就会把单元格首尾的空白吃掉。所以**文末索引才是溯源那一份**（§7.1 原话：来源统一落在文末索引），表格是给人读的',
);

check(
  '内容占满一整行时，行首那几个记号不会改掉文档结构',
  (() => {
    const heading = md({ report: { ...report, impact: '# 这不是标题' } });
    const list = md({ report: { ...report, impact: '- 这不是列表项' } });
    const ordered = md({ report: { ...report, impact: '1. 这也不是' } });
    return (
      impactOf(heading).includes('\\# 这不是标题') &&
      impactOf(list).includes('\\- 这不是列表项') &&
      impactOf(ordered).includes('1\\. 这也不是')
    );
  })(),
  '影响面那一节整段就是内容：以 `#` 开头会变成一级标题、以 `-` 开头会变成列表——读者看到的结构不是我们排的那个。⚠️ `1.` 要转的是那个点，反斜杠加数字在 CommonMark 里不是转义，会留下一个多余的反斜杠',
);

// ── 证据用脚注，且一条都不许漏 ──────────────────────────────────────────

check(
  '每条证据都在正文里被引到，不只是有个定义',
  VERDICT_SHAPES.every((shape) => {
    const body = prose(md({ shape }));
    return ['e1', 'e2', 'e3'].every((k) => body.includes(`[^${k}]`));
  }),
  '多数渲染器只渲染被正文引用过的定义：漏引一条，那条证据在导出的文档里整条消失，而页脚仍写着 N 条可溯源',
);

check(
  '脚注定义带上工具、锚点、时间戳',
  (() => {
    const line = md().split('\n').find((l) => l.startsWith('[^e1]:')) ?? '';
    return line.includes('demo_query') && line.includes('line 42') && line.includes('10:02:11');
  })(),
  '正文只留 `[^e9]`，来源统一落在文末索引（§7.1）。索引里没有来源，脚注就只是个编号',
);

check(
  '没有锚点 / 没有时间戳的明写出来，不是留空',
  (() => {
    const line = md().split('\n').find((l) => l.startsWith('[^e3]:')) ?? '';
    return line.includes('无锚点') && line.includes('无时间戳');
  })(),
  '留空的那一格读起来像"这条证据没记全"，而"整份输出"与"没有时间戳"都是确定的事实',
);

check(
  '认不出那次调用时出声，不装作溯源是全的',
  md().split('\n').find((l) => l.startsWith('[^e3]:'))?.includes('找不到这次调用') === true,
  '夹具里 e3 的 callId 故意不在本案里：静默印成一个空工具名会让人以为点开就能回到原始日志',
);

check(
  '脚注编号跟着 step 顺序，与正文出现的顺序无关',
  (() => {
    const defs = md({ shape: 'distribution' }).split('\n').filter((l) => l.startsWith('[^'));
    return defs.map((l) => l.slice(0, 6)).join() === '[^e1]:,[^e2]:,[^e3]:';
  })(),
  '按引用顺序编的话，同一个案子换个形态导出就换一套编号——两份文档之间没法互相对',
);

// ── 被推翻的划掉，事实不划 ──────────────────────────────────────────────

check(
  '被推翻的判定划删除线，留在原处',
  (() => {
    const out = md({ shape: 'open' });
    return out.includes('~~上游全程正常~~') && out.includes('← 被 #4 推翻');
  })(),
  '删掉就成了假历史，而"查过哪些方向"正是下一个人最需要的（§7.1）',
);

check(
  '事故时间线里，被推翻的 step 提供的证据不划删除线',
  (() => {
    const rows: IncidentEntry[] = [{ ...incident[0]!, stepStatus: 'superseded' }];
    const row = dataRow(md({ incident: rows }));
    return !row.includes('~~') && row.includes('判定已被推翻');
  })(),
  '结论可以被推翻，事实不会。划掉它等于说这件事没发生过——改成在出处上标一句',
);

// ── 编号、计数、脏数据 ──────────────────────────────────────────────────

check(
  '跨会话的编号带上会话号，正文与脚注用的是同一套',
  (() => {
    const two = [
      ...steps.slice(0, 2),
      step({ id: 'st9', sessionId: 'se2', sessionIndex: 2, ordinal: 1, status: 'confirmed', evidence: [ev('e9', 'svc-c', '10:09:00')] }),
    ];
    const out = md({ steps: two, incident: [] });
    return out.includes('`S1#1`') && out.includes('`S2#1`') && out.includes('出自 S2#1');
  })(),
  'ordinal 是会话内序号：直接印的话文档里有两个 #1，而脚注说的"出自"也就无处可对',
);

check(
  '页脚水印带 case 编号、生成时间与全案证据数',
  (() => {
    const foot = md().split('\n').find((l) => l.startsWith('Case ')) ?? '';
    return foot.includes('case_1') && foot.includes('2026-08-12 15:04') && foot.includes('3 条证据');
  })(),
  '拿事故时间线的条数当总数会把证据量报少（夹具里 e3 没有时间戳）；没有生成时间则分不出手上这份是哪一版',
);

check(
  '同样的入参导两次，产物一字不差',
  md() === md(),
  '自己去读时钟的话产物每次都不同：既没法 diff 两版报告，也没法拿检查兜住页脚',
);

check(
  '空的遗留疑点写「无」，整节照旧在',
  (() => {
    const out = md({ report: { ...report, leftovers: [] } });
    return out.includes('## 遗留疑点') && sectionOf(out, '遗留疑点').includes('无。');
  })(),
  '整节消失读起来像"没这回事"；写「无」才是"查过，没有"（§7.1 点名了这一节）',
);

check(
  '修复建议那一节印的是内容，不是恒为「无」',
  sectionOf(md(), '修复建议').includes(FIX_TEXT.replace(/([*[\]])/g, '\\$1')),
  '这一栏一度没有写入方，于是"整节留白"这个错法在整篇里搜「无。」的检查下照旧通过（§9.12 那条 mutation 记的正是它）',
);

check(
  '空的修复建议写「无」，整节照旧在',
  (() => {
    const out = md({ report: { ...report, remediation: null } });
    return out.includes('## 修复建议') && sectionOf(out, '修复建议').includes('无。');
  })(),
  '与遗留疑点同一条理由：整节消失读起来像"没这回事"',
);

check(
  '修复建议同样过转义那道门',
  (() => {
    const out = md({ report: { ...report, remediation: EVIL } });
    const body = sectionOf(out, '修复建议')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('*来源：'))
      .join('\n')
      .replace(/\[\^e\d+\]$/, '');
    return body.match(/(?<!\\)[`*[\]<>~]/g) === null;
  })(),
  '它是 agent 生成的自由文本——四栏里最像"正常散文"的一栏，也因此最容易被漏在转义之外',
);

check(
  '单元格里的 `|` 与换行不会把表格切歪',
  (() => {
    const dirty: IncidentEntry[] = [
      { ...incident[0]!, claim: 'a | b\nc', actor: 'svc-a' },
    ];
    const row = dataRow(md({ incident: dirty }));
    return row.includes('a \\| b c') && bareBars(row) === 5;
  })(),
  '一个未转义的 `|` 凭空多切一列，一个换行把一行拆成两行——后半行还会被渲染成正文',
);

check(
  '内容本来就带 `\\|` 时也不会切歪',
  (() => {
    const dirty: IncidentEntry[] = [{ ...incident[0]!, claim: 'grep -E "a\\|b" 日志' }];
    return bareBars(dataRow(md({ incident: dirty }))) === 5;
  })(),
  '只转义竖线本身会得到 `\\\\|`：渲染器先把前两个还原成一个字面反斜杠，后面那个竖线照旧切列。日志、路径、正则里这种组合很常见',
);

check(
  'mermaid 标签里的引号、尖括号与反斜杠都被剥掉',
  (() => {
    const dirty: IncidentEntry[] = [{ ...incident[0]!, claim: '他说 "超时" 了 <b>x</b> 路径 C:\\tmp' }];
    // `<br/>` 是**我们自己**塞进标签的分隔符，剥掉再看剩下的字符哪来的
    const label = (/n0\["([^"]*)"\]/.exec(detailsOf(md({ incident: dirty })))?.[1] ?? '').replace(
      /<br\/>/g,
      '',
    );
    return label.includes('他说 超时 了') && !/["<>\\]/.test(label);
  })(),
  'mermaid 的引号标签里再出现一个 `"` 会直接截断节点，整张图渲染失败——而正文那张表看不出问题。反斜杠同理（正文那侧的转义不能漏进来）',
);

console.log('\n===== Spike Markdown 结果 =====');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
