/**
 * 报告正文的渲染。**报告屏与长图导出共用这一份**（ui.md §7.2）：长图不是报告页的截图，
 * 是同一份内容的另一个渲染目标——各写一遍的结果必然是图片里的那份与屏幕上的那份对不上，
 * 而图片正是这个工具被转发得最多的产物。
 *
 * 章节装哪几块、什么顺序只认 `reportPlan()`（`shared/report.ts`）——**门槛全在那一份里**。
 * 这里只管画：在这儿补一句 `if (…)` 就是第二处判"装不装"的地方，而两处迟早对不上，
 * 表现是屏幕上有这一节、Markdown 里没有（ui.md §7.1）。
 *
 * 两个视图的差别只在**外壳**：屏幕那份带锚点导航与导出按钮，图片那份按页切开、每页带水印。
 * 所以壳留给各自的调用方，这里只吐块。
 */

import { BOUND_MARK, type CaseMeta, type IncidentEntry, type Metric, type Roster, type StepNode } from '../shared/ipc.js';
import { HEAD_BLOCK } from '../shared/paging.js';
import {
  SHAPE_COPY,
  abortedNote,
  directionText,
  type ChainLink,
  type ReportPlan,
  type ReportSection,
} from '../shared/report.js';

/**
 * @param only 只画这几块（长图的某一页）。不给就是整份。
 */
