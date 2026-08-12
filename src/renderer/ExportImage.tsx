/**
 * 长图的渲染视图（`?export=image`，ui.md §7.2）。
 *
 * **它不是报告页的截图，是报告页的另一个渲染目标**：数据与样式共用，交互件一个不留
 * （锚点导航、导出按钮、hover 才出现的东西）。窗口在 main 那边是离屏的，人看不到这一屏。
 *
 * 这里只负责两件 main 做不了的事：**按真实布局分页**、**把每一页的落点量出来**。
 * 拍照与写盘在 main（`exportImage()`），它按这里报的矩形逐页裁。
 *
 * ⚠️ **量完再报 ready，别让 main 靠等**。main 那侧是轮询 `window.__inquestryExport`，
 * 报早了它会按一份还没排完版的矩形去裁（ui.md §11 那条过期帧的同族问题：
 * 失败方式是安静地产出一张对不上的图，而不是报错）。
 */

import { useEffect, useRef, useState } from 'react';
import type { ExportPayload } from '../shared/ipc.js';
import { paginate, paperBlocks, type PageBlock } from '../shared/paging.js';
import { reportPlan, type ReportPlan } from '../shared/report.js';
import { PaperFoot, ReportPaper } from './ReportPaper.js';

/** 一页的上限（ui.md §7.2）。超过就按顶层小节切，**绝不从小节中间切**。 */
const PAGE_MAX = 6000;

/** main 按这个全局量取分页结果。名字与形状是两侧的约定，改一边就等于把图裁错。 */
declare global {
  interface Window {
    __inquestryExport?: { width: number; pages: { top: number; height: number }[] } | { error: string };
  }
}

type Phase =
  /** 一页装下全部，只为量每个块有多高 */
  | { kind: 'measure'; plan: ReportPlan; payload: ExportPayload }
  | { kind: 'paged'; plan: ReportPlan; payload: ExportPayload; pages: string[][] };

