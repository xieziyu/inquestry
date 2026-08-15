/**
 * 长图的分页（ui.md §7.2）。**纯函数**：吃量好的块高，吐每页装哪几块。
 *
 * 规则只有一条硬的——**绝不从小节中间切**。于是超预算的单块自成一页（宁可那一页高，
 * 也不能把一段结论拦腰截断：截断处正好是读者要看的那句话的概率并不低）。
 *
 * **单页优先**（ui.md §7.2）：多数调查该压得进一张图，分页是超长时的退路。所以这里是
 * 贪心装满，不做任何"排得均匀些"的均衡——均衡会把本来一页装得下的内容推成两页。
 */

import type { ReportPlan } from './report.js';

/** 一个顶层块（报告的抬头或一节）。高度是量出来的 CSS px，不是估的。 */
export type PageBlock = { id: string; height: number };

/** 抬头（标题 / 问题 / 形态戳）在分页时也是一个块，和小节一样不可切分。 */
export const HEAD_BLOCK = '__head';

/**
 * 一份报告的顶层块，按印出来的先后。分页只在这些块之间切。
 *
 * **块的来源只有 `plan.sections` 这一条**：在这儿漏掉一节，那一节就从图里整条消失，
 * 而页脚水印照旧写着「N 条证据可在 Inquestry 溯源」——数目对不上且毫无报错
 * （同 Markdown 那侧脚注的完备性，ui.md §7.1）。
 */
export function paperBlocks(plan: ReportPlan): string[] {
  return [HEAD_BLOCK, ...plan.sections.map((s) => s.id)];
}

export type PagePlan = {
  /** 这一页装的块，按原顺序。**不会为空**：空页在图片里就是一张白板。 */
  blocks: string[];
  /** 块高之和。真实页高由渲染后再量一次（页眉页脚会加高），这里只用来决定切在哪。 */
  height: number;
};

/**
 * @param budget 一页的内容预算（CSS px）。**给的是内容预算，不是成图高度**——
 *   页眉页脚由调用方从预算里先扣掉，否则每页都会比预算高出一截。
 */
export function paginate(blocks: PageBlock[], budget: number): PagePlan[] {
  const pages: PagePlan[] = [];
  for (const b of blocks) {
    const last = pages[pages.length - 1];
    // 翻页只看"这一页已经装了东西"。**别改成按预算判**：单块比预算还高时那样会先产出一张
    // 空页，再把它放到第二页去——超预算的块只能自成一页，不能被推到一张白板后面
    if (!last || last.height + b.height > budget) {
      pages.push({ blocks: [b.id], height: b.height });
    } else {
      last.blocks.push(b.id);
      last.height += b.height;
    }
  }
  return pages;
}

/**
 * 第 `i` 页落到哪个文件。**分了页才编号，单页保持人选的那个名字**——绝大多数调查是单页
 * （ui.md §7.2 单页优先），给一份单页报告改名成 `-1` 只是在为少数情况添麻烦。
 *
 * ⚠️ 代价是两种页数用的是两套命名，同一个路径先后导出、页数又变了的话，
 * 上一次的产物会原样留在旁边。**那一半在 main 侧（`staleSiblings`）报给用户，不在这儿删。**
 */
export function pageFile(file: string, i: number, total: number): string {
  if (total === 1) return file;
  // 扩展名要留在最后：`report-1` 不带 `.png` 的话，双击打不开、贴进聊天窗也不认
  const dot = file.lastIndexOf('.');
  const slash = file.lastIndexOf('/');
  const [stem, ext] = dot > slash + 1 ? [file.slice(0, dot), file.slice(dot)] : [file, '.png'];
  return `${stem}-${i + 1}${ext}`;
}
