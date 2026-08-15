/**
 * 报告屏（D21 / D22）。
 *
 * **它是一个屏，不是工作区上的一个 tab**：主角从"假设与分叉"换成"结论与证据"，
 * 能做的只有导出与收尾，内容在定稿那一下冻住。色板与工作区完全相同，差别只来自密度与字号
 * （ui.md §1 那张表）——一深一浅会被读成两个应用，而这是同一个工具的两个阶段。
 *
 * **顶栏与别的屏共用同一条 `.pagehead`。** 一度自己另起一条页头（返回与导出挤在一条锚点导航上），
 * 于是同一个应用里出现了两种顶栏，差别一大就读成两个界面。这一屏在顶栏上只有一枚
 * 「工作区」，位置与工作区那两枚一样。
 *
 * **三样东西各归各位：**
 * - **形态**在纸头（`ShapeBar`）——它决定这份纸装哪几块，点一下当场换装。
 *   定稿冻的就是屏上此刻这一份，人于是不必在没见过的选项上按不可逆那一下
 * - **章节导航**在左侧竖栏（`Toc`）——每一节带一行读数，所以它跟着形态一起变
 * - **两种导出与收尾两档**在页尾的交付台（`Handoff`）——读完之后才回答"这份能不能交出去"
 *
 * **纸仍是单列长页：没有 tab、没有折叠、没有内部滚动。** 这不是审美偏好，是被长图导出倒逼的——
 * 凡是要点击才能看到的内容，截图里就不存在（ui.md §7.2）。章节栏、交付台与导出预览
 * 都在纸**之外**，一个字都不进任何一份导出，所以那条约束管不到它们。
 *
 * 章节怎么组装不在这儿：`shared/report.ts` 是那一份，两种导出共用它。
 * 正文怎么画也不在这儿：`ReportPaper.tsx` 是那一份，长图视图共用它。
 */

import { useEffect, useRef, useState } from 'react';
import {
  VERDICT_SHAPES,
  type CaseMeta,
  type ClosingStepKind,
  type ShapeSuggestion,
  type Snapshot,
  type VerdictShape,
} from '../shared/ipc.js';
import { Icon } from './Icon.js';
import { PaperFoot, ReportPaper } from './ReportPaper.js';
import { reportInput, reportPlan, SHAPE_COPY, type ReportPlan } from '../shared/report.js';
import { reportMarkdown } from '../shared/markdown.js';
import { stateFillable } from './drafts.js';

