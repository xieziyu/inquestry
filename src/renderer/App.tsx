import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_SNAPSHOT,
  type CallNode,
  type CaseMeta,
  type InquestryApi,
  type PendingAsk,
  type Snapshot,
  type StepNode,
} from '../shared/ipc.js';
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
  const [input, setInput] = useState('');
  const [env, setEnv] = useState<{ claude: string | null; hint: string } | null>(null);
  const [excerpt, setExcerpt] = useState<{ title: string; body: string } | null>(null);
  const started = snap.sessionStatus !== 'idle';
  // ①档永远置顶：闸门到点会自己放行，回填不处理就永远等下去（ui.md §4）
  const todos = useMemo(
    () => [...snap.pending.map((p) => p.id), ...snap.gates.map((g) => g.id)],
    [snap.pending, snap.gates],
  );
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

  // 还没立案时整屏只有立案面板：这一步不做完，后面所有东西都没有基准
  if (!snap.case) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            Inquestry<span className="dot" />
          </div>
        </header>
        {env && !env.claude && (
          <div className="banner">未找到 claude 可执行文件。请先安装 Claude Code 并在终端登录一次。</div>
        )}
        <main className="stage">
          <Intake onSubmit={(d) => window.inquestry.createCase(d)} />
        </main>
      </div>
    );
  }

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
          <span className={`pill ${snap.busy ? 'busy' : snap.sessionStatus}`}>
            {snap.busy ? '进行中' : statusLabel(snap.sessionStatus)}
          </span>
          {snap.busy && <button onClick={() => void window.inquestry.interrupt()}>停止</button>}
        </div>
      </header>

      {env && !env.claude && (
        <div className="banner">未找到 claude 可执行文件。请先安装 Claude Code 并在终端登录一次。</div>
      )}

      <main className="stage">
        {snap.pending.map((p) => (
          <PendingCard
            key={p.id}
            ask={p}
            focused={focus === p.id}
            onSubmit={(r) => void window.inquestry.answerOperator(r)}
          />
        ))}
        {snap.gates.map((g) => (
          <GateCard
            key={g.id}
            gate={g}
            focused={focus === g.id}
            onDecide={(d) => void window.inquestry.decideGate(d)}
          />
        ))}

        {!started && (
          <div className="empty">
            <p>{snap.case.question}</p>
            <button className="primary" onClick={() => void window.inquestry.start()}>
              开始排查
            </button>
          </div>
        )}

        {view === 'investigation'
          ? snap.steps.map((s) => <StepCard key={s.id} step={s} onExcerpt={showExcerpt} />)
          : <IncidentTimeline snap={snap} onExcerpt={showExcerpt} />}

        {started && view === 'investigation' && <ReportStrip snap={snap} />}
      </main>

      <footer className="dock">
        <ChatStrip snap={snap} />
        <div className="composer">
          <textarea
            value={input}
            placeholder={started ? '补充线索、纠偏方向，或让它换个假设…' : '先点「开始排查」'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && input.trim()) {
                void window.inquestry.send(input.trim());
                setInput('');
              }
            }}
          />
          <button
            className="primary"
            disabled={!started || !input.trim()}
            onClick={() => {
              void window.inquestry.send(input.trim());
              setInput('');
            }}
          >
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
  return (
    <section className="report">
      <h4>报告投影</h4>
      {snap.report.rootCause && (
        <p>
          <b>根因</b>
          {snap.report.rootCause}
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
