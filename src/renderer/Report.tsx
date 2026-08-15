/**
 * 报告屏（D21 / D22）。
 *
 * **它是一个屏，不是工作区上的一个 tab**：主角从"假设与分叉"换成"结论与证据"，
 * 能做的只有导出与收尾，内容在定稿那一下冻住。色板与工作区完全相同，差别只来自密度与字号
 * （ui.md §1 那张表）——一深一浅会被读成两个应用，而这是同一个工具的两个阶段。
 *
 * **收尾那两档（定稿 / 归档）的入口在这儿，不在工作区顶栏。** 调查到任意进度都能进来看：
 * 没收尾时这份是预览，看完可以就此定稿，也可以直接把半成品导出去。原先把「定稿」摆在
 * 工作区顶栏，等于要人在没看过报告的情况下决定"这份能不能交出去"——而那正是这一屏回答的问题。
 *
 * **单列长页：没有 tab、没有折叠、没有内部滚动。** 这不是审美偏好，是被长图导出倒逼的——
 * 凡是要点击才能看到的内容，截图里就不存在（ui.md §7.2）。顶部那条只是锚点导航，
 * 点击只滚动、不隐藏任何东西，导出时整条移除。
 *
 * 章节怎么组装不在这儿：`shared/report.ts` 是那一份，两种导出共用它。
 * 正文怎么画也不在这儿：`ReportPaper.tsx` 是那一份，长图视图共用它。
 */

import { useRef, useState } from 'react';
import {
  VERDICT_SHAPES,
  type ClosingStepKind,
  type ExportResult,
  type ShapeSuggestion,
  type Snapshot,
  type VerdictShape,
} from '../shared/ipc.js';
import { Icon } from './Icon.js';
import { PaperFoot, ReportPaper } from './ReportPaper.js';
import { reportInput, reportPlan, SHAPE_COPY } from '../shared/report.js';
import { stateFillable } from './drafts.js';

