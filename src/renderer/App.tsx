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
import { useEscape } from './esc.js';

declare global {
  interface Window {
    inquestry: InquestryApi;
  }
}

export function App({
  /**
   * 起手停在哪一屏。**只有浏览器预览会传**（`preview/main.tsx` 的 `?screen=`）：
   * 那儿改一行样式就整页重载一次，每次都从首页点回去的话，深处那几屏根本调不动。
   */
  initialScreen,
}: { initialScreen?: Screen } = {}) {
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  /**
   * 报告开着的是**哪个调查**的（D21：工作区与报告是两个屏，不是同屏两个 tab）。
   *
   * 记调查而不是记一个 `screen` 枚举：切到别的调查时报告屏得自己让开——
   * 留着的话，屏幕上是调查 B 的标题配调查 A 的章节，而报告正是这个工具唯一交出去的东西。
   * 与确认条按 caseId 记是同一条理由，只是那一条的代价大得多。
   */
  const [reportOf, setReportOf] = useState<string | null>(null);
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
  /** 别处等着人的调查。D28 的整条理由：不汇总的话后台那条支线会静静挂死。 */
  const elsewhere = useMemo(() => snap.cases.filter((c) => !c.current && c.todos > 0), [snap.cases]);
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

  /** 打开某次调查 = 切过去 + 翻到工作区。切换本身不中断任何一个（D28）。 */
  const open = (id: string) => {
    void window.inquestry.switchCase(id);
    setScreen('workspace');
  };

  /**
   * 从列表直奔某次调查的报告屏。
   *
   * `reportOf` 记的是 caseId 而报告屏认的是「它等于当前调查」，所以先记后切两句缺一不可：
   * 切换要等下一次快照（最多 60ms）才在这一屏生效，这中间显示的是**上一个**调查的工作区。
   * 那一拍与 `open()` 那条是同一个，不额外补一个"正在切"的中间态——补了反而多一屏闪烁。
   */
  const openReport = (id: string) => {
    setReportOf(id);
    void window.inquestry.switchCase(id);
    setScreen('workspace');
  };

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
        // 而人下一步想做的一定是点「开始排查」
        onCreated={() => setScreen('workspace')}
        onAll={() => setScreen('history')}
      />,
    );
  }
  if (screen === 'history')
    return shell(<History cases={snap.cases} onOpen={open} onReport={openReport} />);
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
   * 报告是**另一个屏**，整屏换掉（D21）：主角、密度、能做的事都不一样。
   * 挂在这儿而不是塞进主区，是为了让工作区的顶栏与底部状态栏一并让开——
   * 那条状态栏说的是"这一轮在跑什么"，而报告这一屏上没有"这一轮"。
   * 收尾两档（定稿 / 归档）也在那边：先看这份能不能交出去，再决定收不收。
   */
  if (reportOf === openCase) {
    return shell(<Report snap={snap} onBack={() => setReportOf(null)} onNotice={setNotice} />);
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
          {/* 跨案汇总的三个落点之一（D28）：别处那条卡在 ask_operator 上的支线，
              在这一屏上只剩这一枚。它是个跳转，所以长在动作那一侧 */}
          {elsewhere.length > 0 && (
            <button
              className="pill todo other"
              title={elsewhere.map((c) => `${c.title}（${c.todos}）`).join('\n')}
              onClick={() => void window.inquestry.switchCase(elsewhere[0]!.id)}
            >
              别的调查 {elsewhere.reduce((n, c) => n + c.todos, 0)}
            </button>
          )}
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
            onClick={() => setReportOf(openCase)}
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
          <button onClick={() => setReportOf(openCase)}>看报告</button>
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
        onReport={() => setReportOf(openCase)}
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
