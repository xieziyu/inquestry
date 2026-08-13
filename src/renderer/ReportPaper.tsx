/**
 * 报告正文的渲染。**报告屏与长图导出共用这一份**（ui.md §7.2）：长图不是报告页的截图，
 * 是同一份内容的另一个渲染目标——各写一遍的结果必然是图片里的那份与屏幕上的那份对不上，
 * 而图片正是这个工具被转发得最多的产物。
 *
 * 章节装哪几块仍然只认 `reportPlan()`（`shared/report.ts`）。这里只管画，不挑内容：
 * 在这儿加一句 `if (…)` 就是第三个"有数据就装"的入口（ui.md §7.1）。
 *
 * 两个视图的差别只在**外壳**：屏幕那份带锚点导航与导出按钮，图片那份按页切开、每页带水印。
 * 所以壳留给各自的调用方，这里只吐块。
 */

import type { CaseMeta, IncidentEntry, StepNode } from '../shared/ipc.js';
import { HEAD_BLOCK } from '../shared/paging.js';
import { SHAPE_COPY, type ChainLink, type ReportPlan, type ReportSection } from '../shared/report.js';

/**
 * @param only 只画这几块（长图的某一页）。不给就是整份。
 */
export function ReportPaper({
  meta,
  plan,
  only,
}: {
  meta: CaseMeta;
  plan: ReportPlan;
  only?: readonly string[];
}) {
  const show = (id: string) => !only || only.includes(id);
  /** 认不出的引用原样印 id：印错一个编号比印一个陌生 id 更糟。 */
  const label = (stepId: string) => plan.labels[stepId] ?? stepId;

  return (
    <>
      {show(HEAD_BLOCK) && (
        <header data-block={HEAD_BLOCK}>
          <h1>{meta.title}</h1>
          <p className="question">{meta.question}</p>
          <p className="stamp">
            <span>
              按{SHAPE_COPY[plan.shape].label}装 · 主体是{SHAPE_COPY[plan.shape].body}
            </span>
            <span className="sep">·</span>
            <span>
              基准日期 <code>{meta.incidentDate}</code> {meta.tzOffset}
            </span>
          </p>
          {/* 还没收尾时这份是**预览**：形态还会变，章节跟着变。说出来比让人以为它已经定了好 */}
          {!plan.frozen && (
            <p className="preview">
              这次排查还没收尾，形态是按现有数据推的，报告会跟着排查一起变。定稿那一下才冻。
            </p>
          )}
          {/* 半程报告顶上明写人为终止（ui.md §8.4）：它没有根因栏不是漏了，是没查出来 */}
          {plan.abortedAt !== null && (
            <p className="aborted">排查在第 {plan.abortedAt} 步被人为终止。以下是查到为止的部分。</p>
          )}
        </header>
      )}

      {plan.sections.filter((s) => show(s.id)).map((s) => (
        <section key={s.id} id={`sec-${s.id}`} data-block={s.id}>
          <h2>
            {s.title}
            {/* 「哪些是投影、哪些是生成」对读者可见——把 D17 变成能自己验证的承诺 */}
            <em>{s.source}</em>
          </h2>
          <Body section={s} label={label} />
        </section>
      ))}
    </>
  );
}

/**
 * 页脚水印。**每一页都有**（ui.md §7.2）：长图会被转发到看不见上下文的地方，
 * 只有第一页带编号的话，被转走的那一页就成了一段无从溯源的截图。
 *
 * `generatedAt` 由调用方给（同 Markdown 那条）：自己读时钟的话同一次排查导两次的产物不同，
 * 既没法比对两版报告，也没法拿检查兜住这一行。屏幕上那份不印时间——它跟着数据一直在变。
 */
export function PaperFoot({
  meta,
  plan,
  generatedAt,
}: {
  meta: CaseMeta;
  plan: ReportPlan;
  generatedAt?: string;
}) {
  return (
    <footer>
      Case {meta.id}
      {generatedAt && ` · ${generatedAt}`} · {plan.evidenceCount} 条证据可在 Inquestry 溯源
    </footer>
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
 * 系统时间线画成真正的时间轴：一条竖线 + 圆点（ui.md §6）。
 *
 * 与排查台的轨道同一个母题，含义不同——那条是"我按什么顺序做的"，这条是
 * "系统当时按什么顺序发生的"。竖线只在时间轴内部出现，与「全屏唯一的曲线表示推翻」不冲突。
 */
function Timeline({ rows, label }: { rows: IncidentEntry[]; label: (id: string) => string }) {
  if (!rows.length) {
    return <p className="none">一条带时间的证据都没有。系统时间线由 occurredAt 投影而来。</p>;
  }
  return (
    <ol className="axis">
      {rows.map((r, i) => (
        <li key={i} className={r.stepStatus}>
          {/* 被推翻的 step 提供的证据照样在列：结论可以被推翻，事实不会。
              点填实 / 空心分的是"这条来自还成立的结论"还是"来自被推翻的那一步" */}
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
