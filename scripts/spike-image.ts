/**
 * Spike Image —— 验长图导出里能提成纯函数的那一半（D26 的后一半 / ui.md §7.2）。
 *
 * 纯函数，不碰库也不起会话，因此**不用 rebuild ABI**：跑 `npm run spike:image` 即可。
 * 夹具与 `spike:report` / `spike:markdown` 共用 `fixtures/report-case.ts`。
 *
 * 拍照那一半（离屏窗口、字体就绪、过期帧、@2x）在这儿验不到，由真 app 的
 * `INQUESTRY_EXPORT_IMG` 探针兜（ui.md §11）：它从界面按钮按下去，再核盘上那张图的像素尺寸。
 *
 * 这一带的错法有两个形状：
 *
 *   1. **块少一个就整条消失**。图片没有"没渲染出来"的表现——少一节看起来只是报告短了点，
 *      而页脚水印照旧写着「N 条证据可在 Inquestry 溯源」（同 Markdown 那侧脚注的完备性）
 *   2. **分页只该在块之间切**。从小节中间切开的话，断口正好落在读者要看的那句话上的概率
 *      并不低；而"超预算的单块"这条边界最容易写成先产出一张空页，再把它放到第二页去
 */

import { VERDICT_SHAPES } from '../src/shared/ipc.js';
import { HEAD_BLOCK, pageFile, paginate, paperBlocks, type PageBlock } from '../src/shared/paging.js';
import { reportPlan } from '../src/shared/report.js';
import { base } from './fixtures/report-case.js';

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

const blocks = (...heights: number[]): PageBlock[] =>
  heights.map((height, i) => ({ id: `b${i + 1}`, height }));
const ids = (pages: { blocks: string[] }[]) => pages.map((p) => p.blocks);

// ── 块的来源 ─────────────────────────────────────────────────────────────

check(
  '每种形态的每一节都在待分页的块里，顺序也一致',
  VERDICT_SHAPES.every((shape) => {
    const plan = reportPlan(base({ shape, frozen: true }));
    const got = paperBlocks(plan);
    return (
      got[0] === HEAD_BLOCK &&
      got.length === plan.sections.length + 1 &&
      plan.sections.every((s, i) => got[i + 1] === s.id)
    );
  }),
  '漏一节的表现是那一节从图里整条消失——图片没有"没渲染出来"的样子，看起来只是报告短了点，而页脚照旧写着 N 条证据可溯源',
);

check(
  '抬头也是一个块',
  paperBlocks(reportPlan(base({ frozen: true })))[0] === HEAD_BLOCK,
  '抬头不当块的话它会被算成第一节的一部分，分页的预算从第一页起就是错的；而它本身也不能被切开（标题与形态戳分到两张图上等于两张都读不懂）',
);

// ── 分页 ────────────────────────────────────────────────────────────────

check(
  '装得下就是一页（单页优先）',
  ids(paginate(blocks(1000, 2000, 1500), 6000)).length === 1,
  '分页是超长时的退路不是默认形态。这里但凡写成"按预算均分"，本来一张图能贴出去的调查就会变成两张',
);

check(
  '正好等于预算不翻页',
  ids(paginate(blocks(3000, 3000), 6000)).length === 1,
  '边界写成 `>=` 的话，一份不多不少刚好装满的报告会被切成两页，第二页只有页脚',
);

check(
  '装不下就在块之间切，块不丢不重不乱序',
  (() => {
    const pages = ids(paginate(blocks(2000, 2000, 2000, 2000), 5000));
    const flat = pages.flat();
    return (
      pages.length === 2 &&
      flat.join(',') === 'b1,b2,b3,b4' &&
      new Set(flat).size === 4 &&
      pages.every((p) => p.length > 0)
    );
  })(),
  '丢一块与漏一节是同一个后果；乱序则会让"上一页说的那件事"在下一页之后',
);

check(
  '比预算还高的单块自成一页，前面不留空页',
  (() => {
    const pages = ids(paginate(blocks(9000, 1000), 6000));
    return pages.length === 2 && pages[0]!.join() === 'b1' && pages[1]!.join() === 'b2';
  })(),
  '**绝不从小节中间切**，所以超预算的块只能自己占一页。翻页条件写成按预算判（而不是按"这一页装了东西没有"）时，它会先产出一张空白页，再把这一块放到第二页去',
);

check(
  '第一块就超预算时也只出一页',
  ids(paginate(blocks(9000), 6000)).length === 1,
  '上一条的退化情形：只有一块且超预算。空页在图片里就是一张白板，而它照样带页脚水印，看起来像一份内容丢了的报告',
);

check(
  '一块都没有就一页都不出',
  paginate([], 6000).length === 0,
  '空报告该由上游拦住；这里静默给出一张只有水印的白图，等于把"没东西可导"变成了一份看起来正常的产物',
);

check(
  '每页的块是原序列里连续的一段',
  (() => {
    const src = blocks(1200, 800, 3000, 900, 4000, 600);
    const flat = ids(paginate(src, 5000)).flat();
    return flat.join(',') === src.map((b) => b.id).join(',');
  })(),
  '贪心装满的另一种写法是"挑几块凑满一页"，那会把报告的顺序打乱——而报告的顺序本身是有意义的（形态决定的主体块在前）',
);

check(
  '真实一份报告的每一节都恰好落在一页上',
  (() => {
    const plan = reportPlan(base({ frozen: true }));
    const src = paperBlocks(plan).map((id) => ({ id, height: 1800 }));
    const pages = ids(paginate(src, 5760));
    const flat = pages.flat();
    return (
      pages.length > 1 &&
      flat.length === src.length &&
      new Set(flat).size === src.length &&
      src.every((b) => flat.includes(b.id))
    );
  })(),
  '把两侧接起来验一遍：块的来源对了、分页也对了，才谈得上"图里印的就是报告的全部"。夹具的高度要造得真的会分页，否则这条只是在验单页那条路',
);

// ── 落点 ────────────────────────────────────────────────────────────────

check(
  '单页保持人选的那个名字',
  pageFile('/tmp/报告.png', 0, 1) === '/tmp/报告.png',
  '绝大多数调查是单页（单页优先）。给单页报告改名成 `-1` 是在为少数情况给所有人添麻烦——人在保存框里敲的就是这个名字',
);

check(
  '分了页按 1 起编号，扩展名留在最后',
  pageFile('/tmp/报告.png', 0, 3) === '/tmp/报告-1.png' &&
    pageFile('/tmp/报告.png', 2, 3) === '/tmp/报告-3.png',
  '从 0 起编的话第一张叫 `-0`；扩展名丢在中间（`报告-1`）则双击打不开、贴进聊天窗也不认',
);

check(
  '没有扩展名时补 .png',
  pageFile('/tmp/report', 0, 2) === '/tmp/report-1.png',
  '`report-1` 不带扩展名的话双击打不开、贴进聊天窗也不认',
);

check(
  '目录名里的点不算扩展名',
  pageFile('/tmp/v1.2/report.png', 0, 2) === '/tmp/v1.2/report-1.png' &&
    pageFile('/tmp/v1.2/report', 0, 2) === '/tmp/v1.2/report-1.png',
  '找点要从最后往前找、且只在最后一段里找。⚠️ 光有 `/tmp/v1.2/report`（无扩展名）这一个夹具兜不住：两种写法在它上面**算出来一样**，得有一个"目录里有点、文件也有扩展名"的才分得开——`/tmp/v1.2/report.png` 在错写法下会变成 `report.png-1.png`',
);

console.log('\n===== Spike Image 结果 =====');
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
}
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