/** 回执里只印文件名：路径已经在前半句里了，再重复一遍整条路径会把那一行挤爆。 */
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** 交付台那一格的锚点 id。章节栏最后一格跳的就是它。 */
const HANDOFF = 'handoff';

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
  /**
   * 人在纸头上预演的那个形态。`null` = 没动过手，跟着建议值走。
   *
   * **不能拿"当前值 ≠ 建议值"反推人动没动手**（同确认条那条老纪律）：挑过别的又切回建议值
   * 会重新显示成「agent 声明的」，而建议值自己变了的话，人一下没碰过也会被标成「你选的」。
   */
  const [pick, setPick] = useState<VerdictShape | null>(null);
  /**
   * 导出的回执。**成功与失败都要说出来**：写盘失败与人自己按取消在界面上长得一样
   * （都是"按了导出、什么都没发生"），而前者意味着报告压根没落地。
   */
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null);
  /** 哪一种正在导。两个按钮各自置灰，不共用一个 boolean——否则导长图时另一个也说"导出中"。 */
  const [exporting, setExporting] = useState<'md' | 'img' | null>(null);
  /** 导出预览开在哪个目标上。`null` = 没开。 */
  const [view, setView] = useState<'md' | 'img' | null>(null);
  /**
   * 预览里那份 Markdown 的生成时间。**取一次，此后不动**：`reportMarkdown` 不读时钟
   * （生成时间由调用方给），而这一屏每 60ms 重渲染一次——每帧现取的话页脚会一直跳。
   *
   * ⚠️ 一度传 `0`，于是预览的页脚上印着 1970 年。这一份是给人核对"交出去长什么样"的，
   * 印一个明显错的元数据比不印更糟。真导出那一份由 main 用**落盘那一刻**填，两者差几秒。
   */
  const [previewStamp] = useState(() => Date.now());

  /**
   * 收尾要人再点一下的那一档（D29）。**必须连 caseId 一起记**：确认块挂在屏幕上的这段时间里
   * 调查可能被切走，而按钮那一下取的是**当时**的 case——只记动作的话，会把另一次调查
   * 不可逆地收掉，而确认文案讲的还是这一次的事。
   */
  const [confirm, setConfirm] = useState<{
    caseId: string;
    kind: 'closed' | 'aborted';
    /**
     * 报告按哪种形态装（D25）。**它必须恒等于屏上这份纸装的那一个**——这条不变式由
     * 上面那个 effect 守着，一不相等就把整块作废。不每帧从快照取是因为快照 60ms 一轮，
     * 人正在这块上读字；但也不能就此不管它变没变，那两条正好是同一枚硬币的两面。
     * 归档那一档没有它：半程报告强制是未决型，不给选（ui.md §8.4）。
     */
    shape?: VerdictShape;
    /**
     * 弹出那一刻 main 算出来的**整份**建议，原样冻住。只冻形态的话，各项会指着不同的根因：
     * 屏幕上是弹出时那个推断值，标签却成了"agent 声明的"；更糟的是根因整个换了人，
     * "这一块会是空的"按旧根因判定成不必提醒，人于是在毫不知情下冻出一份空主体报告。
     */
    suggestion?: ShapeSuggestion;
  } | null>(null);

  const frozen = !!snap.case && snap.case.status !== 'open';
  /** 冻结之后事后没有入口再改（ui.md §6），预演值一并作废——留着会让屏上那份与库里不同。 */
  const effectivePick = frozen ? null : pick;

  const input = reportInput(snap, effectivePick);
  const plan = input && reportPlan(input);

  /**
   * 屏上这份纸此刻装的是哪个形态。
   *
   * **渲染时同步，不走 effect**：effect 排在绘制之后，而这个值要给"点定稿"那条
   * 隔着一次 await 的回调读——晚一拍读到的就是过期值，正是它要防的那一种。
   */
  const shownShape = useRef<VerdictShape | null>(null);
  shownShape.current = plan?.shape ?? null;

  /**
   * 🔴 **确认块上写的形态必须与屏上这份纸是同一个，不一样就当场作废。**
   *
   * 这是全应用唯一不可逆的那一下，它唯一的失效方式是"用了过期的上下文"。而形态在确认块
   * 挂着的这段时间里有两条路会变：人在纸头又挑了一个，或者 agent 改了声明、下一份快照
   * 把建议值换掉了。两条都会让纸重绘而确认块岿然不动——于是冻下去的是一份屏幕上
   * 从没显示过的章节组合。
   *
   * **一条规则管两条路**，不在每个写入点各补一次：漏掉哪一条都不报错，只是安静地冻错。
   */
  useEffect(() => {
    if (confirm?.kind === 'closed' && confirm.shape !== plan?.shape) setConfirm(null);
  }, [confirm, plan?.shape]);

  /**
   * 跳到某一节。落点要让开顶栏那么高的一条，否则标题正好贴在栏底下沿，
   * 读者落在正文中间却看不见自己跳到了哪一节。
   *
   * 全是同步的布局读数，不依赖帧——`behavior:'smooth'` 与 `ResizeObserver` 在没获焦点的
   * 窗口里一次都不跑（ui.md §11 那条过期帧的同族），留下的是一个悄悄过期的偏移量。
   */
  const jumpTo = (id: string) => {
    const host = page.current;
    const el = host?.querySelector(id === HANDOFF ? '#handoff' : `#sec-${id}`);
    if (!host || !el) return;
    host.scrollTop += el.getBoundingClientRect().top - host.getBoundingClientRect().top - 20;
  };

  /**
   * 导出走 main：那边才有库与文件系统，且**由 main 拿它自己那份快照渲染**——
   * 界面这份最多晚 60ms，导出的是一份要交出去的文档，不该差着一拍。
   *
   * 两种导出这一段一模一样，**回执与失败分档也就该一模一样**：一份能说出路径、
   * 另一份只会静默，人会以为那一种坏了。
   */
  const runExport = async (kind: 'md' | 'img') => {
    const caseId = snap.case?.id;
    if (!caseId) return;
    // 两种导出**同时只准跑一个**：`exporting` 只记得住一个，两条并着跑的话先回来的那条
    // 会把另一条的状态清成 null——按钮提前恢复、还能再按一次，回执也可能被旧的那条盖掉
    if (exporting) return;
    setExporting(kind);
    try {
      // 🔴 **把屏上这个形态一起带过去**：main 那侧不传就照 agent 的建议值另装一遍，
      // 于是屏幕上看的是因果链型、落盘的却是时序型——章节集合都不一样，而两边都不报错。
      // 数据仍由 main 拿它自己那份快照出（界面这份最多晚 60ms），这里只带人挑的那个判断
      const r = await (kind === 'md'
        ? window.inquestry.exportMarkdown(caseId, effectivePick)
        : window.inquestry.exportImage(caseId, effectivePick));
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
   * 点「定稿」。**先问 main 现在还差什么，再决定展开确认还是派活**——
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
      // 🔴 **冻的是屏上此刻装着的那一个**，取自 ref 不取闭包：`pick` 与 `plan` 都是点击
      // 那一帧的值，而这中间隔着一次 await——人在等 main 回话的这段时间里完全可以再挑一个，
      // 取闭包的话确认块会带着旧形态挂出来，而纸已经按新的重绘了。
      // 也不取 `r.suggestion.shape`：那是 main 刚算的，可能比这一屏的快照新一拍，
      // 用它同样会让确认块与纸各说各的。**人只能冻他看见过的那一份。**
      //
      // ⚠️ 建议值那一整份仍然要冻（`suggestion`）：它给的是"状态型填不填得出来"要按哪个
      // 根因判（见 `stateFillable`），与形态是两件事。
      const shape = shownShape.current;
      if (!shape) return;
      return setConfirm({ caseId, kind: 'closed', shape, suggestion: r.suggestion });
    }
    const what = r.missing.map(closingLabel).join('与');
    onNotice(
      r.asked
        ? `定稿前还差${what}，已经让 agent 去补了。补完再点一次定稿。`
        : `定稿前还差${what}。先回工作区让 agent 补上这两步；就此收手请用归档。`,
    );
  };

  /**
   * 确认那一下的落地回执。**没落地就别把确认块收掉**——它挂在屏幕上的这段时间里，
   * 强制 step 可能被推翻、调查可能被切走，两种情况 main 都会回绝；
   * 收掉而什么都没发生的话，人会以为已经定稿了。
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

  if (!input || !plan) return null;

  return (
    // ⚠️ 这一格不带 `report` 类：样式表里还躺着一段旧的 `.report b { color: accent }`，
    // 顶上来会把整屏的 `<b>` 染成主色（遗留问题里那句假设当场变蓝）。这一屏的样式全走
    // `.reportscreen` / `.rtoc` / `.handoff` 那几支
    <div className="page">
      {/* 顶栏与别的屏同一条。这一屏上只有一枚动作，位置与工作区那两枚一样 */}
      <header className="pagehead">
        <span className="wsroot" title={snap.case!.projectRoot ?? '这次调查没有工作区'}>
          {snap.case!.projectRoot ? (
            <>
              <em>{snap.case!.projectRoot.split('/').slice(0, -1).join('/')}/</em>
              <code>{snap.case!.projectRoot.split('/').slice(-1)[0]}</code>
            </>
          ) : (
            <code className="none">无工作区</code>
          )}
        </span>
        <div className="headacts">
          {/* ⚠️ **别叫 `toreport`**：那个类名是无人值守探针「进报告屏」的抓手
              （`main/index.ts` 的 `ENTER_WORKSPACE` / `exportProbe`）。同名的话探针会在
              报告屏上点中这一枚，当场退回工作区，而它报的错是"没有导出按钮" */}
          <button className="backtows" onClick={onBack}>
            <Icon name="back" />
            工作区
          </button>
        </div>
      </header>

      <div className="reportscreen" ref={page}>
        <div className="rcols">
          <Toc
            plan={plan}
            // 收尾两档在这一格上说的不是同一件事：归档明写着放弃，说成「已定稿」是替它改口
            done={frozen ? (snap.case!.status === 'aborted' ? '已归档' : '已定稿') : null}
            host={page}
            gaps={snap.closingGaps.length}
            onJump={jumpTo}
          />

          <div className="rmain">
            {/* 回执贴在纸上方而不是弹一下就没：路径要能被读出来、被复制走 */}
            {exported && (
              <p className={exported.ok ? 'exported' : 'exported bad'}>
                {exported.text}
                <button onClick={() => setExported(null)}>知道了</button>
              </p>
            )}

            {/* `report-body` 是给章节栏那条 spy 认的标记：同一份纸在这个文档里会画好几遍
                （缩略一份、导出预览再一份），不认一个的话滚动高亮会把缩略里的小节也算进去 */}
            <article className="paper report-body">
              <ReportPaper
                meta={snap.case!}
                plan={plan}
                // 冻结之后不传：那时它退成纸头上一行字，与图片里那一份完全一样
                shapeControl={
                  frozen ? undefined : (
                    <ShapeBar
                      value={plan.shape}
                      picked={pick !== null}
                      // 状态型的主体就是应然/实然那一对；根因那一步没给的话，选它等于让报告
                      // 装一块空的。冻结之后没有回头路，所以要在人按下去**之前**说
                      stateFillable={snap.shapeSuggestion.stateFillable}
                      suggested={snap.shapeSuggestion.source}
                      // 改形态会作废挂着的定稿确认，但那条规则不写在这儿——快照换掉建议值
                      // 是另一条同样会改形态的路，各补一次必然漏。统一由上面那条不变式管
                      onPick={setPick}
                    />
                  )
                }
              />
              <PaperFoot meta={snap.case!} plan={plan} />
            </article>

            <Handoff
              meta={snap.case!}
              plan={plan}
              input={input}
              stamp={previewStamp}
              frozen={frozen}
              gaps={snap.closingGaps}
              exporting={exporting}
              confirm={confirm}
              currentCase={snap.case!.id}
              liveSuggestion={snap.shapeSuggestion}
              onView={setView}
              onExport={runExport}
              onAsk={(kind) =>
                kind === 'closed'
                  ? void requestClose()
                  : snap.case && setConfirm({ caseId: snap.case.id, kind: 'aborted' })
              }
              onCancel={() => setConfirm(null)}
              onConfirm={(c) => void doClose(c.kind, c.caseId, c.shape ?? 'open')}
            />
          </div>
        </div>
      </div>

      {view && (
        <ExportViewer
          meta={snap.case!}
          plan={plan}
          input={input}
          stamp={previewStamp}
          kind={view}
          exporting={exporting}
          onKind={setView}
          onClose={() => setView(null)}
          onExport={runExport}
        />
      )}
    </div>
  );
}