/** 回执里只印文件名：路径已经在前半句里了，再重复一遍整条路径会把那一行挤爆。 */
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function Report({
  snap,
  onBack,
  onNotice,
}: {
  snap: Snapshot;
  onBack: () => void;
  /** 收尾没落地时的提示挂到应用级：那时这一屏多半已经不是刚才那个调查了。 */
  onNotice: (text: string) => void;
}) {
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

  /**
   * 收尾要人再点一下的那两档（D29）。**必须连 caseId 一起记**：确认条挂在屏幕上的这段时间里
   * 调查可能被切走，而按钮那一下取的是**当时**的 case——只记动作的话，会把另一次调查
   * 不可逆地收掉，而确认文案讲的还是这一次的事。
   *
   * 这一屏只在 `reportOf === 当前调查` 时才挂得出来，切走了整屏就卸载、这条 state 随之蒸发；
   * 即便如此仍然自己带上下文——它是全应用唯一一个"点下去没有回头路"的手势。
   */
  const [confirm, setConfirm] = useState<{
    caseId: string;
    kind: 'closed' | 'aborted';
    /**
     * 报告按哪种形态装（D25）。**跟着这条 state 走，不每帧从快照取**：
     * 快照每 60ms 一轮，而人正在这条确认条上挑——取快照的话手上选的会被下一轮冲掉。
     * 归档那一档没有它：半程报告强制是未决型，不给选（ui.md §8.4）。
     */
    shape?: VerdictShape;
    /**
     * 弹出那一刻 main 算出来的**整份**建议，原样冻住。只冻形态的话，各项会指着不同的根因：
     * 屏幕上是弹出时那个推断值，标签却成了"agent 声明的"；更糟的是根因整个换了人，
     * "这一块会是空的"按旧根因判定成不必提醒，人于是在毫不知情下冻出一份空主体报告。
     */
    suggestion?: ShapeSuggestion;
    /**
     * 人动过手没有。**必须显式记，不能拿"当前值 ≠ 建议值"推**：挑过别的又切回建议值那一档
     * 会重新显示成 agent 声明的，而建议值自己变了的话，人一下没碰过也会被标成"你选的"。
     */
    picked?: true;
  } | null>(null);

  /**
   * 点「定稿」。**先问 main 现在还差什么，再决定弹确认还是派活**——
   * 不拿快照上的 `closingGaps` 做这个判断：它是 60ms 合流推来的，agent 可能刚补完最后一步
   * 而这一屏还没收到，那时按钮上写着"差 1 步"、点下去却会走进执行路径，
   * 把调查不可逆地冻上且完全没经过确认。
   *
   * 缺步时不是报个错就完：那两步的内容只有查过的人给得出来，所以派给 agent 去补。
   */
  const requestClose = async () => {
    const caseId = snap.case?.id;
    if (!caseId) return;
    const r = await window.inquestry.requestClosing(caseId).catch(() => null);
    if (!r) return onNotice('没问到这次调查的状态，可能它已经切走了。切回去再点一次。');
    if (!r.missing.length) {
      // 冻的是 **main 刚刚算出来的那一份**，不是这一屏快照上的：后者是点击那一帧的闭包值，
      // 隔着这次 await——main 按最新状态放行了弹窗，界面却会冻一个过期的推断值
      return setConfirm({ caseId, kind: 'closed', shape: r.suggestion.shape, suggestion: r.suggestion });
    }
    const what = r.missing.map(closingLabel).join('与');
    onNotice(
      r.asked
        ? `定稿前还差${what}，已经让 agent 去补了。补完再点一次定稿。`
        : `定稿前还差${what}。先回工作区让 agent 补上这两步；就此收手请用归档。`,
    );
  };

  /**
   * 确认那一下的落地回执。**没落地就别把确认条收掉**——确认条挂在屏幕上的这段时间里，
   * 强制 step 可能被推翻、调查可能被切走，两种情况 main 都会回绝；
   * 收掉确认条而什么都没发生的话，人会以为已经定稿了。
   */
  const doClose = async (kind: 'closed' | 'aborted', id: string, shape: VerdictShape) => {
    if (kind === 'aborted') {
      const ok = await window.inquestry.archiveCase(id).catch(() => false);
      if (ok) return setConfirm(null);
      return onNotice('归档没执行：这次调查已经不是当前调查了。切回去再试一次。');
    }
    const r = await window.inquestry.closeCase(id, shape).catch(() => null);
    if (r?.ok) return setConfirm(null);
    onNotice(
      r && !r.ok && r.missing.length
        ? `定稿没执行：刚才这会儿又缺了${r.missing.map(closingLabel).join('与')}——多半是那一步刚被推翻。补上再来。`
        : '定稿没执行：这次调查已经不是当前调查了。切回去再试一次。',
    );
  };

  const frozen = !!snap.case && snap.case.status !== 'open';

  const input = reportInput(snap);
  if (!input) return null;
  const plan = reportPlan(input);

  return (
    <div className="reportscreen" ref={page}>
      {/* 导航与返回是交互件，导出视图里不会有它们（ui.md §7.2） */}
      <nav className="anchors" ref={nav}>
        <button className="back" onClick={onBack}>
          <Icon name="back" />
          工作区
        </button>
        <button
          className="exportmd"
          onClick={() => runExport('md', (id) => window.inquestry.exportMarkdown(id))}
          disabled={exporting !== null}
        >
          <Icon name="download" />
          {exporting === 'md' ? '导出中…' : '导出 Markdown'}
        </button>
        <button
          className="exportimg"
          onClick={() => runExport('img', (id) => window.inquestry.exportImage(id))}
          disabled={exporting !== null}
        >
          <Icon name="download" />
          {exporting === 'img' ? '导出中…' : '导出长图'}
        </button>
        {/* 收尾两档摆在导出旁边：这一屏上「交出去」与「就此收手」是同一个决定的两半。
            **停止不在此列**——它中断的是一轮，属于工作区那条状态栏 */}
        {!frozen && (
          <>
            <button className="finish" title="下结论并冻结这次调查" onClick={() => void requestClose()}>
              <Icon name="seal" />
              定稿{snap.closingGaps.length ? `（差 ${snap.closingGaps.length} 步）` : ''}
            </button>
            <button
              className="finish"
              title="放弃这次调查；证据全部保留，半程报告照旧能导"
              onClick={() => snap.case && setConfirm({ caseId: snap.case.id, kind: 'aborted' })}
            >
              <Icon name="archive" />
              归档
            </button>
          </>
        )}
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

      {confirm?.caseId === snap.case?.id && confirm && (
        <div className="banner confirm">
          <span>{confirmText(confirm.kind, snap)}</span>
          <button
            className="primary"
            // 收的是**弹出确认时**那次调查，不是此刻屏幕上的那个。main 那侧还会用 `currentIf`
            // 再核一次：切走了就整个不执行，而回绝了这边要说出来，见 doClose
            onClick={() => void doClose(confirm.kind, confirm.caseId, confirm.shape ?? 'open')}
          >
            {confirm.kind === 'closed' ? '确认定稿' : '确认归档'}
          </button>
          <button onClick={() => setConfirm(null)}>再想想</button>
          {confirm.kind === 'closed' && (
            <ShapePicker
              value={confirm.shape ?? snap.shapeSuggestion.shape}
              source={confirm.picked ? 'operator' : (confirm.suggestion ?? snap.shapeSuggestion).source}
              // 状态型的主体就是应然/实然那一对；根因那一步没给的话，选它等于让报告
              // 装一块空的。冻结之后没有回头路，所以要在人按下去**之前**说
              stateFillable={stateFillable(confirm.suggestion, snap.shapeSuggestion)}
              onPick={(shape) => setConfirm((c) => c && { ...c, shape, picked: true })}
            />
          )}
        </div>
      )}

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

function closingLabel(k: ClosingStepKind) {
  return ({ impact: '影响面', leftover: '遗留问题' } as const)[k];
}

/**
 * 定稿那一下选报告形态。**它是这一步唯一需要人做的判断**——
 * agent 声明过就预选它的，没声明就预选推断值，人不动手也能一路按到底。
 *
 * 摆在确认条里而不是单开一屏：形态决定报告装哪几块，而"确认定稿"正是唯一
 * 看得见后果的那一下；分开的话，人会在不知道要选什么的时候先被问一次。
 */
function ShapePicker({
  value,
  source,
  stateFillable,
  onPick,
}: {
  value: VerdictShape;
  source: 'agent' | 'inferred' | 'operator';
  /** 根因那一步给了应然/实然没有。没给的话状态型的主体块是空的。 */
  stateFillable: boolean;
  onPick: (s: VerdictShape) => void;
}) {
  // 不禁用这一档，只把后果说出来：人可能确实知道这是状态型故障，而 agent 没填那一对——
  // 那一步已经收口了，它补不回来，禁掉等于把人堵死在一个它自己造成的缺口上
  const empty = value === 'state' && !stateFillable;
  return (
    <div className="shape">
      <span className="lead">
        报告按
        <b>{SHAPE_COPY[value].label}</b>
        装（主体是{SHAPE_COPY[value].body}）
        <em>{shapeSourceLabel(source)}</em>
        {empty && <span className="warn">根因那一步没有应然 / 实然，这一块会是空的</span>}
      </span>
      {VERDICT_SHAPES.map((s) => (
        <button
          key={s}
          className={`${s === value ? 'on' : ''} ${s === 'state' && !stateFillable ? 'thin' : ''}`}
          title={
            s === 'state' && !stateFillable
              ? '状态型 —— 主体是应然 / 实然对照，但根因那一步没给这一对，选了那一块会是空的'
              : `${SHAPE_COPY[s].when} —— 主体是${SHAPE_COPY[s].body}`
          }
          onClick={() => onPick(s)}
        >
          {SHAPE_COPY[s].label}
        </button>
      ))}
    </div>
  );
}

/** 推断值只是个不至于装错块的兜底，不是一次判断——两者必须让人一眼分得出来。 */
function shapeSourceLabel(source: 'agent' | 'inferred' | 'operator') {
  return { agent: 'agent 声明的', inferred: '没人声明过，按现有数据推的', operator: '你选的' }[source];
}

/** 确认那一下要说的是**后果**，不是"你确定吗"——两档的后果不一样，说反了就白确认了。 */
function confirmText(kind: 'closed' | 'aborted', snap: Snapshot) {
  if (kind === 'closed') {
    return `定稿会冻结这次调查：不能再开会话，只能导出。根因取的是当前置信度最高的那条结论${
      snap.report.rootCause ? `（${snap.report.rootCause.text.slice(0, 40)}…）` : '——目前一条已证实的都没有'
    }。`;
  }
  return '归档 = 明写放弃这次调查。已经查到的证据一条都不删，仍能导出半程报告——但那份报告没有根因栏，主体是排除掉的方向与遗留问题。';
}
