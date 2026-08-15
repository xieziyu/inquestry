import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_SNAPSHOT,
  type CallNode,
  type ChatLine,
  type CaseMeta,
  type InquestryApi,
  type PendingAsk,
  type Snapshot,
  type StepNode,
  type TakeoverResult,
} from '../shared/ipc.js';
import { SHAPE_COPY } from '../shared/report.js';
import { draftKey, pruneDrafts, type CardDrafts } from './drafts.js';
import { trackLayout, weaveChat, type TrackRow } from './track.js';
import { CaseCard } from './CaseCard.js';
import { RunBar } from './RunBar.js';
import { GateCard } from './GateCard.js';
import { Icon } from './Icon.js';
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

  // 接管的意图不跨排查：留着的话新排查的开关会先画上一次排查按下的那一下
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
   * 输入框那一枚钮，两档合一：会话开着就发消息，没开就先起一轮再发。
   *
   * 合成一个是因为**人的动作是同一个**——想让它去查点什么。分成"舞台上一枚开始钮 +
   * 输入框一枚发送钮"的话，第一句话得先按一次开始、再回到输入框敲一遍。
   *
   * 送不出去就把草稿留着。切排查 / 点「新开排查」之后 main 那边当时就没有当前排查了，
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
      {/* 没落地的处置要说出来，而且**得在任何一屏上都说得出来**：
          它多半正是因为排查切走了才没落地，那时那张卡片、甚至整个工作区都不在屏幕上；
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
                <Icon name="plus" />
                去首页新建
              </button>
              <button onClick={() => setScreen('history')}>
                <Icon name="arrow" />
                从历史排查里挑一个
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
            建单信息搬去了舞台上的立案卡，运行态搬去了底部状态栏 */}
        <span className="wsroot" title={snap.case.projectRoot ?? '这次排查没有工作区'}>
          {snap.case.projectRoot ? (
            <>
              {/* 父路径在前、目录名在后：认排查靠最后那一段，而"是不是那个仓库"要看前面
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
              别的排查 {elsewhere.reduce((n, c) => n + c.todos, 0)}
            </button>
          )}
          {/* 两条时间线不是顶栏的两个 tab：排查线属于工作区，系统线属于报告（ui.md §1）。
              收尾也在那一屏里——先看这份能不能交出去，再决定收不收 */}
          {/* 「预览」是这句话的一部分，不是挂在「报告」后面的一个小字：
              没收尾时这份还会变，收尾之后它就是冻住的那一份，两句话该各说各的 */}
          <button
            // `toreport` 现在只是无人值守探针的抓手（`main/index.ts` 的 `INQUESTRY_SHOT_REPORT`
            // 靠它进报告屏），样式走 `.headacts button`。删它之前先看那一段
            className="toreport"
            title={frozen ? '这次排查已经收尾，报告是冻住的那一份' : '按现有数据看报告：可以就此定稿，也可以直接导出半成品'}
            onClick={() => setReportOf(openCase)}
          >
            <Icon name="report" />
            {frozen ? '查看报告' : '预览报告'}
          </button>
          <button title="回首页起一次新的排查；这一次照旧在后台跑" onClick={() => setScreen('home')}>
            <Icon name="plus" />
            新排查
          </button>
        </div>
      </header>
      <div className="pagebody ws">

      {/* 环境不通的横幅只在工作区出：设置屏那一节把同一件事说得更细，
          两处都挂的话人会以为是两个问题 */}
      {env && !env.claude && (
        <div className="banner">未找到 claude 可执行文件。请先安装 Claude Code 并在终端登录一次。</div>
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
        {/* 立案卡是轨道的第 0 个节点：标题（可改）、问题描述、基准日期、工作区。
            **「接着查」不在这儿**——那是个动作，长在底下输入框旁边；
            摆在舞台顶上的话，点开一次旧排查，第一眼看到的就是一个催你再跑一轮的按钮 */}
        <CaseCard
          meta={snap.case}
          onRename={(title) => window.inquestry.renameCase(openCase, title)}
        />

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

        <InvestigationTimeline
          steps={snap.steps}
          chat={snap.chat}
          question={snap.case.question}
          liveLanes={snap.liveLanes}
          onExcerpt={showExcerpt}
          onStopLane={(lane) => void window.inquestry.stopLane(openCase, lane)}
        />
      </main>

      <footer className="dock">
        <div className="composer">
          <textarea
            value={input}
            disabled={frozen}
            placeholder={
              frozen
                ? '这次排查已经收尾了，接着查请另建一次排查。'
                : live
                  ? '补充信息、纠偏方向，或让它换个假设…'
                  : '写下要查的东西，发出去就开一轮会话…'
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
  chat,
  question,
  liveLanes,
  onExcerpt,
  onStopLane,
}: {
  steps: StepNode[];
  /** agent 与人说的话，织进轨道（`weaveChat`）——不再压成底部一条带。 */
  chat: ChatLine[];
  /** 开场白认不出来就会与立案卡重复一遍，见 `weaveChat`。 */
  question: string;
  /** 还在跑的泳道。只有这几条给得出「停」——停一条已经收尾的支线什么都不会发生。 */
  liveLanes: string[];
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
  onStopLane: (lane: string) => void;
}) {
  const layout = useMemo(() => trackLayout(steps), [steps]);
  const items = useMemo(() => weaveChat(layout.rows, chat, question), [layout.rows, chat, question]);
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
      {items.map((item) =>
        item.kind === 'chat' ? (
          <SayCard key={item.id} line={item.line} />
        ) : (
          <Fragment key={item.id}>
          {item.row.sessionBreak && (
            <div className="sessionmark">第 {item.row.step.sessionIndex} 次会话</div>
          )}
          <div
            className={item.row.depth ? 'lane branch' : 'lane'}
            style={{ marginLeft: `calc(${item.row.depth} * var(--track-indent))` }}
          >
            <StepCard
              row={item.row}
              live={!!item.row.step.lane && liveLanes.includes(item.row.step.lane)}
              onExcerpt={onExcerpt}
              onStopLane={onStopLane}
              nodeRef={(el) => {
                if (el) nodes.current.set(item.id, el);
                else nodes.current.delete(item.id);
              }}
            />
          </div>
          </Fragment>
        ),
      )}
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

/**
 * 轨道上的一句话：agent 的判断、人的补充、harness 的提示。
 *
 * 三种角色**用同一张卡的三个变体**，不做成三种东西：它们在轨道上占的位置是同一种
 * ——"某一步与某一步之间说了句话"。区别只在左边那枚角色标与色相。
 *
 * 卡片刻意比 step 窄一档、不带边框：它是旁白，不是节点。做成同样的一张卡的话，
 * 一屏上会有两种长得一样但一种带证据、一种什么都没有的东西。
 */
function SayCard({ line }: { line: ChatLine }) {
  return (
    <div className={`say ${line.role}`}>
      <span className="who">{sayLabel(line.role)}</span>
      <p>{line.text}</p>
    </div>
  );
}

/** 「补充」而不是「你」：人在这儿说的话语义是**异步入队的补充**（ui.md §8.2），不是聊天。 */
function sayLabel(role: ChatLine['role']) {
  return ({ assistant: 'agent', user: '补充', system: '系统' } as const)[role];
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
            <Icon name="stop" size={9} />停
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
          <button className={`toggle ${open ? 'up' : ''}`} onClick={() => setOpen(!open)}>
            <Icon name="chevron" />
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

/** 只管 step 的状态。会话那几档由底部状态栏自己说（`RunBar` 的 `stateLabel`）——
    那儿要分"这一轮"与"这次排查"，与一步的结论不是一套词。 */
function statusLabel(s: StepNode['status']) {
  return (
    { open: '进行中', confirmed: '已证实', refuted: '已推翻', inconclusive: '未查清', superseded: '被推翻', converged: '已收口' } as const
  )[s];
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
