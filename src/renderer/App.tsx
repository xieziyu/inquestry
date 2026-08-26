import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_SNAPSHOT,
  type CaseMeta,
  type EnvStatus,
  type InquestryApi,
  type PendingAsk,
  type Snapshot,
  type TakeoverResult,
} from '../shared/ipc.js';
import { SHAPE_COPY, tailSummary } from '../shared/report.js';
import { draftKey, pruneDrafts, type CardDrafts } from './drafts.js';
import { RunBar } from './RunBar.js';
import { Stage } from './Stage.js';
import { GateCard } from './GateCard.js';
import { Icon } from './Icon.js';
import { History } from './History.js';
import { Home } from './Home.js';
import { LogoMark } from './LogoMark.js';
import { PendingCard } from './PendingCard.js';
import { Rail, type Screen } from './Rail.js';
import { Report } from './Report.js';
import { Settings } from './Settings.js';
import { Tabs } from './Tabs.js';
import { useEscape } from './esc.js';
import { closeTab, focusOrAppend, NO_TABS, tabForCloseKey, type CaseTabs } from '../shared/tabs.js';

declare global {
  interface Window {
    inquestry: InquestryApi;
  }
}

/**
 * tab 列表没落地、连退回都没退成时说的那句。
 *
 * **不许写成"已经退回来了"**：那时这排 tab 与正文可能压根不是同一个调查，
 * 而人会照着屏幕上高亮的那个继续往下做——把线索发进另一次调查正是这一整套
 * caseId 核对（`currentIf`）要防的事。说不准就说不准，并给一条自己能走的出路。
 */
const MISALIGNED =
  '这一下没落到 main 那边，退回也没成：这排 tab 显示的调查可能与正文不是同一个。切一次调查或重开 app。原因在应用日志里。';

