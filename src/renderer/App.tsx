import { useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_SNAPSHOT, type PendingAsk, type Snapshot, type StepNode } from '../shared/ipc.js';
import { PendingCard } from './PendingCard.js';

declare global {
  interface Window {
    inquestry: {
      envCheck(): Promise<{ claude: string | null; hint: string }>;
      start(q: string): Promise<void>;
      send(t: string): Promise<void>;
      interrupt(): Promise<void>;
      answerOperator(r: { id: string; statement: string; answer: string; executedAt?: string }): Promise<void>;
      snapshot(): Promise<Snapshot>;
      excerpt(callId: string, anchor: string | null): Promise<string>;
      onSnapshot(cb: (s: Snapshot) => void): () => void;
    };
  }
}

const DEMO_QUESTION =
  '线上反馈：2026-08-09 12:03 前后，用户 u1001 只提交了一次订单，系统里却出现了两条重复记录。请排查根因。\n' +
  '可用数据源：query_logs（gateway / app / sentry）。数据库不可直连，需要查库时用 ask_operator。';

type View = 'investigation' | 'incident';

export function App() {
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [view, setView] = useState<View>('investigation');
  const [input, setInput] = useState('');
  const [env, setEnv] = useState<{ claude: string | null; hint: string } | null>(null);
  const [excerpt, setExcerpt] = useState<{ title: string; body: string } | null>(null);
  const started = snap.sessionStatus !== 'idle';

  useEffect(() => {
    void window.inquestry.snapshot().then(setSnap);
    void window.inquestry.envCheck().then(setEnv);
    return window.inquestry.onSnapshot((s) => s && setSnap(s));
  }, []);

  const showExcerpt = async (callId: string, anchor: string | null, title: string) => {
    setExcerpt({ title, body: await window.inquestry.excerpt(callId, anchor) });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Inquestry<span className="dot" />
          <span className="case">{snap.caseTitle ?? '尚未开始'}</span>
        </div>
        <div className="tabs">
          <button className={view === 'investigation' ? 'on' : ''} onClick={() => setView('investigation')}>
            排查时间线
          </button>
          <button className={view === 'incident' ? 'on' : ''} onClick={() => setView('incident')}>
            事故时间线 <span className="count">{snap.incident.length}</span>
          </button>
        </div>
        <div className="status">
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
          <PendingCard key={p.id} ask={p} onSubmit={(r) => void window.inquestry.answerOperator(r)} />
        ))}

        {!started && (
          <div className="empty">
            <p>演示事故：一次提交产生两条重复订单。数据源是内置的玩具日志，数据库走人工回填。</p>
            <button className="primary" onClick={() => void window.inquestry.start(DEMO_QUESTION)}>
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
              <div key={c.id} className="call" onClick={() => onExcerpt(c.id, null, c.toolName)}>
                <div className="callhead">
                  <b>#{c.callNumber}</b> {c.toolName}
                  <span className={`origin ${c.origin}`}>{c.origin === 'operator' ? '人工' : 'agent'}</span>
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

function kindLabel(k: StepNode['kind']) {
  return ({ normal: '排查', unclassified: '未归类', impact: '影响面', leftover: '遗留疑点' } as const)[k];
}

export type { PendingAsk };
