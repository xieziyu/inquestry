/**
 * 报告屏（D21 / D22）。
 *
 * **它是一个屏，不是调查台上的一个 tab**：主角从"假设与分叉"换成"判定与证据"，
 * 能做的只剩导出，内容在结案那一下冻住。色板与调查台完全相同，差别只来自密度与字号
 * （ui.md §1 那张表）——一深一浅会被读成两个应用，而这是同一个工具的两个阶段。
 *
 * **单列长页：没有 tab、没有折叠、没有内部滚动。** 这不是审美偏好，是被长图导出倒逼的——
 * 凡是要点击才能看到的内容，截图里就不存在（ui.md §7.2）。顶部那条只是锚点导航，
 * 点击只滚动、不隐藏任何东西，导出时整条移除。
 *
 * 章节怎么组装不在这儿：`shared/report.ts` 是那一份，两种导出共用它。
 * 正文怎么画也不在这儿：`ReportPaper.tsx` 是那一份，长图视图共用它。
 */

import { useRef, useState } from 'react';
import type { ExportResult, Snapshot } from '../shared/ipc.js';
import { PaperFoot, ReportPaper } from './ReportPaper.js';
import { reportInput, reportPlan } from '../shared/report.js';

/** 回执里只印文件名：路径已经在前半句里了，再重复一遍整条路径会把那一行挤爆。 */
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function Report({ snap, onBack }: { snap: Snapshot; onBack: () => void }) {
  const page = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  /**
   * 导出的回执。**成功与失败都要说出来**：写盘失败与人自己按取消在界面上长得一样
   * （都是"按了导出、什么都没发生"），而前者意味着报告压根没落地。
   */
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null);
  /** 哪一种正在导。两个按钮各自置灰，不共用一个 boolean——否则导长图时另一个也说"导出中"。 */
  const [exporting, setExporting] = useState<'md' | 'img' | null>(null);
  /**
   * 跳到某一节：落点要让开 sticky 导航自己那么高的一条，否则标题正好被压在导航底下，
   * 读者落在正文中间却看不见自己跳到了哪一节。
   *
   * **导航高度在点击这一刻同步量**，不预先算好存起来：条目多、窗口窄时导航会换行，
   * 写死一个值只在不换行时对。一度改用 `ResizeObserver` 提前同步，但它和
   * `behavior:'smooth'` 一样吃帧循环——窗口没获焦点时一次都不回调（同 [ui] §11 的过期帧），
   * 留下的是一个悄悄过期的偏移量。这里全是同步的布局读数，不依赖帧。
   */
  const jumpTo = (id: string) => {
    const host = page.current;
    const el = host?.querySelector(`#sec-${id}`);
    if (!host || !el) return;
    const gap = (nav.current?.offsetHeight ?? 0) + 16;
    host.scrollTop += el.getBoundingClientRect().top - host.getBoundingClientRect().top - gap;
  };

  /**
   * 导出走 main：那边才有库与文件系统，且**由 main 拿它自己那份快照渲染**——
   * 界面这份最多晚 60ms，导出的是一份要交出去的文档，不该差着一拍。
   *
   * 两种导出这一段一模一样，**回执与失败分档也就该一模一样**：一份能说出路径、
   * 另一份只会静默，人会以为那一种坏了。
   */
  const runExport = async (kind: 'md' | 'img', call: (caseId: string) => Promise<ExportResult>) => {
    const caseId = snap.case?.id;
    if (!caseId) return;
    setExporting(kind);
    try {
      const r = await call(caseId);
      if (r.ok) {
        // 顶着同一个名字的旧图要说出来：单页与多页的落点不同名，页数一变，上一次的产物
        // 就留在旁边，看起来正是这次导出的那张（**只报不删**，见 main 的 `staleSiblings`）
        const stale = r.stale?.length
          ? ` · 同名的旧文件还在，这次没覆盖：${r.stale.map(baseName).join('、')}`
          : '';
        setExported({
          ok: true,
          text: `已导出到 ${r.path}${r.pages && r.pages > 1 ? `（共 ${r.pages} 张）` : ''}${stale}`,
        });
      } else if (r.reason === 'canceled') setExported(null);
      else setExported({ ok: false, text: `导出失败：${r.error}` });
    } catch (err) {
      // invoke 自己也会 reject（main 抛了、通道关了）。**不接的话回执这条路就白搭**：
      // 按钮恢复、文件没有、屏上什么都不说，与"人按了取消"长得一模一样
      setExported({ ok: false, text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setExporting(null);
    }
  };

  const input = reportInput(snap);
  if (!input) return null;
  const plan = reportPlan(input);

  return (
    <div className="reportscreen" ref={page}>
      {/* 导航与返回是交互件，导出视图里不会有它们（ui.md §7.2） */}
      <nav className="anchors" ref={nav}>
        <button className="back" onClick={onBack}>
          ← 调查台
        </button>
        <button
          className="exportmd"
          onClick={() => runExport('md', (id) => window.inquestry.exportMarkdown(id))}
          disabled={exporting !== null}
        >
          {exporting === 'md' ? '导出中…' : '导出 Markdown'}
        </button>
        <button
          className="exportimg"
          onClick={() => runExport('img', (id) => window.inquestry.exportImage(id))}
          disabled={exporting !== null}
        >
          {exporting === 'img' ? '导出中…' : '导出长图'}
        </button>
        {plan.sections.map((s) => (
          <a
            key={s.id}
            href={`#sec-${s.id}`}
            onClick={(e) => {
              e.preventDefault();
              jumpTo(s.id);
            }}
          >
            {s.title}
          </a>
        ))}
      </nav>

      {/* 回执贴在导航下面而不是弹一下就没：路径要能被读出来、被复制走 */}
      {exported && (
        <p className={exported.ok ? 'exported' : 'exported bad'}>
          {exported.text}
          <button onClick={() => setExported(null)}>知道了</button>
        </p>
      )}

      <article className="paper">
        <ReportPaper meta={snap.case!} plan={plan} />
        <PaperFoot meta={snap.case!} plan={plan} />
      </article>
    </div>
  );
}