function closingLabel(k: ClosingStepKind) {
  return ({ impact: '影响面', leftover: '遗留问题' } as const)[k];
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 纸头上的形态选择器（D25）。**点一下下面整份纸当场换装**——这是这一屏最要紧的一条：
 * 形态决定装哪几块（未决型连根因栏一起没有），而定稿是全应用唯一不可逆的手势。
 * 一度只把它摆在确认条上，于是人在一个从没预览过的五选一上按了那一下。
 *
 * 它长在纸头 stamp 那一行的位置，因为「这份按哪种装」本来就是那行字说的事——
 * 屏幕上它可点，图片里它是一行字，说的是同一件事。
 */
function ShapeBar({
  value,
  picked,
  stateFillable,
  suggested,
  onPick,
}: {
  value: VerdictShape;
  picked: boolean;
  /** 根因那一步给了应然/实然没有。没给的话状态型的主体块是空的。 */
  stateFillable: boolean;
  suggested: 'agent' | 'inferred';
  onPick: (s: VerdictShape | null) => void;
}) {
  const sh = SHAPE_COPY[value];
  // 不禁用状态型，只把后果说出来：人可能确实知道这是状态型故障，而 agent 没填那一对——
  // 那一步已经收口了，它补不回来，禁掉等于把人堵死在一个它自己造成的缺口上
  const empty = value === 'state' && !stateFillable;
  return (
    <div className="shapebar">
      <div className="row">
        <span className="lead">这份报告按哪种装</span>
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
        {/* 「还原成 agent 声明的」写不进按钮：推断那一档的说法是一整句
            （「没人声明过，按现有数据推的」），拼进去就成了一句读不通的话。
            按钮只说动作，出处在下面那行 note 上 */}
        {picked && (
          <button className="revert" title={`还原成${shapeSourceLabel(suggested)}那一个`} onClick={() => onPick(null)}>
            <Icon name="undo" />
            还原
          </button>
        )}
      </div>
      <div className="note">
        <span>
          <b>{sh.label}</b>：{sh.when}，主体是<b>{sh.body}</b>
        </span>
        <em>{picked ? '你选的' : shapeSourceLabel(suggested)}</em>
        {empty && <span className="warn">根因那一步没有应然 / 实然，这一块会是空的</span>}
      </div>
    </div>
  );
}

/** 推断值只是个不至于装错块的兜底，不是一次判断——两者必须让人一眼分得出来。 */
function shapeSourceLabel(source: 'agent' | 'inferred') {
  return source === 'agent' ? 'agent 声明的' : '没人声明过，按现有数据推的';
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 左侧的章节栏。**它不是目录，是这份报告的骨架加读数**：每一节旁边那行小字说的是
 * "这一节里有多少东西"，所以形态一换、条目与数字一起换。竖着摆才装得下那行字。
 *
 * 最后一格是交付，自成一条轨道——它不是报告的一节，是读完之后要做的事。
 * 一度与两种导出一起挤在顶栏最右端，那个位置正是最容易被滑过去的地方。
 */
function Toc({
  plan,
  done,
  gaps,
  host,
  onJump,
}: {
  plan: ReportPlan;
  /** 已经收尾时说的是哪一档（「已定稿」/「已归档」）；还开着就是 `null`。 */
  done: string | null;
  /** 还差几个强制 step。暖色那一点说的就是它（D24：暖色是「需要人动手」的全局专属）。 */
  gaps: number;
  host: React.RefObject<HTMLDivElement | null>;
  onJump: (id: string) => void;
}) {
  const [cur, setCur] = useState<string>('');

  /**
   * 当前落在哪一节。
   *
   * 🔴 **`scroll` 事件本身也是帧驱动的**：在没获焦点的窗口里一次都不派发（实测），
   * rAF 与 IntersectionObserver 是同一族，换哪个都一样。真人读报告时窗口是获焦的，
   * 所以这条在生产路径上成立；但**无人值守探针拍出来的报告屏，高亮会停在第一节**——
   * 那不是 bug。点章节栏那条路不受影响，它自己同步算一次。
   */
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const spy = () => {
      const marks = [...el.querySelectorAll('.report-body > section, #handoff')];
      if (!marks.length) return;
      const line = el.getBoundingClientRect().top + 80;
      let hit = marks[0]!;
      for (const m of marks) if (m.getBoundingClientRect().top <= line) hit = m;
      // 🔴 **到底了就认最后一节**：末节比一屏矮时它永远顶不到判定线，滚到底了高亮还停在
      // 上一节，点章节栏最后那一格于是"点了没反应"。而末节正是交付
      if (el.scrollTop >= el.scrollHeight - el.clientHeight - 2) hit = marks[marks.length - 1]!;
      setCur(hit.id === HANDOFF ? HANDOFF : hit.id.replace(/^sec-/, ''));
    };
    spy();
    el.addEventListener('scroll', spy, { passive: true });
    return () => el.removeEventListener('scroll', spy);
    // 章节随形态变，条目一换就得重新对一次
  }, [host, plan.sections.map((s) => s.id).join(',')]);

  const item = (id: string, title: string, sum: string, extra = '') => (
    <a
      key={id}
      href={`#${id === HANDOFF ? HANDOFF : `sec-${id}`}`}
      className={`${cur === id ? 'on' : ''} ${extra}`}
      onClick={(e) => {
        e.preventDefault();
        onJump(id);
      }}
    >
      <span className="t">
        {extra === 'deliver' && !done && gaps > 0 && <span className="g" />}
        {title}
      </span>
      <span className="s">{sum}</span>
    </a>
  );

  return (
    <nav className="rtoc">
      <div className="track">{plan.sections.map((s) => item(s.id, s.title, sectionSum(s.id, plan)))}</div>
      <div className="track">
        {item(HANDOFF, '交付', done ? `${done} · 只能导出` : '导出 · 定稿 · 归档', 'deliver')}
      </div>
    </nav>
  );
}