export function ReportPaper({
  meta,
  plan,
  only,
  anchors = true,
}: {
  meta: CaseMeta;
  plan: ReportPlan;
  only?: readonly string[];
  /**
   * 小节要不要带 `id`。报告屏上同一份纸会**在同一个文档里画好几遍**（正文一遍、
   * 交付台的缩略一遍、导出预览里再一遍），带 id 的话同一个 `sec-*` 出现多次：
   * 锚点跳转会跳到先出现的那一个，看着像"点了没反应"。缩略那几份传 `false`。
   */
  anchors?: boolean;
}) {
  const show = (id: string) => !only || only.includes(id);
  /** 认不出的引用原样印 id：印错一个编号比印一个陌生 id 更糟。 */
  const label = (stepId: string) => plan.labels[stepId] ?? stepId;

  return (
    <>
      {show(HEAD_BLOCK) && (
        <header data-block={HEAD_BLOCK}>
          {/* 左边是这次调查在问什么，右边是它的身份证。1240 的宽度本来就摊得开，
              挤成一行读起来像状态栏 */}
          <div className="ask">
            <h1>{meta.title}</h1>
            <p className="question">{meta.question}</p>
          </div>
          <dl className="idcard">
            <dt>Case</dt>
            <dd>{meta.id}</dd>
            <dt>基准日期</dt>
            <dd>{meta.incidentDate}</dd>
            <dt>时区</dt>
            <dd>{meta.tzOffset}</dd>
            <dt>证据</dt>
            <dd>{plan.evidenceCount}</dd>
          </dl>
          {/* 只盖形态这一枚戳，不在纸头上解释它：出处、主体装没装出来这些话下面每一节都在自陈，
              摆在标题下面只会抢在正文前面被读一遍。「草稿」留着——长图会被转发到看不见
              上下文的地方，一份还会变的报告不标出来就成了一句定论 */}
          <p className="stamp">
            <span className="shape">{SHAPE_COPY[plan.shape].label}</span>
            {!plan.frozen && <span className="draft">草稿</span>}
          </p>
          {/* 半程报告顶上明写人为终止（ui.md §8.4）：它没有根因栏不是漏了，是没查出来 */}
          {plan.abortedAt !== null && <p className="aborted">{abortedNote(plan.abortedAt)}</p>}
        </header>
      )}

      {plan.sections.filter((s) => show(s.id)).map((s) => (
        <section key={s.id} id={anchors ? `sec-${s.id}` : undefined} data-block={s.id}>
          <h2>{s.title}</h2>
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
 * `generatedAt` 由调用方给（同 Markdown 那条）：自己读时钟的话同一次调查导两次的产物不同，
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
      // 原样一段印出来，不拆句也不提级：agent 写的是什么样就是什么样，
      // 排版不替它划重点——划错的时候比不划更难读
      return (
        <div className="rootblock">
          <p>{b.text}</p>
          {b.confidence !== null && (
            <p className="conf">
              置信度 {b.confidence.toFixed(2)}
              <span className="bar">
                <i style={{ width: `${Math.round(b.confidence * 100)}%` }} />
              </span>
            </p>
          )}
        </div>
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

    case 'roster':
      return <RosterBlock roster={b.roster} from={label(b.stepId)} />;

    case 'impact':
      // 🔴 **「无。」只在两半都空时才出**，与 Markdown 那边逐字同一条规则：
      // 只看 `text` 的话，一份只填了 metrics 的影响面会先写一句「无。」、紧接着列出几个数，
      // 而 Markdown 那份没有这句——同一次调查的两种导出于是互相矛盾
      return (
        <>
          {b.text ? <p>{b.text}</p> : b.metrics.length ? null : <p className="none">无。</p>}
          {b.metrics.length > 0 && <Metrics rows={b.metrics} />}
        </>
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
 * 名单：**一列裸 id**，外加一行说清这份名单的口径（overview.md 的「产出物」）。
 *
 * 🔴 **id 那一列不许掺别的东西。** 这一节存在的全部理由是"读者要把它整列复制走"——
 * 在 id 旁边并排印备注、序号、状态，看着更丰富，实际是把复制出来的东西变成了需要再清洗一遍
 * 的文本。所以备注单开一列（复制时是另一列），口径与条数摆在列表**外面**的一行里。
 *
 * 条数印出来而不是让人自己数：它是读者真会拿去汇报的那个数，而"到底几条"正是
 * 这一节相对于一段散文最先兑现的价值。
 */
function RosterBlock({ roster, from }: { roster: Roster; from: string }) {
  const noted = roster.items.some((i) => i.note);
  return (
    <div className="roster">
      <p className="rmeta">
        <b>{roster.label}</b>
        <span className="n">
          {roster.items.length} 个 {roster.idKind}
        </span>
        {/* 「不是全集」要显眼：它决定读者敢不敢直接照这份去处置。全集那一档也印出来，
            不印的话读者无从知道这份到底被判成了什么——缺省沉默会被读成"应该是全的" */}
        <span className={roster.complete ? 'tag' : 'tag partial'}>
          {roster.complete ? '全集' : '下界，不是全集'}
        </span>
        {/* 被工具截过要单独标出来：它与"agent 自己就只捞到这么多"都落在下界那一档，
            而前者意味着这份报告漏掉了它本来查到的东西——那是要回头重来的信号 */}
        {roster.truncated ? <span className="tag partial">已截掉 {roster.truncated} 条</span> : null}
        <span className="from">出自 {from}</span>
      </p>
      {/* 口径空着照实说，不留白：留白读起来像"这批没有边界"，而实际是没填 */}
      {roster.basis ? (
        <p className="basis">{roster.basis}</p>
      ) : (
        <p className="basis none">口径没填。这份名单是怎么圈出来的、边界在哪，报告里没有。</p>
      )}
      <table className="rlist">
        <thead>
          <tr>
            <th>{roster.idKind}</th>
            {noted && <th>备注</th>}
          </tr>
        </thead>
        <tbody>
          {roster.items.map((it) => (
            <tr key={it.id}>
              <td className="id">{it.id}</td>
              {noted && <td>{it.note ?? ''}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 影响面里的那几个数。**界的记号印在值前面**（`≥` / `≤`），口径单独一列。
 *
 * 口径那一列不许省：一个没有口径的"受影响 2 人"与一句"近 30 天内至少 2 人，更早的查不到"
 * 是两个不同的事实，而读者只会拿前者去汇报。
 */
function Metrics({ rows }: { rows: Metric[] }) {
  return (
    <table className="metrics">
      <thead>
        <tr>
          <th>指标</th>
          <th>值</th>
          <th>口径</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m, i) => (
          <tr key={i}>
            <td>{m.label}</td>
            <td className={m.bound === 'exact' ? 'v' : 'v bounded'}>
              {BOUND_MARK[m.bound]}
              {m.value}
            </td>
            {/* 同名单那条：破折号读起来像"这个数没有口径限制"，而实际是没填 */}
            <td className={m.basis ? 'basis' : 'basis none'}>{m.basis || '口径没填'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 系统时间线画成真正的时间轴：一条竖线 + 圆点（ui.md §6）。
 *
 * 与工作区的轨道同一个母题，含义不同——那条是"我按什么顺序做的"，这条是
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
            {/* 兜底句按 lane 分派（`directionText`）：这一节里剩下的只有支线兜底，
                写死一句「（未归类）」等于把一条跑完的子 agent 支线印成分类失败 */}
            {directionText(s)}
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
