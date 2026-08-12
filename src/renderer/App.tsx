import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_SNAPSHOT,
  VERDICT_SHAPES,
  type CallNode,
  type CaseBrief,
  type CaseMeta,
  type ClosingStepKind,
  type InquestryApi,
  type PendingAsk,
  type ShapeSuggestion,
  type Snapshot,
  type StepNode,
  type VerdictShape,
} from '../shared/ipc.js';
import { draftKey, pruneDrafts, stateFillable, type CardDrafts } from './drafts.js';
import { GateCard } from './GateCard.js';
import { Intake } from './Intake.js';
import { isPlainKey, isTyping } from './keys.js';
import { PendingCard } from './PendingCard.js';

declare global {
  interface Window {
    inquestry: InquestryApi;
  }
}

type View = 'investigation' | 'incident';

export function App() {
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [view, setView] = useState<View>('investigation');
  /**
   * 输入草稿**按案子分开存**。共用一个的话，在 A 案写到一半切到 B 案，输入框里还是那段字，
   * 一发送就把 A 的线索写进了 B 的会话——串案而且毫无提示。
   * 分开存还顺带保住了草稿：切回去它还在。
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [env, setEnv] = useState<{ claude: string | null; hint: string } | null>(null);
  const [excerpt, setExcerpt] = useState<{ title: string; body: string } | null>(null);
  /**
   * 待办处置没落地时的提示。
   *
   * 挂在应用级而不是卡片上：处置失败多半正是因为案子切走了，那张卡这会儿根本不在屏幕上。
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 收尾里要人再点一下的那两档（D29）。停止不在此列——它随时能接着查，拦一道只是碍事；
   * 结案与归档都会把案子冻上，冻错了没有回头路，所以要说清后果再确认。
   *
   * **必须连 caseId 一起记。** 只记动作的话，在 A 案弹出确认条之后切到 B 案，
   * 这条 state 还在，而按钮那一下取的是**当时**的 `openCase`——于是把 B 案不可逆地收掉了，
   * 确认文案讲的还是 A 的事。这是本页唯一一个"点下去就没有回头路"的手势，
   * 它是唯一必须自己带上下文的。
   */
  const [confirm, setConfirm] = useState<{
    caseId: string;
    kind: 'closed' | 'aborted';
    /**
     * 报告按哪种形态装（D25）。**跟着这条 state 走，不每帧从快照取**：
     * 快照每 60ms 一轮，而人正在这条确认条上挑——取快照的话手上选的会被下一轮冲掉。
     * 归档那一档没有它：残报告强制是未决型，不给选（ui.md §8.4）。
     */
    shape?: VerdictShape;
    /**
     * 弹出那一刻 main 算出来的**整份**建议，原样冻住。
     *
     * 只冻形态、别的（出处、状态型填不填得出来）现取的话，各项会指着不同的根因：
     * 屏幕上是弹出时那个推断值，标签却成了"agent 判定"——而 agent 声明的是另一种形态；
     * 更糟的一种是根因整个换了人，预选跟着换成了新根因的 `state`，
     * "这一块会是空的"却按旧根因判定成不必提醒，人于是在毫不知情下冻出一份空主体报告。
     */
    suggestion?: ShapeSuggestion;
    /**
     * 人动过手没有。**必须显式记，不能拿"当前值 ≠ 建议值"推**：挑过别的又切回建议值那一档
     * 会重新显示成 agent 判定，而建议值自己变了的话，人一下没碰过也会被标成"你选的"。
     */
    picked?: true;
  } | null>(null);
  /**
   * 待办卡里人已经敲进去的东西（改过的语句 / 粘贴的结果 / 执行时间 / 拒绝理由）。
   *
   * **按「案子 + 条目 id」存在这一层**：卡片是跟着快照渲染的，一切案子旧卡片就卸载，
   * 局部 state 随之蒸发——切回来时它会按 ask/gate 的初值重新挂上，人贴的结果、
   * 写好的拒绝理由全没了。只有处置真的落地才清掉。
   */
  const [cardDrafts, setCardDrafts] = useState<CardDrafts>({});
  /**
   * **会话正在进行**，不是「开过会话」。ended / crashed 都得能重开——那正是
   * 「接着查」新起一轮的入口；把它们算成 started 的话，跑完或崩掉之后按钮不出现，
   * 输入框却还能发，消息进的是一个已经没人消费的队列。
   */
  const live = snap.sessionStatus === 'live';
  /** 结案 / 归档之后只能看和导出：开新会话会往一个已下结论的案子里追加步骤。 */
  const frozen = !!snap.case && snap.case.status !== 'open';
  // ①档永远置顶：闸门到点会自己放行，回填不处理就永远等下去（ui.md §4）
  const todos = useMemo(
    () => [...snap.pending.map((p) => p.id), ...snap.gates.map((g) => g.id)],
    [snap.pending, snap.gates],
  );
  /** 别处等着人的案子。D28 的整条理由：不汇总的话后台那条支线会静静挂死。 */
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

  // 换了案子就把没点完的确认收掉。渲染那侧还会再核一次 caseId：
  // effect 要等这一帧渲染完才跑，中间那一下按钮照样点得到
  useEffect(() => setConfirm(null), [snap.case?.id]);

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
   * 送不出去就把草稿留着。切案子 / 点「＋ 新案件」之后 main 那边当时就没有当前案子了，
   * 而这一屏还要等下一次快照才换——先清空再发的话，那段字直接消失。
   */
  const submit = async () => {
    const text = input.trim();
    if (!caseId || !text) return;
    if (await window.inquestry.send(caseId, text)) setDrafts((d) => ({ ...d, [caseId]: '' }));
  };

  // 没选中案子时整屏只有立案面板：没有基准日与问题，后面所有东西都无从谈起。
  // 切换栏照常在——立到一半改主意，得能回到原来那个案子
  if (!snap.case) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            Inquestry<span className="dot" />
          </div>
        </header>
        <CaseBar cases={snap.cases} />
        {env && !env.claude && (
          <div className="banner">未找到 claude 可执行文件。请先安装 Claude Code 并在终端登录一次。</div>
        )}
        <main className="stage">
          <Intake onSubmit={(d) => window.inquestry.createCase(d)} />
        </main>
      </div>
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
   * 点「结案」。**先问 main 现在还差什么，再决定弹确认还是派活**——
   * 不拿快照上的 `closingGaps` 做这个判断：它是 60ms 合流推来的，
   * agent 可能刚补完最后一步而这一屏还没收到，那时按钮上写着"差 1 步"、
   * 点下去却会走进执行路径，把案子不可逆地冻上且完全没经过确认。
   *
   * 缺步时不是报个错就完：那两步的内容只有查过的人给得出来，所以派给 agent 去补。
   */
  const requestClose = async () => {
    const r = await window.inquestry.requestClosing(openCase).catch(() => null);
    if (!r) return setNotice('没问到这个案子的状态，可能它已经切走了。切回去再点一次。');
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
        ? `结案前还差${what}，已经让 agent 去补了。补完再点一次结案。`
        : `结案前还差${what}。先点「${startLabel(snap)}」让 agent 补上这两步；就此收手请用归档。`,
    );
  };

  /**
   * 确认那一下的落地回执。**没落地就别把确认条收掉**——确认条挂在屏幕上的这段时间里，
   * 强制 step 可能被推翻、案子可能被切走，两种情况 main 都会回绝；
   * 收掉确认条而什么都没发生的话，人会以为已经结案了。
   */
  const doClose = async (kind: 'closed' | 'aborted', id: string, shape: VerdictShape) => {
    if (kind === 'aborted') {
      const ok = await window.inquestry.archiveCase(id).catch(() => false);
      if (ok) return setConfirm(null);
      return setNotice('归档没执行：这个案子已经不是当前案子了。切回去再试一次。');
    }
    const r = await window.inquestry.closeCase(id, shape).catch(() => null);
    if (r?.ok) return setConfirm(null);
    setNotice(
      r && !r.ok && r.missing.length
        ? `结案没执行：刚才这会儿又缺了${r.missing.map(closingLabel).join('与')}——多半是那一步刚被推翻。补上再来。`
        : '结案没执行：这个案子已经不是当前案子了。切回去再试一次。',
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
    setNotice('刚才那条没处置成功：可能案子已经切走了，也可能它已经到点自动放行。切回那个案子再看一眼，刚才填的还在。');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Inquestry<span className="dot" />
          <span className="case">{snap.case.title}</span>
        </div>
        <CaseMetaStrip meta={snap.case} />
        <div className="tabs">
          <button className={view === 'investigation' ? 'on' : ''} onClick={() => setView('investigation')}>
            排查时间线
          </button>
          <button className={view === 'incident' ? 'on' : ''} onClick={() => setView('incident')}>
            事故时间线 <span className="count">{snap.incident.length}</span>
          </button>
        </div>
        <div className="status">
          {todos.length > 0 && <span className="pill todo">等你 {todos.length}</span>}
          {elsewhere.length > 0 && (
            <button
              className="pill todo other"
              title={elsewhere.map((c) => `${c.title}（${c.todos}）`).join('\n')}
              onClick={() => void window.inquestry.switchCase(elsewhere[0]!.id)}
            >
              别的案子 {elsewhere.reduce((n, c) => n + c.todos, 0)}
            </button>
          )}
          <span className={`pill ${snap.busy ? 'busy' : snap.sessionStatus}`}>
            {snap.busy ? '进行中' : statusLabel(snap.sessionStatus)}
          </span>
          {/* 收尾三档各是一个动作，不合成一个「结束」（D29）：
              停止随时能接着查、结案要走完两个强制 step、归档是明写的放弃 */}
          {!frozen && (
            <>
              {snap.busy && (
                <button title="中断当前轮，案子照旧开着" onClick={() => void window.inquestry.interrupt(openCase)}>
                  停止
                </button>
              )}
              <button
                title={
                  snap.closingGaps.length
                    ? `结案前还差：${snap.closingGaps.map(closingLabel).join(' / ')}`
                    : '下结论并冻结这个案子'
                }
                onClick={() => void requestClose()}
              >
                结案{snap.closingGaps.length ? `（差 ${snap.closingGaps.length} 步）` : ''}
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

      <CaseBar cases={snap.cases} />

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
            // 收的是**弹出确认时**那个案子，不是此刻屏幕上的那个。
            // main 那侧还会用 `currentIf` 再核一次：切走了就整个不执行，
            // 而不是落到新案子头上——而回绝了这边要说出来，见 doClose
            onClick={() => void doClose(confirm.kind, confirm.caseId, confirm.shape ?? 'open')}
          >
            {confirm.kind === 'closed' ? '确认结案' : '确认归档'}
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
        </div>
      )}

      {/* 冻结之后这条只剩陈述：`restart()` 最终走 `start()`，而它对已收尾的案子直接返回，
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

        {view === 'investigation'
          ? <InvestigationTimeline steps={snap.steps} onExcerpt={showExcerpt} />
          : <IncidentTimeline snap={snap} onExcerpt={showExcerpt} />}

        {view === 'investigation' && <ReportStrip snap={snap} />}
      </main>

      <footer className="dock">
        <ChatStrip snap={snap} />
        <div className="composer">
          <textarea
            value={input}
            disabled={frozen}
            placeholder={
              frozen ? '这个案子已经收尾了，接着查请另立案件。' : live ? '补充线索、纠偏方向，或让它换个假设…' : `先点「${startLabel(snap)}」`
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

      {excerpt && (
        <div className="overlay" onClick={() => setExcerpt(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>{excerpt.title}</h3>
            <pre>{excerpt.body}</pre>
            <button onClick={() => setExcerpt(null)}>关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 案件切换栏（D28 / ui.md §8.3）。进行中的排在前面，各带一个徽标。
 *
 * 切换不中断任何一个：main 持有全部运行时，这里只是换个投影看。
 * 徽标上的「等你 N」是并发排查里唯一能看见后台支线在等人的地方。
 */
function CaseBar({ cases }: { cases: CaseBrief[] }) {
  if (!cases.length) return null;
  return (
    <nav className="casebar">
      {cases.map((c) => (
        <button
          key={c.id}
          className={`chip ${c.status} ${c.current ? 'on' : ''}`}
          title={c.title}
          onClick={() => !c.current && void window.inquestry.switchCase(c.id)}
        >
          <span className="t">{c.title}</span>
          {c.todos > 0 ? (
            <span className="b todo">等你 {c.todos}</span>
          ) : c.running ? (
            <span className="b run">跑动中</span>
          ) : (
            <span className="b idle">{caseStateLabel(c)}</span>
          )}
        </button>
      ))}
      <button className="chip new" onClick={() => void window.inquestry.newCase()}>
        ＋ 新案件
      </button>
    </nav>
  );
}

/** 从没跑过 / 跑完了接着查 / 崩了重来，是三句不同的话——按钮和输入框提示要用同一句。 */
function startLabel(snap: Snapshot) {
  if (snap.sessionStatus === 'crashed') return '重开一轮会话';
  return snap.steps.length ? '接着查（新起一轮会话）' : '开始排查';
}

function closingLabel(k: ClosingStepKind) {
  return ({ impact: '影响面', leftover: '遗留疑点' } as const)[k];
}

/**
 * 五种结论形态（D25 / overview §6.1.1）。文案说的是**什么时候是它**，不是术语解释：
 * 人在确认条上停留的那几秒里要能对着自己的案子选，而不是先学一遍名词。
 */
const SHAPE_COPY: Record<VerdictShape, { label: string; when: string; body: string }> = {
  sequence: { label: '时序型', when: '顺序 / 竞态错了', body: '事故时间线' },
  state: { label: '状态型', when: '某个东西一直就是错的', body: '应然 / 实然对照' },
  chain: { label: '因果链型', when: '一处变更连锁放大', body: '因果链 + 最弱一环' },
  distribution: { label: '分布型', when: '问题只在某一小撮上', body: '归因切分' },
  open: { label: '未决型', when: '没查出来', body: '排除矩阵 + 遗留疑点' },
};

/**
 * 结案那一下选报告形态。**它是这一步唯一需要人做的判断**——
 * agent 声明过就预选它的，没声明就预选推断值，人不动手也能一路按到底。
 *
 * 摆在确认条里而不是单开一屏：形态决定报告装哪几块，而"确认结案"正是唯一
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
  return { agent: 'agent 判定', inferred: '没人判定过，按现有数据推的', operator: '你选的' }[source];
}

/** 确认那一下要说的是**后果**，不是"你确定吗"——两档的后果不一样，说反了就白确认了。 */
function confirmText(kind: 'closed' | 'aborted', snap: Snapshot) {
  if (kind === 'closed') {
    return `结案会冻结这个案子：不能再开会话，只能导出。根因取的是当前置信度最高的那条结论${
      snap.report.rootCause ? `（${snap.report.rootCause.slice(0, 40)}…）` : '——目前一条已证实的都没有'
    }。`;
  }
  return '归档 = 明写放弃这次排查。已经查到的证据一条都不删，仍能导出残报告——但那份报告没有根因栏，主体是排除掉的方向与遗留疑点。';
}

/** 冻结之后要把**当时定下的形态**说出来：报告装成什么样是那一下决定的，事后没有入口再改。 */
function frozenText(meta: CaseMeta) {
  const shape = meta.verdictShape ? `报告按${SHAPE_COPY[meta.verdictShape].label}装。` : '';
  return meta.status === 'closed'
    ? `本案已结案并冻结。${shape}证据与结论都还在，接着查请另立案件。`
    : `本案已归档（人为终止）。${shape}证据一条没少，可导出残报告——它没有根因栏，因为没查出来就是没查出来。`;
}

function caseStateLabel(c: CaseBrief) {
  if (c.status === 'closed') return '已结案';
  if (c.status === 'aborted') return '已归档';
  return c.loaded ? '已停' : '未打开';
}

/**
 * 排查时间线**按 case 取而非按 session 取**：一个案子跨多会话，按 session 取的话
 * 重开旧案主区是空的。代价是 `ordinal` 每个会话都从 1 重来，所以要标出会话断点。
 */
function InvestigationTimeline({
  steps,
  onExcerpt,
}: {
  steps: StepNode[];
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
}) {
  // 只有一次会话时不标：那条分隔线什么都没说明，纯噪声
  const multi = new Set(steps.map((s) => s.sessionIndex)).size > 1;
  return (
    <>
      {steps.map((s, i) => (
        <Fragment key={s.id}>
          {multi && s.sessionIndex !== steps[i - 1]?.sessionIndex && (
            <div className="sessionmark">第 {s.sessionIndex} 次会话</div>
          )}
          <StepCard step={s} onExcerpt={onExcerpt} />
        </Fragment>
      ))}
    </>
  );
}

/** 基准日填错时报告会静静地空掉，所以它得一直在屏幕上，而不是藏在立案那一刻。 */
function CaseMetaStrip({ meta }: { meta: CaseMeta }) {
  return (
    <div className="casemeta">
      <span>
        基准日 <code>{meta.incidentDate}</code> {meta.tzOffset}
      </span>
      <span>{meta.projectRoot ? <code>{meta.projectRoot.split('/').slice(-1)[0]}</code> : '演示数据源'}</span>
      <span>
        {meta.agent.backend}
        {meta.agent.model ? ` · ${meta.agent.model}` : ''}
        {meta.agent.effort ? ` · ${meta.agent.effort}` : ''}
      </span>
    </div>
  );
}

function StepCard({
  step,
  onExcerpt,
}: {
  step: StepNode;
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`step ${step.status} ${step.kind}`}>
      <div className="head">
        <span className="ord">#{step.ordinal}</span>
        <span className={`kind ${step.kind}`}>{kindLabel(step.kind)}</span>
        <span className={`state ${step.status}`}>{statusLabel(step.status)}</span>
        {step.supersededBy && <span className="superseded">已被 {step.supersededBy} 推翻</span>}
      </div>
      <p className="direction">{step.direction ?? '（未归类：agent 在声明方向之前就先查了一次）'}</p>
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

function IncidentTimeline({
  snap,
  onExcerpt,
}: {
  snap: Snapshot;
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
}) {
  if (!snap.incident.length) {
    return <div className="empty">还没有带时间的证据。事故时间线由 occurredAt 投影而来，排查早期通常是空的。</div>;
  }
  return (
    <div className="incident">
      <p className="note">
        这条线不是 agent 写的，是对 {snap.incident.length} 条证据按事件真实发生时间排的序。
        被推翻的 step 提供的证据同样在列——结论可以被推翻，事实不会。
      </p>
      {snap.incident.map((r, i) => (
        <div key={i} className="row" onClick={() => onExcerpt(r.callId, r.anchor, r.claim)}>
          <span className="when">{r.occurredAtRaw}</span>
          <span className="actor">{r.actor ?? ''}</span>
          <span className="claim">{r.claim}</span>
          <span className={`src ${r.stepStatus}`}>{r.stepId}</span>
        </div>
      ))}
    </div>
  );
}

function ReportStrip({ snap }: { snap: Snapshot }) {
  if (!snap.report.rootCause && !snap.report.impact) return null;
  const { expected, actual } = snap.report;
  return (
    <section className="report">
      <h4>报告投影</h4>
      {snap.report.rootCause && (
        <p>
          <b>根因</b>
          {snap.report.rootCause}
        </p>
      )}
      {/* 状态型报告的主体就是这一对（D25）。它挂在根因那一步上，
          所以根因换了人这里跟着换，不会留下一段没有出处的对照 */}
      {expected && actual && (
        <p className="contrast">
          <b>本该</b>
          {expected}
          <b>实际</b>
          {actual}
        </p>
      )}
      {snap.report.impact && (
        <p>
          <b>影响面</b>
          {snap.report.impact}
        </p>
      )}
      <p className="meta">
        遗留疑点 {snap.report.leftovers} · 走错的分支 {snap.report.refuted}
      </p>
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
    { open: '进行中', confirmed: '已证实', refuted: '已推翻', inconclusive: '未查清', superseded: '被推翻', live: '会话中', ended: '已结束', crashed: '已中断', idle: '待开始' } as Record<string, string>
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

/** 自动放行的是多数，标出来只会成噪声；过过闸门的四种才要在节点上留痕。 */
function gateLabel(gate: CallNode['gate']) {
  return ({ allow: '已放行', rewrite: '参数被改写', deny: '被拒', timeout: '自动放行' } as Record<string, string>)[
    gate ?? ''
  ];
}

function kindLabel(k: StepNode['kind']) {
  return ({ normal: '排查', unclassified: '未归类', impact: '影响面', leftover: '遗留疑点' } as const)[k];
}

export type { PendingAsk };