/**
 * 章节栏那一行读数。**一行只说一个数**：两个就放不下、要折行，而折行之后它就成了一堵字。
 * 写不下的靠 CSS 截断（章节栏是索引，完整值在纸上）。
 *
 * 认不出的块给空字符串而不是编一句：这里多一种块时宁可少一行小字，也不该印一句猜的。
 */
function sectionSum(id: string, plan: ReportPlan): string {
  const s = plan.sections.find((x) => x.id === id);
  if (!s) return '';
  const b = s.body;
  switch (b.kind) {
    case 'verdict':
      return b.confidence === null ? '没标置信度' : `置信度 ${b.confidence.toFixed(2)}`;
    case 'contrast':
      return b.expected || b.actual ? 'agent 填的一对' : '这一对是空的';
    case 'timeline':
      return b.rows.length ? `${b.rows.length} 条证据` : '一条都没有';
    case 'chain':
      return b.links.length ? `${b.links.length} 环` : '还没有已证实的';
    case 'split':
      return b.groups.length ? `切成 ${b.groups.length} 组` : '切不出分组';
    case 'matrix':
      return b.rows.length ? `排除 ${b.rows.length} 个方向` : '一个都没排除';
    case 'path':
      return `${b.rows.length} 步`;
    case 'notes':
      return b.rows.length ? `${b.rows.length} 条` : '无';
    case 'prose':
      return b.text ? '' : '无';
    case 'absent':
      return '这一形态不投影';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 交付台：两种导出与收尾两档。顶栏搬下来的那几件全在这儿。
 *
 * **它在纸的外面**，不进 Markdown、不进长图，所以怎么排都不会漏进交出去的东西里。
 * 两种导出**并排、等宽、按钮一个样**（D26）——把其中一个做成次要按钮就等于替人选了一种。
 *
 * 卡上只放**缩略**：它回答的是"这一份大概长什么样、多大、切几页"，完整那份进预览层。
 * 一度把两份全文摊在页面上，结果是整块撑成一屏半，反而看不见"两种目标 + 收尾"这个整体。
 */
function Handoff({
  meta,
  plan,
  input,
  stamp,
  frozen,
  gaps,
  exporting,
  confirm,
  currentCase,
  liveSuggestion,
  onView,
  onExport,
  onAsk,
  onCancel,
  onConfirm,
}: {
  meta: CaseMeta;
  plan: ReportPlan;
  input: NonNullable<ReturnType<typeof reportInput>>;
  /** 预览里那份 Markdown 的生成时间。真导出由 main 用落盘那一刻填。 */
  stamp: number;
  frozen: boolean;
  gaps: ClosingStepKind[];
  exporting: 'md' | 'img' | null;
  confirm: {
    caseId: string;
    kind: 'closed' | 'aborted';
    shape?: VerdictShape;
    suggestion?: ShapeSuggestion;
    picked?: boolean;
  } | null;
  currentCase: string;
  liveSuggestion: ShapeSuggestion;
  onView: (k: 'md' | 'img') => void;
  onExport: (k: 'md' | 'img') => void;
  onAsk: (k: 'closed' | 'aborted') => void;
  onCancel: () => void;
  onConfirm: (c: { caseId: string; kind: 'closed' | 'aborted'; shape?: VerdictShape }) => void;
}) {
  // 缩略图里的 Markdown 只印前几行。**取的是真源码**，不是另写一段示意——
  // 示意会在格式改了之后继续显示成对的，而这里正是要看"它到底长什么样"
  const md = reportMarkdown(input, { generatedAt: stamp });
  const lines = md.split('\n');

  return (
    <div className="handoff" id={HANDOFF}>
      <div className="hd">
        <h2>交付</h2>
        <em>以下不进报告本身</em>
      </div>

      <div className="targets">
        <Target
          name="长图"
          action="导出长图"
          hook="exportimg"
          why="给一贴进群里就要被看懂的场合"
          spec="1240 CSS px @2x"
          busy={exporting !== null}
          running={exporting === 'img'}
          onView={() => onView('img')}
          onExport={() => onExport('img')}
        >
          <div className="shot">
            <ReportPaper meta={meta} plan={plan} anchors={false} />
          </div>
        </Target>

        <Target
          name="Markdown"
          action="导出 Markdown"
          hook="exportmd"
          why="给会被继续编辑、被贴进 PR 的场合"
          spec={`${lines.length} 行`}
          busy={exporting !== null}
          running={exporting === 'md'}
          onView={() => onView('md')}
          onExport={() => onExport('md')}
        >
          <pre className="mdthumb">{lines.slice(0, 16).join('\n')}</pre>
        </Target>
      </div>

      {frozen ? (
        <p className="sealed">
          <Icon name="seal" />
          <span>
            <b>已{meta.status === 'aborted' ? '归档' : '定稿'}</b>，形态冻在
            <b>{SHAPE_COPY[plan.shape].label}</b>。不能再开会话，只能导出。
          </span>
        </p>
      ) : (
        <div className="closing">
          <h3>收尾</h3>
          <p>
            定稿会冻结这次调查：不能再开会话，只能导出。冻的就是上面那一份 —— 形态
            <b>{SHAPE_COPY[plan.shape].label}</b>
            {plan.sections.some((s) => s.id === 'verdict') ? '' : '，而它没有根因栏'}。
          </p>
          <div className="acts">
            <button onClick={() => onAsk('closed')} title="下结论并冻结这次调查">
              <Icon name="seal" />
              定稿
            </button>
            <button onClick={() => onAsk('aborted')} title="放弃这次调查；证据全部保留，半程报告照旧能导">
              <Icon name="archive" />
              归档
            </button>
            {/* 缺什么写成一句话，不是按钮上括号里一个数字 */}
            {!confirm && gaps.length > 0 && (
              <span className="gap">
                <span className="g" />
                还差{gaps.map(closingLabel).join('与')}，点定稿会先让 agent 去补
              </span>
            )}
          </div>

          {/* 就地展开：不可逆那一下的确认长在按下去的那个按钮下面，不弹回顶部横幅。
              **只在还是同一次调查时才挂得出来**——确认块上讲的事必须还是它讲的那次 */}
          {confirm?.caseId === currentCase && confirm && (
            <div className="confirm">
              <p>{confirmText(confirm, plan, liveSuggestion)}</p>
              <div className="acts">
                <button className="seal" onClick={() => onConfirm(confirm)}>
                  <Icon name={confirm.kind === 'closed' ? 'seal' : 'archive'} />
                  {confirm.kind === 'closed' ? '确认定稿' : '确认归档'}
                </button>
                <button onClick={onCancel}>
                  <Icon name="deny" />
                  再想想
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Target({
  name,
  action,
  hook,
  why,
  spec,
  busy,
  running,
  children,
  onView,
  onExport,
}: {
  name: string;
  /** 导出按钮上的整句。不由 `name` 拼——拼出来的「导出Markdown」中西文之间少一格 */
  action: string;
  /**
   * 导出按钮的类名。**它是无人值守探针按下去的那个抓手**
   * （`main/index.ts` 的 `exportProbe('.exportmd')` / `('.exportimg')`）——
   * 改名之前先去改那两处，否则表现是探针报"报告屏上没有导出按钮"。
   */
  hook: string;
  why: string;
  spec: string;
  /** 有导出在跑（哪一种都算）。**两个入口一起置灰**：并着跑会互相清掉状态。 */
  busy: boolean;
  /** 在跑的是**这一种**。只有它写「导出中」——另一枚跟着写就成了两条都在导的假象。 */
  running: boolean;
  children: React.ReactNode;
  onView: () => void;
  onExport: () => void;
}) {
  return (
    <div className="target">
      <div className="top">
        <h3>{name}</h3>
        <span className="spec">{spec}</span>
      </div>
      <p className="why">{why}</p>
      {/* 明摆着是截断的，不假装自己是全文：底下压一道同色渐隐（见 styles.css 的 `.thumb`） */}
      <div className="thumb">{children}</div>
      <div className="acts">
        <button onClick={onView}>
          <Icon name="expand" />
          看完整的
        </button>
        <button className={`go ${hook}`} onClick={onExport} disabled={busy}>
          <Icon name="download" />
          {running ? '导出中…' : action}
        </button>
      </div>
    </div>
  );
}

/**
 * 确认那一下要说的是**后果**，不是"你确定吗"——两档的后果不一样，说反了就白确认了。
 *
 * 状态型缺应然/实然那一条在这儿再说一遍（纸头上已经说过）：这一下之后没有回头路，
 * 而人可能是从别处滚下来直接按的，纸头那句这会儿在屏幕外。
 */
function confirmText(
  confirm: { kind: 'closed' | 'aborted'; shape?: VerdictShape; suggestion?: ShapeSuggestion },
  plan: ReportPlan,
  live: ShapeSuggestion,
) {
  if (confirm.kind === 'aborted') {
    return '归档 = 明写放弃这次调查。已经查到的证据一条都不删，仍能导出半程报告——但那份强制是未决型，没有根因栏，主体是排除掉的方向与遗留问题。';
  }
  const shape = confirm.shape ?? plan.shape;
  const root = plan.sections.find((s) => s.id === 'verdict');
  const empty =
    shape === 'state' && !stateFillable(confirm.suggestion, live)
      ? '⚠️ 根因那一步没有应然 / 实然，状态型的主体块会是空的。'
      : '';
  const rootText =
    root?.body.kind === 'verdict'
      ? `根因取「${root.body.text.slice(0, 40)}」`
      : '这一份没有根因栏';
  return `按下去之后这次调查就冻住了：不能再开会话，报告只能导出、不能再改。形态冻成${SHAPE_COPY[shape].label}，${rootText}。${empty}`;
}

// ═══════════════════════════════════════════════════════════════════════════
/**
 * 导出预览：两种目标切一下就看完整的那一份。
 *
 * **它不受 D22「报告页不许有折叠」的约束**：那一条防的是"截图里没有的内容"，
 * 而这一层压根不进任何一份导出——它看的正是要交出去的那两份长什么样。
 *
 * 长图那一份是**真的按 1240 排一遍再缩**，不是画一张示意图：示意图会在样式改了之后
 * 继续显示成对的，而这里正是要回答"导出来到底长什么样"。
 * ⚠️ 分页在这儿**不算**——真实分页在 main 的离屏窗口里量（`ExportImage.tsx`），
 * 这一层只给"这一份纸整体长什么样"。要看真实页数只能真导一次。
 */
function ExportViewer({
  meta,
  plan,
  input,
  stamp,
  kind,
  exporting,
  onKind,
  onClose,
  onExport,
}: {
  meta: CaseMeta;
  plan: ReportPlan;
  input: NonNullable<ReturnType<typeof reportInput>>;
  stamp: number;
  kind: 'md' | 'img';
  exporting: 'md' | 'img' | null;
  onKind: (k: 'md' | 'img') => void;
  onClose: () => void;
  onExport: (k: 'md' | 'img') => void;
}) {
  /** `null` 没按过 · `ok` 复制成功 · `fail` 失败。**失败必须有自己的一档**：
      回到"没按过"的话，权限被拒时屏上什么都不变，人会带着一份空剪贴板走。 */
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const md = reportMarkdown(input, { generatedAt: stamp });

  // Esc 关掉。**清理函数不能省**：这一层随 state 卸载，留着监听会在下一次打开时叠一层
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <>
      <div className="veil" onClick={onClose} />
      <div className="viewer">
        <div className="bar">
          <strong>导出预览</strong>
          <button className={kind === 'img' ? 'on' : ''} onClick={() => onKind('img')}>
            长图
          </button>
          <button className={kind === 'md' ? 'on' : ''} onClick={() => onKind('md')}>
            Markdown
          </button>
          <button className="x" onClick={onClose}>
            <Icon name="deny" />
            关闭
          </button>
        </div>

        <div className="vbody">
          {kind === 'md' ? (
            <pre>{md}</pre>
          ) : (
            <div className="pages">
              <div className="pageshot">
                <div className="shot">
                  <article className="paper">
                    <ReportPaper meta={meta} plan={plan} anchors={false} />
                    <PaperFoot meta={meta} plan={plan} />
                  </article>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="vfoot">
          <span>
            {kind === 'md'
              ? '除末尾一个 details 外全篇纯 Markdown · 证据走脚注'
              : '与屏幕上这份同一套样式与配色 · 不跟随系统主题 · 超长时按顶层小节分页'}
          </span>
          {kind === 'md' && (
            <button
              onClick={() => {
                void navigator.clipboard.writeText(md).then(
                  () => setCopied('ok'),
                  () => setCopied('fail'),
                );
              }}
            >
              <Icon name={copied === 'fail' ? 'deny' : 'copy'} />
              {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败，手动选中吧' : '复制全文'}
            </button>
          )}
          <button
            className="go"
            disabled={exporting !== null}
            onClick={() => onExport(kind)}
          >
            <Icon name="download" />
            {exporting === kind ? '导出中…' : '导出'}
          </button>
        </div>
      </div>
    </>
  );
}
