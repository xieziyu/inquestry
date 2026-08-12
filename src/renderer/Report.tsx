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
 */

import { useRef, useState } from 'react';
import type { IncidentEntry, Snapshot, StepNode } from '../shared/ipc.js';
import {
  SHAPE_COPY,
  reportInput,
  reportPlan,
  type ChainLink,
  type ReportSection,
} from '../shared/report.js';

export function Report({ snap, onBack }: { snap: Snapshot; onBack: () => void }) {
  const page = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  /**
   * 导出的回执。**成功与失败都要说出来**：写盘失败与人自己按取消在界面上长得一样
   * （都是"按了导出、什么都没发生"），而前者意味着报告压根没落地。
   */
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);
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
   */
  const exportMd = async () => {
    const caseId = snap.case?.id;
    if (!caseId) return;
    setExporting(true);
    try {
      const r = await window.inquestry.exportMarkdown(caseId);
      if (r.ok) setExported({ ok: true, text: `已导出到 ${r.path}` });
      else if (r.reason === 'canceled') setExported(null);
      else setExported({ ok: false, text: `导出失败：${r.error}` });
    } catch (err) {
      // invoke 自己也会 reject（main 抛了、通道关了）。**不接的话回执这条路就白搭**：
      // 按钮恢复、文件没有、屏上什么都不说，与"人按了取消"长得一模一样
      setExported({ ok: false, text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setExporting(false);
    }
  };

  const input = reportInput(snap);
  if (!input) return null;
  const plan = reportPlan(input);
  /** 认不出的引用原样印 id：印错一个编号比印一个陌生 id 更糟。 */
  const label = (stepId: string) => plan.labels[stepId] ?? stepId;

  return (
    <div className="reportscreen" ref={page}>
      {/* 导航与返回是交互件，导出视图里不会有它们（ui.md §7.2） */}
      <nav className="anchors" ref={nav}>
        <button className="back" onClick={onBack}>
          ← 调查台
        </button>
        <button className="exportmd" onClick={exportMd} disabled={exporting}>
          {exporting ? '导出中…' : '导出 Markdown'}
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
        <header>
          <h1>{snap.case!.title}</h1>
          <p className="question">{snap.case!.question}</p>
          <p className="stamp">
            <span>
              按{SHAPE_COPY[plan.shape].label}装 · 主体是{SHAPE_COPY[plan.shape].body}
            </span>
            <span className="sep">·</span>
            <span>
              基准日 <code>{snap.case!.incidentDate}</code> {snap.case!.tzOffset}
            </span>
          </p>
          {/* 还没收尾时这份是**预览**：形态还会变，章节跟着变。说出来比让人以为它已经定了好 */}
          {!plan.frozen && (
            <p className="preview">
              这个案子还没收尾，形态是按现有数据推的，报告会跟着排查一起变。结案那一下才冻。
            </p>
          )}
          {/* 残报告顶上明写人为终止（ui.md §8.4）：它没有根因栏不是漏了，是没查出来 */}
          {plan.abortedAt !== null && (
            <p className="aborted">调查在第 {plan.abortedAt} 步被人为终止。以下是查到为止的部分。</p>
          )}
        </header>

        {plan.sections.map((s) => (
          <section key={s.id} id={`sec-${s.id}`}>
            <h2>
              {s.title}
              {/* 「哪些是投影、哪些是生成」对读者可见——把 D17 变成能自己验证的承诺 */}
              <em>{s.source}</em>
            </h2>
            <Body section={s} label={label} />
          </section>
        ))}

        <footer>
          Case {snap.case!.id} · {plan.evidenceCount} 条证据可在 Inquestry 溯源
        </footer>
      </article>
    </div>
  );
}

function Body({ section, label }: { section: ReportSection; label: (id: string) => string }) {
  const b = section.body;
  switch (b.kind) {
    case 'verdict':
      return (
        <>
          <p className="big">{b.text}</p>
          {b.confidence !== null && <p className="conf">置信度 {b.confidence.toFixed(2)}</p>}
        </>
      );

    case 'contrast':
      // 这一对是状态型的主体。缺了要说出来，而不是留一片视觉上的空白
      return b.expected || b.actual ? (
        <div className="contrast">
          <div>
            <span className="k">本该</span>
            <p>{b.expected ?? '——'}</p>
          </div>
          <div className="is">
            <span className="k">实际</span>
            <p>{b.actual ?? '——'}</p>
          </div>
        </div>
      ) : (
        <p className="none">根因那一步没有填应然 / 实然，这一块是空的。</p>
      );

    case 'timeline':
      return <Timeline rows={b.rows} label={label} />;

    case 'chain':
      return <Chain links={b.links} weakestId={b.weakestId} label={label} />;

    case 'split':
      return (
        <>
          {b.groups.length ? (
            <ul className="split">
              {b.groups.map((g) => (
                <li key={g.actor}>
                  <span className="who">{g.actor}</span>
                  <span className="n">{g.count} 条证据</span>
                  <span className="claims">{g.claims.map((c) => c.claim).join(' · ')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="none">证据上没有标出主体，切不出分组。</p>
          )}
          {(b.expected || b.actual) && (
            <div className="contrast">
              <div>
                <span className="k">干净的那组</span>
                <p>{b.expected ?? '——'}</p>
              </div>
              <div className="is">
                <span className="k">出问题的那组</span>
                <p>{b.actual ?? '——'}</p>
              </div>
            </div>
          )}
        </>
      );

    case 'matrix':
      return b.rows.length ? (
        <table className="matrix">
          <thead>
            <tr>
              <th>查过的方向</th>
              <th>结论</th>
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r) => (
              <tr key={r.stepId}>
                <td>{r.direction ?? label(r.stepId)}</td>
                <td>
                  {r.text}
                  {r.supersededBy && <em> ← 被 {label(r.supersededBy)} 推翻</em>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="none">没有排除掉任何方向。</p>
      );

    case 'path':
      return <Path rows={b.rows} label={label} />;

    case 'notes':
      return b.rows.length ? (
        <ul className="notes">
          {b.rows.map((r) => (
            <li key={r.stepId}>
              {r.direction && <b>{r.direction}</b>}
              {r.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="none">无。</p>
      );

    case 'prose':
      return b.text ? <p>{b.text}</p> : <p className="none">无。</p>;

    case 'absent':
      return <p className="none">{b.why}</p>;
  }
}

/**
 * 事故时间线画成真正的时间轴：一条竖线 + 圆点（ui.md §6）。
 *
 * 与调查台的轨道同一个母题，含义不同——那条是"我按什么顺序做的"，这条是
 * "系统当时按什么顺序发生的"。竖线只在时间轴内部出现，与「全屏唯一的曲线表示推翻」不冲突。
 */
function Timeline({ rows, label }: { rows: IncidentEntry[]; label: (id: string) => string }) {
  if (!rows.length) {
    return <p className="none">一条带时间的证据都没有。事故时间线由 occurredAt 投影而来。</p>;
  }
  return (
    <ol className="axis">
      {rows.map((r, i) => (
        <li key={i} className={r.stepStatus}>
          {/* 被推翻的 step 提供的证据照样在列：结论可以被推翻，事实不会。
              点填实 / 空心分的是"这条来自还成立的判定"还是"来自被推翻的那一步" */}
          <span className="dot" />
          <span className="when">{r.occurredAtRaw ?? new Date(r.occurredAtMs).toISOString()}</span>
          <span className="what">
            {r.actor && <b>{r.actor}</b>}
            {r.claim}
          </span>
          <span className="from">{label(r.stepId)}</span>
        </li>
      ))}
    </ol>
  );
}

/** 因果链：每环带置信度，最弱一环单独标出来——它是最先该被追问的地方。 */
function Chain({
  links,
  weakestId,
  label,
}: {
  links: ChainLink[];
  weakestId: string | null;
  label: (id: string) => string;
}) {
  if (!links.length) return <p className="none">还没有已证实的环节。</p>;
  return (
    <ol className="chain">
      {links.map((l) => (
        <li key={l.stepId} className={l.stepId === weakestId ? 'weak' : ''}>
          <span className="n">{label(l.stepId)}</span>
          <span className="what">
            {l.direction && <b>{l.direction}</b>}
            {l.verdict}
          </span>
          {l.confidence !== null && <span className="conf">{l.confidence.toFixed(2)}</span>}
          {l.stepId === weakestId && <span className="tag">最弱一环</span>}
          {l.isRoot && <span className="tag root">根因</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * 排查路径含走错的分支。**被推翻的强制留在这儿并划掉**，不洗成一路顺利的叙事——
 * 删掉它就成了假历史，而"查过哪些方向"正是下一个人最需要的东西。
 */
function Path({ rows, label }: { rows: StepNode[]; label: (id: string) => string }) {
  if (!rows.length) return <p className="none">还没有任何一步。</p>;
  return (
    <ol className="path">
      {rows.map((s) => (
        <li key={s.id} className={s.status}>
          <span className="n">{label(s.id)}</span>
          <span className="what">
            {s.direction ?? '（未归类）'}
            {s.verdict && <em>{s.verdict}</em>}
          </span>
          {s.supersededBy && <span className="by">← 被 {label(s.supersededBy)} 推翻</span>}
          <span className="cnt">
            {s.calls.length} 次调用 · {s.evidence.length} 条证据
          </span>
        </li>
      ))}
    </ol>
  );
}