export function ExportImage({ token }: { token: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase | null>(null);

  // 取 main 那份快照渲染（不是界面这份）：导出的是一份要交出去的产物，不该差着一拍
  useEffect(() => {
    void (async () => {
      try {
        const payload = await window.inquestry.exportPayload(token);
        if (!payload) throw new Error('取不到这次导出的快照（token 对不上或已过期）');
        setPhase({ kind: 'measure', plan: reportPlan(payload.input), payload });
      } catch (err) {
        fail(err);
      }
    })();
  }, [token]);

  // 量块高 → 分页。**量的是排版后的真实高度**，不是按字数估的
  useEffect(() => {
    if (phase?.kind !== 'measure') return;
    void (async () => {
      try {
        const { blocks, chrome, pagehead } = await measure(host.current!, paperBlocks(phase.plan));
        // **预算按量出来的固定开销扣**，不按写死的常量：`.paper` 的内边距、页脚水印、
        // 页眉加起来是二百七十几，我原先估的 240 会让每页悄悄比上限高出三十来个像素——
        // 而那个常量上写的正是"宁可估宽一点"。量一次就不会与样式表长歪
        //
        // ⚠️ **"能不能装成一页"要按没有页眉的开销问**（`chrome` 里含页眉，量的时候特意让它在场）：
        // 单页报告不印页眉，拿含页眉的预算去判，会把一份差着一行页眉就能装下的报告拆成两页——
        // 而分页之后它反倒真的多出两条页眉，且文件名从人选的那个变成 `-1`/`-2`。**单页优先**
        const total = blocks.reduce((n, b) => n + b.height, 0);
        const pages =
          total + chrome - pagehead <= PAGE_MAX
            ? [blocks.map((b) => b.id)]
            : paginate(blocks, PAGE_MAX - chrome).map((p) => p.blocks);
        setPhase({ ...phase, kind: 'paged', pages });
      } catch (err) {
        fail(err);
      }
    })();
  }, [phase]);

  // 分完页再量一次每页的落点：页眉页脚会加高，预算算出来的那个高度不能拿去裁图
  useEffect(() => {
    if (phase?.kind !== 'paged') return;
    void (async () => {
      try {
        await settled();
        const els = [...host.current!.querySelectorAll('.imgpage')];
        if (!els.length) throw new Error('分完页之后一页都没有');
        // **相邻两页要严丝合缝地拼上**：各自四舍五入的话边界会差出一像素，
        // 表现是某一页顶上多一条上一页的残边。按同一组取整后的边界切就不会
        const pages = els.map((el) => {
          const r = el.getBoundingClientRect();
          const top = Math.round(r.top + window.scrollY);
          return { top, height: Math.round(r.bottom + window.scrollY) - top };
        });
        // 装了不止一块的页超过上限，说明预算算错了（原先那个写死的固定开销就是这么错的）。
        // **只有单块页可以超**——那一块自己就比一页高，而绝不从小节中间切
        const over = pages.findIndex((r, i) => phase.pages[i]!.length > 1 && r.height > PAGE_MAX + 1);
        if (over >= 0) {
          throw new Error(`第 ${over + 1} 页排到 ${pages[over]!.height}px，超过 ${PAGE_MAX}px 的上限`);
        }
        window.__inquestryExport = { width: els[0]!.getBoundingClientRect().width, pages };
      } catch (err) {
        fail(err);
      }
    })();
  }, [phase]);

  if (!phase) return null;
  const { plan, payload } = phase;
  const stamp = payload.generatedAt;

  // 量高那一趟也走同一套外壳：换个壳量出来的高度不作数
  if (phase.kind === 'measure') {
    return (
      <div className="imgexport" ref={host}>
        {/* `total={2}` 是为了让页眉也在场：量的是"每页固定要占多少"，
            缺了页眉就会少算一行，而分页之后它每页都在 */}
        <Page meta={payload.input.case} plan={plan} stamp={stamp} page={0} total={2} />
      </div>
    );
  }

  return (
    <div className="imgexport" ref={host}>
      {phase.pages.map((blocks, i) => (
        <Page
          key={i}
          meta={payload.input.case}
          plan={plan}
          stamp={stamp}
          page={i}
          total={phase.pages.length}
          only={blocks}
        />
      ))}
    </div>
  );
}

function Page({
  meta,
  plan,
  stamp,
  page,
  total,
  only,
}: {
  meta: ExportPayload['input']['case'];
  plan: ReportPlan;
  stamp: string;
  page: number;
  total: number;
  only?: string[];
}) {
  return (
    <div className="imgpage">
      {/* 页眉只在真的分了页时才有：单页报告印一行「1/1」只是噪声（ui.md §7.2 单页优先） */}
      {total > 1 && (
        <div className="pagehead">
          <span>Case {meta.id}</span>
          <span>
            {page + 1}/{total}
          </span>
        </div>
      )}
      <article className="paper">
        <ReportPaper meta={meta} plan={plan} only={only} />
        <PaperFoot meta={meta} plan={plan} generatedAt={stamp} />
      </article>
    </div>
  );
}

/**
 * 每个顶层块占多高。**要算上它自己那条上外边距**（小节之间那 44px），
 * `getBoundingClientRect().height` 不含外边距，漏算的话每页都会顶破上限。
 *
 * ⚠️ **边距要算在它自己头上，不能按"下一块的落点减这一块的落点"算**：后者把这 44px 记在了
 * 上一块名下，而分页之后那一块成了上一页的末尾、边距根本不出现，这 44px 却随着新页的
 * 第一个小节实打实地长了出来——于是每一页都可能比预算高出一个边距。
 * 实测就是这么超的（上限压到 600 时第三页排到 634px，超了 34）。
 */
async function measure(
  host: HTMLElement,
  ids: string[],
): Promise<{ blocks: PageBlock[]; chrome: number; pagehead: number }> {
  await settled();
  const page = host.querySelector('.imgpage');
  if (!page) throw new Error('量不到页容器');
  // 页眉单独量一份：它只在分了页的时候才印，判"能不能装成一页"要把它扣回去
  const head = page.querySelector('.pagehead');
  if (!head) throw new Error('量不到页眉');
  const blocks: PageBlock[] = [];
  for (const id of ids) {
    const el = host.querySelector(`[data-block="${id}"]`);
    // 块少一个就会被静默漏出这份报告，宁可整次导出失败
    if (!el) throw new Error(`量不到这一块：${id}`);
    const marginTop = parseFloat(getComputedStyle(el).marginTop) || 0;
    blocks.push({ id, height: el.getBoundingClientRect().height + marginTop });
  }
  // 固定开销 = 整页高 − 内容高。**减出来的，不是列出来的**：照着样式表把内边距、
  // 页脚、页眉一项项加起来，改一处样式就少算一项，而少算的表现是页面悄悄超上限
  const content = blocks.reduce((n, b) => n + b.height, 0);
  return {
    blocks,
    chrome: page.getBoundingClientRect().height - content,
    pagehead: head.getBoundingClientRect().height,
  };
}

/**
 * 排版稳住了没有。字体没就绪时量出来的是回退字体的高度，分页会按一份错的排版切。
 * 两帧是为了让样式与布局都过一遍——第一帧只保证提交，第二帧才轮到量。
 */
async function settled(): Promise<void> {
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
}

/** 失败也要报出去：不报的话 main 只能等到超时，而超时说不出是哪一步坏了。 */
function fail(err: unknown) {
  window.__inquestryExport = { error: err instanceof Error ? err.message : String(err) };
}