export function App({
  /**
   * 起手停在哪一屏。**只有浏览器预览会传**（`preview/main.tsx` 的 `?screen=`）：
   * 那儿改一行样式就整页重载一次，每次都从首页点回去的话，深处那几屏根本调不动。
   */
  initialScreen,
}: { initialScreen?: Screen } = {}) {
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  /**
   * 打开着的调查（工作区顶上那排 tab）。计算全在 `shared/tabs.ts` 里，这一层只管落库。
   *
   * 🔴 **tab 只是视图**：关掉一个 tab 只是把它移出这排，main 那侧的运行时一点没动——
   * 会话照旧跑、待办照旧等着人。这一条是整个 tab 模型的地基，别拿"关掉"去停任何东西。
   *
   * 列表由这一侧持有、每次变化落一次库（`putTabs`），main 只在启动时按它恢复当前调查。
   * 反过来让 main 持有的话，"聚焦或追加""关掉之后落到谁"这些纯粹的视图规则
   * 会被拆到两个进程里各管一段。
   */
  const [tabs, setTabs] = useState<CaseTabs>(NO_TABS);
  /**
   * 🔴 **算下一份 tab 列表只许从这儿起算，不许从 render 闭包里那个 `tabs` 起算。**
   *
   * 那几个手势里有等得很久才回来的：历史页删掉一行是 `await deleteCase(...)` 之后才回调
   * `onDeleted`，而它捏着的是**发起删除那一帧**的 `tabs`。这中间人完全可以开一个、关一个——
   * 那几下会被这条迟到的回调按旧列表整个盖掉，而屏幕上只是"刚才关掉的那个自己回来了"。
   *
   * 与 state 分开的原因是 state 要等下一次渲染：同一拍里连着两下手势时，第二下从
   * `tabs` 起算读到的仍是第一下之前那份。渲染照旧用 `tabs`，这一份只作起算点。
   */
  const tabsRef = useRef<CaseTabs>(NO_TABS);
  /** tab 列表的唯一写入口：两份一起换，别处不许单独 `setTabs`。 */
  const takeTabs = useCallback((next: CaseTabs) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);
  /**
   * 只让最后一次意图收尾。同 `wantSeq`：两下挨得近时，早一次的落库回执回来得晚，
   * 它那条失败复位会把更晚那一下已经生效的列表按旧的退回去。
   */
  const tabSeq = useRef(0);
  /**
   * 停在报告那一屏的是**哪几个调查**。工作区与报告是同一个 tab 的两种视图，
   * 每个 tab 各记各的：切到别的 tab 再切回来，人回到的是他离开时那一屏。
   *
   * 按 caseId 记而不是一个全局的 `screen` 枚举：那样的话切一次调查就得决定
   * "报告屏要不要让开"——留着是调查 B 的标题配调查 A 的章节，让开是把人正在读的报告收走。
   */
  const [reportTabs, setReportTabs] = useState<string[]>([]);
  /**
   * 这会儿有没有一次导出在跑，以及**是哪次调查的哪一种**。
   *
   * 🔴 **这一份必须住在应用级，不能留在报告屏那个组件里。** 报告屏按 caseId 重挂
   * （`key={openCase}`，那是导出回执串到别的调查名下的唯一防线），于是组件局部的
   * "导出中"会跟着切 tab 一起蒸发：切走再切回，同一次调查的按钮又亮了，人再按一次，
   * 两条并着跑的导出会往**同一个文件名**上各写一遍。
   *
   * 提到这一层还白捡两件事：切走那阵子锁照旧攥着（`finally` 落在这一层，组件卸载不影响），
   * 以及切回来时那句「导出中…」还在——重挂只丢回执，不丢"它还在跑"。
   */
  const [exporting, setExporting] = useState<{ caseId: string; kind: 'md' | 'img' } | null>(null);
  /**
   * 输入草稿**按调查分开存**。共用一个的话，在调查 A 写到一半切到调查 B ，输入框里还是那段字，
   * 一发送就把 A 写到一半的输入发进了 B 的会话——串到别的调查上，而且毫无提示。
   * 分开存还顺带保住了草稿：切回去它还在。
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /**
   * 现在在哪一屏（ui.md §8.5）。**只是导航，不带任何调查状态**：
   * 切调查那件事整个搬到了历史调查页，rail 上四格里没有一格记得住"哪个调查"。
   *
   * 起手在首页而不是工作区：打开 app 时手上多半没有调查，
   * 而工作区在那种情况下是一屏什么都没有的空屏。
   */
  const [screen, setScreen] = useState<Screen>(initialScreen ?? 'home');
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [excerpt, setExcerpt] = useState<{ title: string; body: string } | null>(null);
  /**
   * 待办处置没落地时的提示。
   *
   * 挂在应用级而不是卡片上：处置失败多半正是因为调查切走了，那张卡这会儿根本不在屏幕上。
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 待办卡里人已经敲进去的东西：①档是粘贴的结果与拒绝理由，②档是改写的参数与拒绝理由。
   *
   * **按「调查 + 条目 id」存在这一层**：卡片是跟着快照渲染的，一换调查旧卡片就卸载，
   * 局部 state 随之蒸发——切回来时它会按 ask/gate 的初值重新挂上，人贴的结果、
   * 写好的拒绝理由全没了。只有处置真的落地才清掉。
   */
  const [cardDrafts, setCardDrafts] = useState<CardDrafts>({});
  /**
   * 接管开关上**人最后按的那一下**，回执落地前先认它。
   *
   * 按钮的目标值是从快照算的，而快照要等 main 回执才更新：连点两下时第二下算出的目标
   * 与第一下相同，main 那侧按「已经是这个状态了」幂等早退——最终生效的是第一下，
   * 正好与人最后按的相反。
   */
  const [wanted, setWanted] = useState<boolean | null>(null);
  /** 只让最后一次意图收尾：早一次的回执回来时清掉的会是还在飞的那一次的显示值。 */
  const wantSeq = useRef(0);
  /**
   * **会话正在进行**，不是「开过会话」。ended / crashed 都得能重开——那正是
   * 「接着查」新起一轮的入口；把它们算成 started 的话，跑完或崩掉之后按钮不出现，
   * 输入框却还能发，消息进的是一个已经没人消费的队列。
   */
  const live = snap.sessionStatus === 'live';
  /** 定稿 / 归档之后只能看和导出：开新会话会往一个已下结论的调查里追加步骤。 */
  const frozen = !!snap.case && snap.case.status !== 'open';
  /** 接管开关按人最后按的那一下画：回执与快照都要一会儿才到，中间那一下不能显示成没按 */
  const takeover = wanted ?? snap.takeover;
  // ①档永远置顶：闸门到点会自己放行，回填不处理就永远等下去（ui.md §4）
  const todos = useMemo(
    () => [...snap.pending.map((p) => p.id), ...snap.gates.map((g) => g.id)],
    [snap.pending, snap.gates],
  );
  /**
   * 舞台末端那张收束卡（ui.md §3.3）。出没出生、上面写什么全在 `tailSummary()` 里，
   * 这一层只把它递下去——判断散到组件里的话，"归档不印根因"这类规则就有了第二处出处。
   */
  const tail = useMemo(() => tailSummary(snap), [snap]);
  const [focus, setFocus] = useState<string | null>(null);
  /**
   * 待办栏这会儿该不该拿着键盘。卡片靠它决定 `focused` 落上来时要不要真去 `focus()`。
   *
   * 两个来源说的是同一件事——**键盘已经在待办卡里了**：焦点落进某张卡（点进去就算），
   * 以及前一张被处置掉的那一下——焦点掉回 body 时 `focusin` 不再触发，这个值于是留着 true，
   * 顺位接上来的那张才接得住键盘，否则连着处置一串待办的链子在第一张之后就断了。
   *
   * 而"待办从无到有、人正在底部输入框打字"那一幕里它是 false，卡片就不抢焦点。
   * 🔴 **不能拿 `focused` 代替它**：那一幕里 `focused` 同样会落到第一张卡上。
   */
  const handKeyboard = useRef(false);
  /** 焦点那条消失后要接上它的**位置**，所以光记 id 不够——id 这时已经不在列表里了。 */
  const focusAt = useRef(0);

  useEffect(() => {
    void window.inquestry.snapshot().then(setSnap);
    void window.inquestry.envCheck().then(setEnv);
    // main 那份已经过滤过已归档 / 已删的调查，也已经按 active 切好了当前调查，
    // 这儿直接认它，不再自己切一次
    void window.inquestry.getTabs().then(takeTabs);
    return window.inquestry.onSnapshot((s) => s && setSnap(s));
  }, []);

  useEffect(() => {
    // 全清空了就回到头：下一批待办是新一轮，接着上一轮的位置落点没有意义
    if (!todos.length) focusAt.current = 0;
    const at = todos.indexOf(focus ?? '');
    if (at >= 0) focusAt.current = at;
  }, [todos, focus]);

  // 处置掉当前这条后焦点顺位落到接替它的那条，而不是掉回列表头：
  // 连着处置一串待办时，掉回头等于把已经越过的又看一遍
  useEffect(() => {
    setFocus((f) => {
      if (f && todos.includes(f)) return f;
      if (!todos.length) return null;
      return todos[Math.min(focusAt.current, todos.length - 1)] ?? null;
    });
  }, [todos]);

  // 接管的意图不跨调查：留着的话新调查的开关会先画上一次调查按下的那一下
  useEffect(() => {
    wantSeq.current += 1;
    setWanted(null);
  }, [snap.case?.id]);

  // 从快照上消失的待办，草稿也跟着清（自动放行 / 超时 / 被停止散掉都走这儿）
  useEffect(() => {
    const id = snap.case?.id;
    if (!id) return;
    const alive = [...snap.pending.map((p) => p.id), ...snap.gates.map((g) => g.id)];
    setCardDrafts((all) => pruneDrafts(all, id, alive));
  }, [snap.case?.id, snap.pending, snap.gates]);

  /**
   * 焦点每落到一处就记一次：在不在待办卡里、以及在哪一张。
   *
   * **选中跟着键盘走**，没有另一套只属于待办栏的光标——待办卡上没有键盘导航键，
   * 「选中的是哪张」除了"键盘在哪张"之外没有别的可靠来源，各记一套只会对不上：
   * 边框标着甲，而人正在乙里打字。
   *
   * **只听 `focusin`**：卡片被处置掉时焦点掉回 body 不触发它，上一次的值因此留得住，
   * 正好是顺位交接需要的那一下（`handKeyboard` 仍是 true，`focus` 由下面那条顺位 effect 接手）。
   */
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const card = (e.target as HTMLElement | null)?.closest?.('.pending,.gate') as HTMLElement | null;
      handKeyboard.current = !!card;
      const id = card?.dataset.todo;
      if (id) setFocus(id);
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);
  const grabKeyboard = useCallback(() => handKeyboard.current, []);

  /**
   * 处置**在途的那几条**，按待办 id 记。
   *
   * 🔴 **同一张卡不许发第二遍。** 卡片要等下一次快照才消失，这中间按钮和 ⌘↵ 都还按得动；
   * 而 main 那侧第一发就把它从 `pending` 上摘了，第二发只会回一个 false——
   * 于是屏幕上弹出"刚才那条没处置成功"，可它明明成了。双击一下「回填」就能撞上。
   *
   * 成功之后**故意一直占着**：卡片正在消失的路上，而 ask/gate 的 id 不会再出现第二次。
   * 只有失败才放开，那时人确实要能再试一次。
   */
  const inFlight = useRef(new Set<string>());

  const showExcerpt = async (callId: string, anchor: string | null, title: string) => {
    setExcerpt({ title, body: await window.inquestry.excerpt(callId, anchor) });
  };
  // 原文浮层是从详情抽屉里点开的，Esc 得先关它——抽屉那一层同样听 Esc，见 `esc.ts`
  useEscape(!!excerpt, () => setExcerpt(null));

  const caseId = snap.case?.id ?? null;
  const input = caseId ? (drafts[caseId] ?? '') : '';
  const setInput = (text: string) => caseId && setDrafts((d) => ({ ...d, [caseId]: text }));

  /**
   * 输入框那一枚钮，两档合一：会话开着就发消息，没开就先起一轮再发。
   *
   * 合成一个是因为**人的动作是同一个**——想让它去查点什么。分成"舞台上一枚开始钮 +
   * 输入框一枚发送钮"的话，第一句话得先按一次开始、再回到输入框敲一遍。
   *
   * 送不出去就把草稿留着。切调查 / 点「新开调查」之后 main 那边当时就没有当前调查了，
   * 而这一屏还要等下一次快照才换——先清空再发的话，那段字直接消失。
   */
  const submit = async () => {
    const text = input.trim();
    if (!caseId || !text) return;
    // 会话没开就先起一轮再把话送进去：`start()` 的开场白是建单信息拼的，人这句是额外的补充
    if (!live) await window.inquestry.start(caseId);
    if (await window.inquestry.send(caseId, text)) setDrafts((d) => ({ ...d, [caseId]: '' }));
  };

  /**
   * rail 那颗暖色点：**有没有调查在等人**（D28 的跨案汇总）。
   *
   * 算的是全部调查而不只是当前那个——切换入口搬到历史调查页之后，
   * 这一颗点是后台那条卡在 `ask_operator` 上的支线在别的屏上仅有的痕迹。
   */
  const anyTodo = snap.cases.some((c) => c.todos > 0) || todos.length > 0;

  /** 这个 tab 翻到报告 / 翻回工作区。两句都按 caseId 记，见 `reportTabs` 上那段。 */
  const showReport = (id: string) =>
    setReportTabs((r) => (r.includes(id) ? r : [...r, id]));
  const hideReport = (id: string) => setReportTabs((r) => r.filter((x) => x !== id));

  /**
   * tab 列表换了一份：落库 + 让 main 跟上"现在在看哪一个"。
   *
   * **切换本身不中断任何一个调查**（D28）：main 持有全部运行时，这一下只是换个投影看。
   * 一个 tab 都不剩时要走 `newCase()` 把 main 那侧的当前调查也清掉——不清的话，
   * 从 rail 点回工作区会看到一屏没有任何 tab 的调查界面。
   *
   * `shared/tabs.ts` 里那几个算子在没变化时原样返回入参，所以这一句同时挡掉了
   * "点当前这个 tab"引起的一轮多余 IPC。
   *
   * 🔴 **三条 IPC 的回执都要接住。** 一度全 `void` 丢掉，于是落库失败时界面照常显示新的
   * 那几个 tab、重开 app 却回到上一次那份——一个只在下次启动才现形的谎报，
   * 而且那次 reject 还会变成没人接的 unhandled rejection。失败就**按 main 那边的实际状态
   * 退回来**并说出来：这一层是副本，main 那份才算数。
   *
   * **不把这函数变成要 await 的**：调用点是一串点击回调，async 化会一路传染下去。
   */
  const applyTabs = (next: CaseTabs) => {
    if (next === tabsRef.current) return;
    takeTabs(next);
    const mine = ++tabSeq.current;
    void (async () => {
      try {
        await window.inquestry.putTabs(next);
        // 切当前调查与"一个都不剩"是同一件事的两档，一起接住：切不过去时这一层说的
        // "在看哪一个"就与 main 那边不是同一个了，而屏幕上没有任何异样
        if (next.active) await window.inquestry.switchCase(next.active);
        else await window.inquestry.newCase();
      } catch (err) {
        console.error('[app] 这一下 tab 没落地', err);
        // 后面还有更晚的一下在飞，收尾让给它——这一次的结果已经不是人要的那个状态了
        if (mine !== tabSeq.current) return;
        const actual = await window.inquestry.getTabs().catch(() => null);
        if (mine !== tabSeq.current) return;
        if (!actual) return setNotice(MISALIGNED);
        takeTabs(actual);
        /**
         * 🔴 **对齐要连"在看哪一个"一起对，只把列表退回来是不够的。** 两条路都会留下
         * 「这排 tab 说甲、正文是乙」——而那正是本该由 `currentIf` 那套护栏挡住的那种串号：
         *
         * - 新建调查那一下 main 已经选中了新 case，落库却失败了：列表退回旧的，
         *   正文还是新调查
         * - 落库成了、切当前调查失败了：`actual` 是**新**列表，退回等于什么都没退，
         *   高亮着新 tab 而正文还是旧调查
         *
         * 所以按 main 那份实际列表补一发切换。它再失败就只能说实话（`MISALIGNED`）——
         * 那时两边确实可能不是同一个调查，而一句"已经退回来了"是彻头彻尾的谎报。
         */
        try {
          if (actual.active) await window.inquestry.switchCase(actual.active);
          else await window.inquestry.newCase();
        } catch (err2) {
          console.error('[app] 退回之后也没能把当前调查对齐', err2);
          if (mine !== tabSeq.current) return;
          return setNotice(MISALIGNED);
        }
        if (mine !== tabSeq.current) return;
        setNotice('这一下只落地了一半：屏幕上这排 tab 已经与 main 那边对齐了。原因在应用日志里。');
      }
    })();
  };

  /**
   * 关掉一个 tab。**只是移出视图**：那次调查照旧在 main 里跑，待办照旧等着人
   * （要收掉它走的是报告屏上的定稿 / 归档）。
   *
   * 关掉最后一个之后回首页：工作区这时是一屏什么都没有的空屏，而人下一步多半是新建。
   *
   * 叫得动这一条的只有 tab 上那枚叉、以及 tab 条在场时的 ⌘W（`tabForCloseKey`）。
   *
   * 🔴 **移出一个 tab 只有两条路：人自己关（这一条），以及重启时过滤掉已收尾 / 已删的
   * （main 的 `restoreTabs`）。收尾本身不当场收走它**——一度写成"定稿即摘掉 tab"，
   * 它有两条都会把人弹走的死路：
   *
   * - 定稿与归档都只对**当前**调查生效（两条 IPC 都走 `currentIf`），所以"当场摘掉"
   *   必然发生在人正盯着他刚定出来的那份报告时，而收尾之后要做的正是导出它
   * - 历史页点一条已收尾的调查看报告，同样会被当场摘掉再弹到别的调查上，旧报告根本看不成
   *
   * 一个收了尾的调查确实不属于"手上开着的几条线索"，所以它只是不再跨重启活下来。
   */
  const closeOne = (id: string) => {
    const next = closeTab(tabsRef.current, id);
    if (next === tabsRef.current) return;
    applyTabs(next);
    if (!next.open.length) setScreen('home');
  };

  /** 打开某次调查 = 聚焦它的 tab（没有就开一个）+ 翻到工作区。 */
  const open = (id: string) => {
    applyTabs(focusOrAppend(tabsRef.current, id));
    setScreen('workspace');
  };

  /**
   * 从列表直奔某次调查的报告屏。
   *
   * `reportTabs` 记的是 caseId 而报告屏认的是「它等于当前调查」，所以先记后切两句缺一不可：
   * 切换要等下一次快照（最多 60ms）才在这一屏生效，这中间显示的是**上一个**调查的工作区。
   * 那一拍与 `open()` 那条是同一个，不额外补一个"正在切"的中间态——补了反而多一屏闪烁。
   */
  const openReport = (id: string) => {
    showReport(id);
    open(id);
  };

  // tab 关掉了，它停在报告那一屏的记忆也跟着清掉——再打开是从工作区开始，
  // 与"从没开过"是同一个起点
  useEffect(() => {
    setReportTabs((r) => {
      const next = r.filter((id) => tabs.open.includes(id));
      return next.length === r.length ? r : next;
    });
  }, [tabs.open]);

  /**
   * ⌘W。**加速键归应用菜单管**，renderer 里的 keydown 拦不住它（`main/index.ts` 的
   * `installMenu`），所以这一下是菜单发过来的一条消息。
   *
   * 关不关得了由 `tabForCloseKey` 判，**落点归属看这一屏是不是某个 tab 的内容**：
   * `screen === 'workspace'` 这一档同时盖住工作区与报告——报告是同一个 tab 的另一种视图
   * （见下面那条早返回），而首页 / 历史 / 设置与任何一个 tab 都无关。
   *
   * 判不了就回退到系统默认——关窗口，**这一句必须由这一侧发回去**：菜单那边不知道
   * 人在哪一屏、手上有没有 tab，在那儿顺手关一下窗口的话，有 tab 时会连窗口一起关掉。
   */
  useEffect(
    () =>
      window.inquestry.onMenuCloseTab(() => {
        const id = tabForCloseKey(tabsRef.current, screen === 'workspace');
        if (id) closeOne(id);
        else void window.inquestry.closeWindow();
      }),
    // `tabsRef` 免掉了 tabs 这条依赖：这个订阅只需要跟着屏切换重挂
    [screen],
  );

  /**
   * 打开着的那排 tab。**造一个元素，工作区与报告屏共用它**：两处各写一遍的话，
   * "点一下切到哪个视图""叉子关掉之后落到谁"这两件事迟早只在其中一屏跟得上。
   */
  const tabStrip = (
    <Tabs tabs={tabs.open} active={tabs.active} briefs={snap.cases} onPick={open} onClose={closeOne} />
  );

  const shell = (content: React.ReactNode) => (
    <div className="app">
      <Rail screen={screen} todo={anyTodo} onGo={setScreen} />
      {/* 顶栏左端的应用标记。由外壳画一次而不是各屏各画一次——它在每一屏上都是同一个东西，
          而各屏的页头只管自己那份内容（见 styles.css 的 `.brand` 与外壳网格） */}
      <span className="brand">
        <LogoMark size={20} />
      </span>
      <div className="frame">{content}</div>
      {/* 没落地的处置要说出来，而且**得在任何一屏上都说得出来**：
          它多半正是因为调查切走了才没落地，那时那张卡片、甚至整个工作区都不在屏幕上；
          从报告屏按下的定稿被回绝时同理——那一屏没有横幅位 */}
      {notice && (
        <div className="appnotice">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)}>知道了</button>
        </div>
      )}
    </div>
  );

  if (screen === 'home') {
    return shell(
      <Home
        cases={snap.cases}
        onOpen={open}
        // 建完就翻到工作区：`createCase` 会把新调查设成当前调查，
        // 而人下一步想做的一定是点「开始排查」。新的这一次同样开一个自己的 tab
        onCreated={open}
        onAll={() => setScreen('history')}
      />,
    );
  }
  if (screen === 'history')
    return shell(
      <History
        cases={snap.cases}
        onOpen={open}
        onReport={openReport}
        // 删掉的那条当场关掉它的 tab：库里已经没有这个 id 了，留着的话点下去是一次空切换，
        // 而屏幕上什么都不会发生
        onDeleted={closeOne}
      />,
    );
  if (screen === 'settings') return shell(<Settings />);

  // rail 上工作区那一格随时点得到，但手上不一定有调查。
  // 不给出路的话它就是个死胡同——两个出口正好对应"新建"与"找一个旧的"
  if (!snap.case) {
    return shell(
      <div className="page">
        <header className="pagehead">
          <h1>工作区</h1>
          <span className="sub">当前没有打开的调查</span>
        </header>
        <div className="pagebody">
          <div className="ws-empty">
            <p>还没有打开任何调查。</p>
            <div className="acts">
              <button className="primary" onClick={() => setScreen('home')}>
                <Icon name="plus" />
                去首页新建
              </button>
              <button onClick={() => setScreen('history')}>
                <Icon name="arrow" />
                从历史调查里挑一个
              </button>
            </div>
          </div>
        </div>
      </div>,
    );
  }

  // 早返回之后 snap.case 一定在，但收窄进不了下面那些回调，取一次留个常量
  const openCase = snap.case.id;

  const keyFor = (id: string) => draftKey(openCase, id);
  const cardDraft = (id: string) => cardDrafts[keyFor(id)] ?? {};
  const patchDraft = (id: string, patch: Record<string, string | undefined>) =>
    setCardDrafts((all) => {
      const next: Record<string, string> = { ...all[keyFor(id)], ...patch } as Record<string, string>;
      for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
      return { ...all, [keyFor(id)]: next };
    });

  /**
   * 开 / 关接管。**没切成要说出来**：切了调查之后 main 那边回绝，
   * 而开关是跟着快照渲染的——不说的话屏幕上什么都没变，看起来像按钮坏了。
   */
  const takeCharge = async (on: boolean) => {
    const mine = ++wantSeq.current;
    setWanted(on);
    const r = await window.inquestry
      .setTakeover(openCase, on)
      .catch((): TakeoverResult => 'failed');
    // 后面还有更晚的一下在飞，就把收尾让给它——这一次的结果已经不是人要的那个状态了
    if (mine !== wantSeq.current) return;
    setWanted(null);
    // 几种没切成要说成不同的话，且**要说清这一轮到底在哪一档**：
    // 都说成"再点一次就行"的话，人会在没有接管的情况下继续查；而把 `unsaved` 说成没切成，
    // 人再按的那一次正好把已经生效的这一档切回去
    if (r === 'gone') setNotice('没切成接管模式，这次调查刚切走或已经收尾了。切回去再点一次。');
    else if (r === 'failed')
      setNotice(
        on
          ? '没接管上：这一轮仍由分类器判。原因在应用日志里。'
          : '没交回去：这一轮还是除只读与杂务外每次都要你放行。原因在应用日志里。',
      );
    else if (r === 'unsaved')
      setNotice(
        on
          ? '接管这一轮生效了，但没存下来：重开 app 会回到分类器判。原因在应用日志里。'
          : '已交回，但没存下来：重开 app 会回到接管。原因在应用日志里。',
      );
  };

  /**
   * 待办与闸门的处置。落地了卡片自己会随下一次快照消失，草稿跟着清掉；
   * 没落地才要说话——而且这时那张卡多半已经不在屏幕上了，所以提示挂在应用级。
   */
  const dispose = (id: string, run: () => Promise<boolean>) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    /**
     * 🔴 **失败与抛错走同一条收尾路径。** 只接 fulfilled 的话，IPC 一 reject 这个 id
     * 就永远留在 `inFlight` 里：卡片还在屏幕上，按钮和 ⌘↵ 却从此被上面那行静默丢掉，
     * 人连重试都做不到，而且屏幕上没有任何异样。
     */
    const failed = (err?: unknown) => {
      if (err !== undefined) console.error('[app] 处置这条待办的 IPC 没成功', err);
      inFlight.current.delete(id);
      setNotice('刚才那条没处置成功：可能调查已经切走了，也可能它已经到点自动放行。切回那次调查再看一眼，刚才填的还在。');
    };
    // `Promise.resolve().then(run)` 而不是 `run()`：run 自己同步抛出来的也要落进 `failed`
    void Promise.resolve()
      .then(run)
      .then((ok) => {
        if (!ok) {
          failed();
          return;
        }
        setCardDrafts((all) => {
          const next = { ...all };
          delete next[keyFor(id)];
          return next;
        });
      }, failed);
  };

  /**
   * 报告是**这个 tab 的另一种视图**，整屏换掉：主角、密度、能做的事都不一样。
   * 挂在这儿而不是塞进主区，是为了让工作区的顶栏与底部状态栏一并让开——
   * 那条状态栏说的是"这一轮在跑什么"，而报告这一屏上没有"这一轮"。
   * 收尾两档（定稿 / 归档）也在那边：先看这份能不能交出去，再决定收不收。
   *
   * 停在哪一屏**每个 tab 各记各的**（`reportTabs`）：切到别的 tab 再切回来，
   * 人回到的是他离开时那一屏。tab 条不出现在这一屏上——报告是一份要通读的东西，
   * 换调查先按「工作区」退回去。
   */
  if (reportTabs.includes(openCase)) {
    return shell(
      /**
       * 🔴 **`key` 按调查给，让它跟着换调查重挂。** 不给的话 React 复用同一个实例，
       * 而那一屏的导出回执与预览时间戳是组件局部的：在调查 A 上发起导出、直接点 B 的 tab
       * （B 也停在报告屏），A 的「导出中」会挂在 B 这一屏上，A 的回执迟到之后
       * 印在 B 的报告底下——一份交付物的落点被记到了另一次调查名下。
       *
       * 报告屏画上 tab 条之后这条路才真的走得到：在那之前换调查必经工作区，那一跳
       * 本来就把这一屏卸掉了。**"进行中"不受重挂影响**，它在上面那个应用级的 `exporting` 里。
       */
      <Report
        key={openCase}
        snap={snap}
        tabs={tabStrip}
        exporting={exporting}
        onExporting={setExporting}
        onBack={() => hideReport(openCase)}
        onNotice={setNotice}
      />,
    );
  }

  return shell(
    <div className="page workspace">
      <header className="pagehead ws">
        {/* 顶栏只回答"我在哪个工作区、能去哪儿"（ui.md §2）。标题、基准日期、模型都不在这儿：
            那一条是定高的整幅一格，几项挤进去之后每一项都只剩几个字。
            建单信息搬去了舞台上的信息卡，运行态搬去了底部状态栏 */}
        <span className="wsroot" title={snap.case.projectRoot ?? '这次调查没有工作区'}>
          {snap.case.projectRoot ? (
            <>
              {/* 父路径在前、目录名在后：认调查靠最后那一段，而"是不是那个仓库"要看前面
                  ——同名目录挂在不同父目录下是常事。挤不下时截的是前面那截 */}
              <em>{snap.case.projectRoot.split('/').slice(0, -1).join('/')}/</em>
              <code>{snap.case.projectRoot.split('/').slice(-1)[0]}</code>
            </>
          ) : (
            <code className="none">无工作区</code>
          )}
        </span>
        <div className="headacts">
          {/* 跨案汇总（D28）在这一屏上的落点是下面那排 tab 上的暖色点：
              别处那条卡在 ask_operator 上的支线，只要它还开着 tab 就一直标在那儿 */}
          {/* 两条时间线不是顶栏的两个 tab：调查线属于工作区，系统线属于报告（ui.md §1）。
              收尾也在那一屏里——先看这份能不能交出去，再决定收不收 */}
          {/* 「预览」是这句话的一部分，不是挂在「报告」后面的一个小字：
              没收尾时这份还会变，收尾之后它就是冻住的那一份，两句话该各说各的 */}
          <button
            // `toreport` 是两处探针的抓手：`main/index.ts` 的 `INQUESTRY_SHOT_REPORT`
            // 与 preview 的 `?report` 直达参数都靠它进报告屏，样式走 `.headacts button`。
            // 删它之前先看那两段
            className="toreport"
            title={frozen ? '这次调查已经收尾，报告是冻住的那一份' : '按现有数据看报告：可以就此定稿，也可以直接导出半成品'}
            onClick={() => showReport(openCase)}
          >
            <Icon name="report" />
            {frozen ? '查看报告' : '预览报告'}
          </button>
          <button title="回首页起一次新的调查；这一次照旧在后台跑" onClick={() => setScreen('home')}>
            <Icon name="plus" />
            新调查
          </button>
        </div>
      </header>
      <div className="pagebody ws">

      {/* 打开着的调查。**长在内容区里而不是顶栏上**：顶栏是定高的整幅一格、还兼着拖拽区，
          46px 里已经装了工作区路径与两枚动作。报告屏上是同一个元素（那一屏是同一个 tab 的
          另一种视图）；首页与历史本来就是"去开一个 tab"的入口，设置屏与任何调查都无关 */}
      {tabStrip}

      {/* 环境不通的横幅只在工作区出：设置屏那一节把同一件事说得更细，
          两处都挂的话人会以为是两个问题。
          **只认明确的"没登录"**：探不出来（null）时闭嘴——CLI 是自带的，
          这一条唯一能拦住的就是没登录，而拿一次探测失败去吓人不值当 */}
      {env?.loggedIn === false && (
        <div className="banner">
          Claude 还没登录。在终端里跑一次 <code>claude auth login</code>，再回来开始排查。
        </div>
      )}

      {frozen && (
        <div className="banner frozen">
          <span>{frozenText(snap.case)}</span>
          <button onClick={() => showReport(openCase)}>看报告</button>
        </div>
      )}

      {/* 冻结之后这条只剩陈述：`restart()` 最终走 `start()`，而它对已收尾的调查直接返回，
          按钮点了没有任何反应。留着错误本身是有用的——多半正是当初放弃的原因 */}
      {snap.lastError && !snap.busy && (
        <div className="banner err">
          <span>
            {frozen ? '收尾前最后一轮没跑起来：' : '上一轮没跑起来：'}
            {snap.lastError}
          </span>
          {!frozen && <button onClick={() => void window.inquestry.restart(openCase)}>重开一轮会话</button>}
        </div>
      )}

      {/* 舞台是一整幅可缩放拖拽的画布（ui.md §3）。信息卡是主干那一列的开头，
          待办与闸门**钉在视口上**、不落进画布——①档「永远置顶」在画布的世界里
          没有 top，一张能被人拖出屏幕的卡不叫置顶 */}
      <Stage
        meta={snap.case}
        steps={snap.steps}
        chat={snap.chat}
        busy={snap.busy}
        sessionId={snap.sessionId}
        liveLanes={snap.liveLanes}
        tail={tail}
        pending={snap.pending}
        gates={snap.gates}
        onExcerpt={showExcerpt}
        onStopLane={(lane) => void window.inquestry.stopLane(openCase, lane)}
        onRename={(title) => window.inquestry.renameCase(openCase, title)}
        onReport={() => showReport(openCase)}
        todos={
          <>
            {snap.pending.map((p) => (
              <PendingCard
                key={p.id}
                ask={p}
                focused={focus === p.id}
                draft={cardDraft(p.id)}
                onDraft={(patch) => patchDraft(p.id, patch)}
                grab={grabKeyboard}
                onSubmit={(r) => dispose(p.id, () => window.inquestry.answerOperator(openCase, r))}
              />
            ))}
            {snap.gates.map((g) => (
              <GateCard
                key={g.id}
                gate={g}
                focused={focus === g.id}
                grab={grabKeyboard}
                draft={cardDraft(g.id)}
                onDraft={(patch) => patchDraft(g.id, patch)}
                onDecide={(d) => dispose(g.id, () => window.inquestry.decideGate(openCase, d))}
              />
            ))}
          </>
        }
      />

      <footer className="dock">
        <div className="composer">
          <textarea
            value={input}
            disabled={frozen}
            placeholder={
              frozen
                ? '本次调查已结束'
                : live
                  ? '补充点信息...'
                  : '请描述问题...'
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !frozen) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {/* **文案恒为「发送」**，不随会话状态改口。它做的事确实分两档（没会话就先起一轮，
              见 `submit`），但那是 harness 的事——人这一下的意图始终是"把这段话送进去"，
              而一枚会变字的按钮反倒像是两个不同的动作 */}
          <button className="primary" disabled={frozen || !input.trim()} onClick={() => void submit()}>
            <Icon name="send" />
            发送 <small>⌘↵</small>
          </button>
        </div>
        <RunBar
          snap={snap}
          todos={todos.length}
          takeover={takeover}
          frozen={frozen}
          onStop={() => void window.inquestry.interrupt(openCase)}
          onTakeover={(on) => void takeCharge(on)}
        />
      </footer>
      </div>

      {excerpt && (
        <div className="overlay" onClick={() => setExcerpt(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>{excerpt.title}</h3>
            <pre>{excerpt.body}</pre>
            <button onClick={() => setExcerpt(null)}>关闭</button>
          </div>
        </div>
      )}
    </div>,
  );
}


/** 冻结之后要把**当时定下的形态**说出来：报告装成什么样是那一下决定的，事后没有入口再改。 */
function frozenText(meta: CaseMeta) {
  const shape = meta.verdictShape ? `报告按${SHAPE_COPY[meta.verdictShape].label}装。` : '';
  return meta.status === 'closed'
    ? `本次调查已定稿并冻结。${shape}证据与结论都还在，接着查请另建一次调查。`
    : `本次调查已归档（人为终止）。${shape}证据一条没少，可导出半程报告——它没有根因栏，因为没查出来就是没查出来。`;
}


export type { PendingAsk };
