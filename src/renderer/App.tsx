import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_SNAPSHOT,
  VERDICT_SHAPES,
  type CallNode,
  type CaseMeta,
  type ClosingStepKind,
  type InquestryApi,
  type PendingAsk,
  type ShapeSuggestion,
  type Snapshot,
  type StepNode,
  type TakeoverResult,
  type VerdictShape,
} from '../shared/ipc.js';
import { SHAPE_COPY } from '../shared/report.js';
import { draftKey, pruneDrafts, stateFillable, type CardDrafts } from './drafts.js';
import { trackLayout, type TrackRow } from './track.js';
import { GateCard } from './GateCard.js';
import { History } from './History.js';
import { Home } from './Home.js';
import { LogoMark } from './LogoMark.js';
import { isPlainKey, isTyping } from './keys.js';
import { PendingCard } from './PendingCard.js';
import { Rail, type Screen } from './Rail.js';
import { Report } from './Report.js';
import { Settings } from './Settings.js';

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
   * 报告开着的是**哪个排查**的（D21：工作区与报告是两个屏，不是同屏两个 tab）。
   *
   * 记排查而不是记一个 `screen` 枚举：切到别的排查时报告屏得自己让开——
   * 留着的话，屏幕上是排查 B 的标题配排查 A 的章节，而报告正是这个工具唯一交出去的东西。
   * 与确认条按 caseId 记是同一条理由，只是那一条的代价大得多。
   */
  const [reportOf, setReportOf] = useState<string | null>(null);
  /**
   * 输入草稿**按排查分开存**。共用一个的话，在排查 A 写到一半切到排查 B ，输入框里还是那段字，
   * 一发送就把 A 写到一半的输入发进了 B 的会话——串到别的排查上，而且毫无提示。
   * 分开存还顺带保住了草稿：切回去它还在。
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /**
   * 现在在哪一屏（ui.md §8.5）。**只是导航，不带任何排查状态**：
   * 切排查那件事整个搬到了历史排查页，rail 上四格里没有一格记得住"哪个排查"。
   *
   * 起手在首页而不是工作区：打开 app 时手上多半没有排查，
   * 而工作区在那种情况下是一屏什么都没有的空屏。
   */
  const [screen, setScreen] = useState<Screen>(initialScreen ?? 'home');
  const [env, setEnv] = useState<{ claude: string | null; hint: string } | null>(null);
  const [excerpt, setExcerpt] = useState<{ title: string; body: string } | null>(null);
  /**
   * 待办处置没落地时的提示。
   *
   * 挂在应用级而不是卡片上：处置失败多半正是因为排查切走了，那张卡这会儿根本不在屏幕上。
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 收尾里要人再点一下的那两档（D29）。停止不在此列——它随时能接着查，拦一道只是碍事；
   * 定稿与归档都会把排查冻上，冻错了没有回头路，所以要说清后果再确认。
   *
   * **必须连 caseId 一起记。** 只记动作的话，在排查 A 弹出确认条之后切到排查 B ，
   * 这条 state 还在，而按钮那一下取的是**当时**的 `openCase`——于是把排查 B 不可逆地收掉了，
   * 确认文案讲的还是 A 的事。这是本页唯一一个"点下去就没有回头路"的手势，
   * 它是唯一必须自己带上下文的。
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
     * 弹出那一刻 main 算出来的**整份**建议，原样冻住。
     *
     * 只冻形态、别的（出处、状态型填不填得出来）现取的话，各项会指着不同的根因：
     * 屏幕上是弹出时那个推断值，标签却成了"agent 声明的"——而 agent 声明的是另一种形态；
     * 更糟的一种是根因整个换了人，预选跟着换成了新根因的 `state`，
     * "这一块会是空的"却按旧根因判定成不必提醒，人于是在毫不知情下冻出一份空主体报告。
     */
    suggestion?: ShapeSuggestion;
    /**
     * 人动过手没有。**必须显式记，不能拿"当前值 ≠ 建议值"推**：挑过别的又切回建议值那一档
     * 会重新显示成 agent 声明的，而建议值自己变了的话，人一下没碰过也会被标成"你选的"。
     */
    picked?: true;
  } | null>(null);
  /**
   * 待办卡里人已经敲进去的东西（改过的语句 / 粘贴的结果 / 执行时间 / 拒绝理由）。
   *
   * **按「排查 + 条目 id」存在这一层**：卡片是跟着快照渲染的，一换排查旧卡片就卸载，
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
  /** 定稿 / 归档之后只能看和导出：开新会话会往一个已下结论的排查里追加步骤。 */
  const frozen = !!snap.case && snap.case.status !== 'open';
  /** 接管开关按人最后按的那一下画：回执与快照都要一会儿才到，中间那一下不能显示成没按 */
  const takeover = wanted ?? snap.takeover;
  // ①档永远置顶：闸门到点会自己放行，回填不处理就永远等下去（ui.md §4）
  const todos = useMemo(
    () => [...snap.pending.map((p) => p.id), ...snap.gates.map((g) => g.id)],
    [snap.pending, snap.gates],
  );
  /** 别处等着人的排查。D28 的整条理由：不汇总的话后台那条支线会静静挂死。 */
  const elsewhere = useMemo(() => snap.cases.filter((c) => !c.current && c.todos > 0), [snap.cases]);
  const [focus, setFocus] = useState<string | null>(null);
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

  // 换了排查就把没点完的确认收掉。渲染那侧还会再核一次 caseId：
  // effect 要等这一帧渲染完才跑，中间那一下按钮照样点得到
  useEffect(() => {
    setConfirm(null);
    // 接管的意图也不跨排查：留着的话新排查的开关会先画上一次排查按下的那一下
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainKey(e) || isTyping(e.target)) return;
      const dir = e.key === 'j' ? 1 : e.key === 'k' ? -1 : 0;
      if (!dir || !todos.length) return;
      e.preventDefault();
      setFocus((f) => {
        const next = todos.indexOf(f ?? '') + dir;
        return todos[Math.max(0, Math.min(todos.length - 1, next))] ?? null;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [todos]);


  const showExcerpt = async (callId: string, anchor: string | null, title: string) => {
    setExcerpt({ title, body: await window.inquestry.excerpt(callId, anchor) });
  };

  const caseId = snap.case?.id ?? null;
  const input = caseId ? (drafts[caseId] ?? '') : '';
  const setInput = (text: string) => caseId && setDrafts((d) => ({ ...d, [caseId]: text }));

  /**
   * 送不出去就把草稿留着。切排查 / 点「＋ 新排查」之后 main 那边当时就没有当前排查了，
   * 而这一屏还要等下一次快照才换——先清空再发的话，那段字直接消失。
   */
  const submit = async () => {
    const text = input.trim();
    if (!caseId || !text) return;
    if (await window.inquestry.send(caseId, text)) setDrafts((d) => ({ ...d, [caseId]: '' }));
  };

  /**
   * rail 那颗暖色点：**有没有排查在等人**（D28 的跨案汇总）。
   *
   * 算的是全部排查而不只是当前那个——切换入口搬到历史排查页之后，
   * 这一颗点是后台那条卡在 `ask_operator` 上的支线在别的屏上仅有的痕迹。
   */
  const anyTodo = snap.cases.some((c) => c.todos > 0) || todos.length > 0;

  /** 打开某次排查 = 切过去 + 翻到工作区。切换本身不中断任何一个（D28）。 */
  const open = (id: string) => {
    void window.inquestry.switchCase(id);
    setScreen('workspace');
  };

  const shell = (content: React.ReactNode) => (
    <div className="app">
      <Rail screen={screen} todo={anyTodo} envBad={!!env && !env.claude} onGo={setScreen} />
      {/* 顶栏左端的应用标记。由外壳画一次而不是各屏各画一次——它在每一屏上都是同一个东西，
          而各屏的页头只管自己那份内容（见 styles.css 的 `.brand` 与外壳网格） */}
      <span className="brand">
        <LogoMark size={20} />
      </span>
      <div className="frame">{content}</div>
    </div>
  );

  if (screen === 'home') {
    return shell(
      <Home
        cases={snap.cases}
        onOpen={open}
        // 建完就翻到工作区：`createCase` 会把新排查设成当前排查，
        // 而人下一步想做的一定是点「开始排查」
        onCreated={() => setScreen('workspace')}
        onAll={() => setScreen('history')}
      />,
    );
  }
  if (screen === 'history') return shell(<History cases={snap.cases} onOpen={open} />);
  if (screen === 'settings') return shell(<Settings />);

  // rail 上工作区那一格随时点得到，但手上不一定有排查。
  // 不给出路的话它就是个死胡同——两个出口正好对应"新建"与"找一个旧的"
  if (!snap.case) {
    return shell(
      <div className="page">
        <header className="pagehead">
          <h1>工作区</h1>
          <span className="sub">当前没有打开的排查</span>
        </header>
        <div className="pagebody">
          <div className="ws-empty">
            <p>还没有打开任何排查。</p>
            <div className="acts">
              <button className="primary" onClick={() => setScreen('home')}>
                去首页新建
              </button>
              <button onClick={() => setScreen('history')}>从历史排查里挑一个</button>
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
   * 点「定稿」。**先问 main 现在还差什么，再决定弹确认还是派活**——
   * 不拿快照上的 `closingGaps` 做这个判断：它是 60ms 合流推来的，
   * agent 可能刚补完最后一步而这一屏还没收到，那时按钮上写着"差 1 步"、
   * 点下去却会走进执行路径，把排查不可逆地冻上且完全没经过确认。
   *
   * 缺步时不是报个错就完：那两步的内容只有查过的人给得出来，所以派给 agent 去补。
   */
  /**
   * 开 / 关接管。**没切成要说出来**：切了排查之后 main 那边回绝，
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
    if (r === 'gone') setNotice('没切成接管模式，这次排查刚切走或已经收尾了。切回去再点一次。');
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

  const requestClose = async () => {
    const r = await window.inquestry.requestClosing(openCase).catch(() => null);
    if (!r) return setNotice('没问到这次排查的状态，可能它已经切走了。切回去再点一次。');
    if (!r.missing.length) {
      // 冻的是 **main 刚刚算出来的那一份**，不是这一屏快照上的。
      // 后者是点击那一帧的闭包值，隔着这次 await——main 按最新状态放行了弹窗，
      // 界面却会冻一个过期的推断值，把 agent 刚落定的声明盖掉
      return setConfirm({
        caseId: openCase,
        kind: 'closed',
        shape: r.suggestion.shape,
        suggestion: r.suggestion,
      });
    }
    const what = r.missing.map(closingLabel).join('与');
    setNotice(
      r.asked
        ? `定稿前还差${what}，已经让 agent 去补了。补完再点一次定稿。`
        : `定稿前还差${what}。先点「${startLabel(snap)}」让 agent 补上这两步；就此收手请用归档。`,
    );
  };

  /**
   * 确认那一下的落地回执。**没落地就别把确认条收掉**——确认条挂在屏幕上的这段时间里，
   * 强制 step 可能被推翻、排查可能被切走，两种情况 main 都会回绝；
   * 收掉确认条而什么都没发生的话，人会以为已经定稿了。
   */
  const doClose = async (kind: 'closed' | 'aborted', id: string, shape: VerdictShape) => {
    // 落地之后直接翻到报告屏：收尾之后这次排查能做的只剩看和导出，
    // 而报告装成什么样正是刚才那一下决定的——让人当场看见自己按下去的后果
    if (kind === 'aborted') {
      const ok = await window.inquestry.archiveCase(id).catch(() => false);
      if (ok) {
        setConfirm(null);
        return setReportOf(id);
      }
      return setNotice('归档没执行：这次排查已经不是当前排查了。切回去再试一次。');
    }
    const r = await window.inquestry.closeCase(id, shape).catch(() => null);
    if (r?.ok) {
      setConfirm(null);
      return setReportOf(id);
    }
    setNotice(
      r && !r.ok && r.missing.length
        ? `定稿没执行：刚才这会儿又缺了${r.missing.map(closingLabel).join('与')}——多半是那一步刚被推翻。补上再来。`
        : '定稿没执行：这次排查已经不是当前排查了。切回去再试一次。',
    );
  };

  /**
   * 待办与闸门的处置回执。落地了卡片自己会随下一次快照消失，草稿跟着清掉；
   * 没落地才要说话——而且这时那张卡多半已经不在屏幕上了，所以提示挂在应用级。
   */
  const disposed = (id: string) => (ok: boolean) => {
    if (ok) {
      setCardDrafts((all) => {
        const next = { ...all };
        delete next[keyFor(id)];
        return next;
      });
      return;
    }
    setNotice('刚才那条没处置成功：可能排查已经切走了，也可能它已经到点自动放行。切回那次排查再看一眼，刚才填的还在。');
  };

  /**
   * 报告是**另一个屏**，整屏换掉（D21）：主角、密度、能做的事都不一样。
   * 挂在这儿而不是塞进主区，是为了让工作区的顶栏与底部输入带一并让开——
   * 报告上只有导出，留着"停止 / 定稿 / 归档"会让人以为这份还能改。
   */
  if (reportOf === openCase) {
    return shell(<Report snap={snap} onBack={() => setReportOf(null)} />);
  }

  return shell(
    <div className="page workspace">
      <header className="pagehead ws">
        <h1 title={snap.case.question}>{snap.case.title}</h1>
        <CaseMetaStrip meta={snap.case} />
        {/* 两条时间线不是顶栏的两个 tab：排查线属于工作区，系统线属于报告（ui.md §1）。
            它们是同一批证据的两次投影，这是数据模型的事实，不该翻译成一对开关 */}
        <div className="status">
          <button
            className="toreport"
            title={frozen ? '这次排查已经收尾，报告是冻住的那一份' : '按现有数据预览报告；定稿那一下才冻'}
            onClick={() => setReportOf(openCase)}
          >
            报告{!frozen && <em>预览</em>}
          </button>
          {todos.length > 0 && <span className="pill todo">等你 {todos.length}</span>}
          {elsewhere.length > 0 && (
            <button
              className="pill todo other"
              title={elsewhere.map((c) => `${c.title}（${c.todos}）`).join('\n')}
              onClick={() => void window.inquestry.switchCase(elsewhere[0]!.id)}
            >
              别的排查 {elsewhere.reduce((n, c) => n + c.todos, 0)}
            </button>
          )}
          <span className={`pill ${snap.busy ? 'busy' : snap.sessionStatus}`}>
            {snap.busy ? '进行中' : statusLabel(snap.sessionStatus)}
          </span>
          {/* 支线默认就在后台跑（§3.4）：主线这一轮收了，后台可能还有一条在查。
              不单独说一句的话，屏幕上写着"空闲"而实际还在查——正是这一条要防的 */}
          {snap.backgroundLanes > 0 && (
            <span className="pill busy" title="子 agent 支线在后台跑，主线不等它">
              支线 {snap.backgroundLanes}
            </span>
          )}
          {/* 接管模式（overview §3.5）。**开着时要一直看得见**：它把非放行档的每次调用都挂到
              闸门上、而那些闸门没有超时兜底——不显示的话，人下次回到屏幕前看到的是一个"卡住不动"的
              agent，而原因是他自己几天前按下的这个开关。
              文案要说清"除只读与杂务"：接管是权限入口，说成"每次调用"会让人以为连读文件都过了人，
              于是拿一个并不存在的保护去对敏感仓库（放行档见 case-runner 的 `allowed`） */}
          {!frozen && (
            <button
              className={`takeover ${takeover ? 'on' : ''}`}
              title={
                takeover
                  ? '除只读与杂务外，每次工具调用都要你放行，且不会自动过去。再点一下交回给分类器'
                  : '接管：接下来除只读与杂务外，每次工具调用都过闸门，由你放行 / 改写 / 拒绝'
              }
              onClick={() => void takeCharge(!takeover)}
            >
              {takeover ? '已接管' : '接管'}
            </button>
          )}
          {/* 收尾三档各是一个动作，不合成一个「结束」（D29）：
              停止随时能接着查、定稿要走完两个强制 step、归档是明写的放弃 */}
          {!frozen && (
            <>
              {snap.busy && (
                <button title="中断当前轮，排查照旧开着" onClick={() => void window.inquestry.interrupt(openCase)}>
                  停止
                </button>
              )}
              <button
                title={
                  snap.closingGaps.length
                    ? `定稿前还差：${snap.closingGaps.map(closingLabel).join(' / ')}`
                    : '下结论并冻结这次排查'
                }
                onClick={() => void requestClose()}
              >
                定稿{snap.closingGaps.length ? `（差 ${snap.closingGaps.length} 步）` : ''}
              </button>
              <button
                title="放弃这次排查；证据全部保留"
                onClick={() => setConfirm({ caseId: openCase, kind: 'aborted' })}
              >
                归档
              </button>
            </>
          )}
        </div>
      </header>
      <div className="pagebody ws">

      {/* 环境不通的横幅只在工作区出：设置屏那一节把同一件事说得更细，
          两处都挂的话人会以为是两个问题 */}
      {env && !env.claude && (
        <div className="banner">未找到 claude 可执行文件。请先安装 Claude Code 并在终端登录一次。</div>
      )}

      {/* 一轮失败了不等于会话结束：凭据过期时状态一直是 live，没有这条横幅就只剩
          一个显示「会话中」却什么都不动的界面，连重开的入口都没有 */}
      {notice && (
        <div className="banner err">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)}>知道了</button>
        </div>
      )}

      {confirm?.caseId === openCase && (
        <div className="banner confirm">
          <span>{confirmText(confirm.kind, snap)}</span>
          <button
            className="primary"
            // 收的是**弹出确认时**那次排查，不是此刻屏幕上的那个。
            // main 那侧还会用 `currentIf` 再核一次：切走了就整个不执行，
            // 而不是落到新排查头上——而回绝了这边要说出来，见 doClose
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

      {frozen && (
        <div className="banner frozen">
          <span>{frozenText(snap.case)}</span>
          <button onClick={() => setReportOf(openCase)}>看报告</button>
        </div>
      )}

      {/* 冻结之后这条只剩陈述：`restart()` 最终走 `start()`，而它对已收尾的排查直接返回，
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

      <main className="stage">
        {snap.pending.map((p) => (
          <PendingCard
            key={p.id}
            ask={p}
            focused={focus === p.id}
            draft={cardDraft(p.id)}
            onDraft={(patch) => patchDraft(p.id, patch)}
            onSubmit={(r) => void window.inquestry.answerOperator(openCase, r).then(disposed(p.id))}
          />
        ))}
        {snap.gates.map((g) => (
          <GateCard
            key={g.id}
            gate={g}
            focused={focus === g.id}
            draft={cardDraft(g.id)}
            onDraft={(patch) => patchDraft(g.id, patch)}
            onDecide={(d) => void window.inquestry.decideGate(openCase, d).then(disposed(g.id))}
          />
        ))}

        {!live && !frozen && (
          <div className="empty">
            <p>{snap.case.question}</p>
            {snap.sessionStatus === 'crashed' && <p className="warn">上一轮会话中断了。</p>}
            <button className="primary" onClick={() => void window.inquestry.start(openCase)}>
              {startLabel(snap)}
            </button>
          </div>
        )}

        <InvestigationTimeline
          steps={snap.steps}
          liveLanes={snap.liveLanes}
          onExcerpt={showExcerpt}
          onStopLane={(lane) => void window.inquestry.stopLane(openCase, lane)}
        />
      </main>

      <footer className="dock">
        <ChatStrip snap={snap} />
        <div className="composer">
          <textarea
            value={input}
            disabled={frozen}
            placeholder={
              frozen ? '这次排查已经收尾了，接着查请另建一次排查。' : live ? '补充信息、纠偏方向，或让它换个假设…' : `先点「${startLabel(snap)}」`
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && live) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button className="primary" disabled={!live || !input.trim()} onClick={() => void submit()}>
            发送 <small>⌘↵</small>
          </button>
        </div>
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


/** 从没跑过 / 跑完了接着查 / 崩了重来，是三句不同的话——按钮和输入框提示要用同一句。 */
function startLabel(snap: Snapshot) {
  if (snap.sessionStatus === 'crashed') return '重开一轮会话';
  return snap.steps.length ? '接着查（新起一轮会话）' : '开始排查';
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
    return `定稿会冻结这次排查：不能再开会话，只能导出。根因取的是当前置信度最高的那条结论${
      snap.report.rootCause ? `（${snap.report.rootCause.text.slice(0, 40)}…）` : '——目前一条已证实的都没有'
    }。`;
  }
  return '归档 = 明写放弃这次排查。已经查到的证据一条都不删，仍能导出半程报告——但那份报告没有根因栏，主体是排除掉的方向与遗留问题。';
}

/** 冻结之后要把**当时定下的形态**说出来：报告装成什么样是那一下决定的，事后没有入口再改。 */
function frozenText(meta: CaseMeta) {
  const shape = meta.verdictShape ? `报告按${SHAPE_COPY[meta.verdictShape].label}装。` : '';
  return meta.status === 'closed'
    ? `本次排查已定稿并冻结。${shape}证据与结论都还在，接着查请另建一次排查。`
    : `本次排查已归档（人为终止）。${shape}证据一条没少，可导出半程报告——它没有根因栏，因为没查出来就是没查出来。`;
}

/**
 * 排查时间线**按 case 取而非按 session 取**：一次排查跨多会话，按 session 取的话
 * 重开旧排查主区是空的。代价是 `ordinal` 每个会话都从 1 重来，所以要标出会话断点。
 *
 * 轨道的形状是主干 + 分叉（D23 / ui.md §3）：顺序逐字是到达顺序，分叉只往右缩进。
 * x 由 `trackLayout` 算，y 交给文档流——绝对定位的 y 得先量高度，而卡片展开工具调用时
 * 高度会变；走文档流则不重排的保证照旧（顺序不动、新节点只在末尾），还白得一个自适应。
 */
function InvestigationTimeline({
  steps,
  liveLanes,
  onExcerpt,
  onStopLane,
}: {
  steps: StepNode[];
  /** 还在跑的泳道。只有这几条给得出「停」——停一条已经收尾的支线什么都不会发生。 */
  liveLanes: string[];
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
  onStopLane: (lane: string) => void;
}) {
  const layout = useMemo(() => trackLayout(steps), [steps]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [curves, setCurves] = useState<{ id: string; d: string }[]>([]);
  const drawn = useRef('');

  /**
   * 推翻回指线要量出来才画得了：卡片高度随证据条数和"展开工具调用"变，算不出来。
   *
   * 曲线整条走在最左边的槽里（`--track-gutter`），两头贴着卡片左沿——那一带在各自那一行
   * 都是空的，所以它不会盖住任何字。多条并排时把槽位错开，否则两条推翻会叠成一条。
   */
  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const b = box.getBoundingClientRect();
    const next: { id: string; d: string }[] = [];
    layout.edges.forEach((e, i) => {
      const from = nodes.current.get(e.fromId);
      const to = nodes.current.get(e.toId);
      if (!from || !to) return;
      const f = from.getBoundingClientRect();
      const t = to.getBoundingClientRect();
      const g = 7 + (i % 3) * 6;
      const fy = f.top - b.top + 15;
      const ty = t.top - b.top + 15;
      next.push({
        id: `${e.fromId}->${e.toId}`,
        d: `M${f.left - b.left} ${fy}C${g} ${fy},${g} ${ty},${t.left - b.left - 3} ${ty}`,
      });
    });
    // 量出来一样就别 setState：ResizeObserver 每次滚动惯性都可能回调，白刷新一遍整条轨道
    const sig = `${b.width}x${b.height}|${next.map((n) => n.d).join('|')}`;
    if (sig === drawn.current) return;
    drawn.current = sig;
    setCurves(next);
  }, [layout]);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (boxRef.current) ro.observe(boxRef.current);
    // 卡片自己展开时轨道总高度也变，但按每张卡各观察一份才盖得住"高度没变、位置变了"
    for (const el of nodes.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div className="track" ref={boxRef}>
      {layout.rows.map((row) => (
        <Fragment key={row.step.id}>
          {row.sessionBreak && <div className="sessionmark">第 {row.step.sessionIndex} 次会话</div>}
          <div
            className={row.depth ? 'lane branch' : 'lane'}
            style={{ marginLeft: `calc(${row.depth} * var(--track-indent))` }}
          >
            <StepCard
              row={row}
              live={!!row.step.lane && liveLanes.includes(row.step.lane)}
              onExcerpt={onExcerpt}
              onStopLane={onStopLane}
              nodeRef={(el) => {
                if (el) nodes.current.set(row.step.id, el);
                else nodes.current.delete(row.step.id);
              }}
            />
          </div>
        </Fragment>
      ))}
      {curves.length > 0 && (
        <svg className="refutes" aria-hidden>
          <defs>
            {/* 箭头指向被推翻的那一步：没有它，曲线两头一样，得读字才知道谁推翻了谁 */}
            <marker id="refute-tip" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L6 3 L0 6 z" />
            </marker>
          </defs>
          {curves.map((c) => (
            <path key={c.id} d={c.d} markerEnd="url(#refute-tip)" />
          ))}
        </svg>
      )}
    </div>
  );
}

/** agent 补齐无日期时间串用的就是这个基准，它得一直在屏幕上——不然报告静静空掉时没人对得上。 */
function CaseMetaStrip({ meta }: { meta: CaseMeta }) {
  return (
    <div className="casemeta">
      <span>
        基准日期 <code>{meta.incidentDate}</code> {meta.tzOffset}
      </span>
      {/* 工作区如今必填；null 只可能来自这条规则之前立的旧排查 */}
      <span>{meta.projectRoot ? <code>{meta.projectRoot.split('/').slice(-1)[0]}</code> : '无工作区'}</span>
      <span>
        {meta.agent.backend}
        {meta.agent.model ? ` · ${meta.agent.model}` : ''}
        {meta.agent.effort ? ` · ${meta.agent.effort}` : ''}
      </span>
    </div>
  );
}

function StepCard({
  row,
  live,
  onExcerpt,
  onStopLane,
  nodeRef,
}: {
  row: TrackRow;
  /** 这条支线还在跑（§3.4：支线默认在后台跑，主线这一轮收了它还可能在查）。 */
  live: boolean;
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
  onStopLane: (lane: string) => void;
  nodeRef: (el: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const step = row.step;
  return (
    <section className={`step ${step.status} ${step.kind}`} ref={nodeRef}>
      <div className="head">
        <span className="ord">{row.label}</span>
        <span className={`kind ${step.kind}`}>{kindLabel(step.kind)}</span>
        {/* 缩进只说明"接在谁下面"，说不出是不是另一条 agent 在查——
            支线里的调用没经过主线的判断，读的人有权知道 */}
        {step.lane && (
          <span className="lanetag" title={`子 agent 泳道 ${step.lane}`}>
            支线 {step.lane.slice(-6)}
          </span>
        )}
        {/* 停一条支线只停它自己（§3.4），所以按钮长在那一行上而不是顶栏——
            顶栏那枚「支线 N」说不出要停的是哪一条 */}
        {live && step.lane && (
          <button
            className="stoplane"
            title="只停这一条支线，主线与别的支线照旧"
            onClick={() => onStopLane(step.lane!)}
          >
            停
          </button>
        )}
        <span className={`state ${step.status}`}>{statusLabel(step.status)}</span>
        {row.parentLabel && (
          <span className="branch" title={row.depthCapped ? '缩进已到头，父子关系仍在' : undefined}>
            ↳ 接 {row.parentLabel}
            {row.depthCapped && ' ⇥'}
          </span>
        )}
        {/* 推翻者不在这条轨道上时曲线画不出来，划线和这句话照旧——
            少一道划线就是把一个已经作废的结论显示成仍然成立的 */}
        {row.refutedBy !== null && (
          <span className="superseded">← {row.refutedBy ? `被 ${row.refutedBy} 推翻` : '已被推翻'}</span>
        )}
        {row.refutes.length > 0 && <span className="refuter">推翻了 {row.refutes.join('、')}</span>}
      </div>
      <p className="direction">
        {step.direction ??
          (step.lane
            ? '（支线：子 agent 自己的调用都记在这里，方向由主线在收敛回来时给）'
            : '（未归类：agent 在声明方向之前就先查了一次）')}
      </p>
      {step.verdict && <p className="verdict">{step.verdict}</p>}

      {step.evidence.length > 0 && (
        <ul className="evidence">
          {step.evidence.map((e) => (
            <li key={e.id} onClick={() => onExcerpt(e.callId, e.anchor, e.claim)}>
              <span className="when">{e.occurredAtRaw ?? '—'}</span>
              <span className="actor">{e.actor ?? ''}</span>
              <span className="claim">{e.claim}</span>
              <span className="anchor">{e.anchor ? `L${e.anchor}` : ''}</span>
            </li>
          ))}
        </ul>
      )}

      {step.calls.length > 0 && (
        <div className="calls">
          <button className="toggle" onClick={() => setOpen(!open)}>
            {open ? '收起' : '展开'} {step.calls.length} 次工具调用
          </button>
          {open &&
            step.calls.map((c) => (
              <div key={c.id} className={`call ${c.status}`} onClick={() => onExcerpt(c.id, null, c.toolName)}>
                <div className="callhead">
                  <b>#{c.callNumber}</b> {c.toolName}
                  <span className={`origin ${c.origin}`}>{c.origin === 'operator' ? '人工' : 'agent'}</span>
                  {gateLabel(c.gate) && <span className="gated">{gateLabel(c.gate)}</span>}
                  {callStatusLabel(c.status) && <span className={`cs ${c.status}`}>{callStatusLabel(c.status)}</span>}
                  <span className="lines">{c.outputLines} 行</span>
                </div>
                <pre>{c.outputPreview}</pre>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

function ChatStrip({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const last = useMemo(() => [...snap.chat].reverse().find((c) => c.role !== 'user'), [snap.chat]);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [snap.chat.length, open]);
  if (!snap.chat.length) return null;
  return (
    <div className={`chat ${open ? 'open' : ''}`} ref={ref}>
      <button className="toggle" onClick={() => setOpen(!open)}>
        {open ? '收起对话' : `对话 ${snap.chat.length} 条`}
      </button>
      {open ? (
        snap.chat.map((c, i) => (
          <p key={i} className={c.role}>
            <b>{c.role}</b>
            {c.text}
          </p>
        ))
      ) : (
        <p className="last">{last?.text.slice(0, 260) ?? ''}</p>
      )}
    </div>
  );
}

function statusLabel(s: string) {
  return (
    { open: '进行中', confirmed: '已证实', refuted: '已推翻', inconclusive: '未查清', superseded: '被推翻', converged: '已收口', live: '会话中', ended: '已结束', crashed: '已中断', idle: '待开始' } as Record<string, string>
  )[s] ?? s;
}

/**
 * 跑完的是多数，不标。其余三种都要写出来：一次查不到东西，原因常常是它压根没跑成，
 * 而不是"这里确实没有数据"——这两件事在报告里的分量完全不同。
 * `denied` 不在这儿，它由闸门那个标签说了。
 */
function callStatusLabel(status: string) {
  return ({ pending: '进行中', failed: '失败', abandoned: '已放弃' } as Record<string, string>)[status];
}

/**
 * 自动放行的是多数（`auto`），标出来只会成噪声；其余都要在节点上留痕。
 *
 * **两种拒必须分得开**：`auto_deny` 是 backend 那侧按后果判的，人根本没被问到——
 * 写成同一个「被拒」的话，读轨道的人会以为那是自己当时拦的（§8.1）。
 */
function gateLabel(gate: CallNode['gate']) {
  return (
    {
      allow: '已放行',
      rewrite: '参数被改写',
      deny: '被你拒了',
      auto_deny: '被自动拒了',
      timeout: '自动放行',
    } as Record<string, string>
  )[gate ?? ''];
}

function kindLabel(k: StepNode['kind']) {
  return ({ normal: '排查', unclassified: '未归类', impact: '影响面', leftover: '遗留问题' } as const)[k];
}

export type { PendingAsk };
