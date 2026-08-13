import { useEffect, useRef, useState } from 'react';
import type { GateDecision, PendingGate } from '../shared/ipc.js';
import { isPlainKey, isTyping } from './keys.js';

/**
 * ②档闸门卡（ui.md §4）。
 *
 * 与①档的分别全在「不处理会怎样」：这一档到点自动放行，所以有倒计时环、用描边而不是实心标头、
 * 不抢焦点。三个手势里**拒绝必须留话**——不留话 agent 只知道被挡了，不知道该换什么。
 *
 * **接管模式下它没有倒计时**（overview §3.5）：那时人刚说了每一条自己判，
 * 到点替他放行等于把这句话作废。少了倒计时这张卡就与①档同形，所以那句"等你处置"要写出来。
 */
export function GateCard({
  gate,
  focused,
  draft,
  onDraft,
  onDecide,
}: {
  gate: PendingGate;
  focused: boolean;
  /**
   * 改过的参数与写好的拒绝理由**存在 App 那边**，不放这张卡的局部 state。
   * 一切案子这张卡就卸载，写好的理由会跟着没——而它正是拒绝这个动作的全部内容。
   */
  draft: Record<string, string>;
  onDraft: (patch: Record<string, string | undefined>) => void;
  onDecide: (d: GateDecision) => void;
}) {
  const text = draft.input ?? gate.input;
  const setText = (v: string) => onDraft({ input: v });
  /** 键不在 = 拒绝那栏还没展开。展开与留话内容是一回事，不必再多一个 boolean。 */
  const note = draft.note ?? null;
  const setNote = (v: string | null) => onDraft({ note: v ?? undefined });
  /** 接管模式下没有 deadline：那一档等到有人处置为止，界面上也就不该有倒计时。 */
  const [left, setLeft] = useState(() => (gate.deadline ? Math.max(0, gate.deadline - Date.now()) : 0));
  const box = useRef<HTMLElement>(null);
  const params = useRef<HTMLTextAreaElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);

  const changed = text.trim() !== gate.input.trim();
  const rewritten = changed ? parseObject(text) : null;
  const invalid = changed && !rewritten;

  const allow = () => {
    if (invalid) return;
    onDecide(rewritten ? { id: gate.id, action: 'rewrite', input: JSON.stringify(rewritten) } : { id: gate.id, action: 'allow' });
  };
  const deny = () => note?.trim() && onDecide({ id: gate.id, action: 'deny', message: note.trim() });

  useEffect(() => {
    const at = gate.deadline;
    if (!at) return;
    const t = setInterval(() => setLeft(Math.max(0, at - Date.now())), 500);
    return () => clearInterval(t);
  }, [gate.deadline]);

  useEffect(() => {
    if (focused) box.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainKey(e) || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'a') allow();
      else if (k === 'e') params.current?.focus();
      else if (k === 'd') {
        setNote(note ?? '');
        // 展开与聚焦不在同一帧：输入框这会儿还没挂上
        setTimeout(() => message.current?.focus(), 0);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // 有意每次渲染都重挂：`A` 要放行的是**此刻**输入框里的参数，冻住闭包就会放行旧值
  });

  const total = Math.max(1, (gate.deadline ?? gate.askedAt) - gate.askedAt);
  return (
    <section className={`gate ${focused ? 'focus' : ''}`} ref={box}>
      <div className="head">
        <span className="tag">要不要放行</span>
        <span className="tool">{gate.toolName}</span>
        {gate.agentId && <span className="agent">子 agent {gate.agentId.slice(0, 8)}</span>}
        {changed && <span className="changed">参数已改</span>}
        {/* 没有倒计时不等于"忘了说"：这一档在等人，得写出来——留白读起来像它随时会自己过去 */}
        {gate.deadline ? (
          <span className="clock">
            <Ring left={left} total={total} />
            {fmt(left)} 后自动放行
          </span>
        ) : (
          <span className="clock held">等你处置，不会自己放行</span>
        )}
      </div>

      {gate.reason && <p className="why">{gate.reason}</p>}

      <textarea
        className="stmt"
        ref={params}
        value={text}
        rows={Math.min(10, text.split('\n').length + 1)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) allow();
          // 光标在这儿时单字母键归输入框所有：Esc 把键盘交还给待办栏
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
      />
      {invalid && <p className="err">参数不是合法的 JSON 对象，改回去或修好才能放行。</p>}

      {note !== null && (
        <textarea
          className="note"
          ref={message}
          value={note}
          rows={2}
          placeholder="告诉它为什么不行、该换成什么——这句会原样进 turn，不中断当前轮"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) deny();
            // 收起留话栏顺带把键盘交还给待办栏，不然收起来了焦点还在原地
            if (e.key === 'Escape') {
              setNote(null);
              e.currentTarget.blur();
            }
          }}
        />
      )}

      <div className="acts">
        {note === null ? (
          <button className="ghost" onClick={() => { setNote(''); setTimeout(() => message.current?.focus(), 0); }}>
            拒绝并留话 <small>D</small>
          </button>
        ) : (
          <button className="ghost bad" disabled={!note.trim()} onClick={deny}>
            确认拒绝 <small>⌘↵</small>
          </button>
        )}
        <button className="primary" disabled={invalid} onClick={allow}>
          {changed ? '改写并放行' : '放行'} <small>A</small>
        </button>
      </div>
    </section>
  );
}

/** 全屏只有两处动效，这是其中之一（ui.md §5）：剩余时间是唯一在动的量。 */
function Ring({ left, total }: { left: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" width="18" height="18" viewBox="0 0 18 18">
      <circle cx="9" cy="9" r={r} />
      <circle cx="9" cy="9" r={r} className="arc" strokeDasharray={c} strokeDashoffset={c * (1 - left / total)} />
    </svg>
  );
}

function fmt(ms: number) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 改写只接受对象：`updatedInput` 给个数组或裸字符串，backend 那侧会直接把这次调用判成坏参数。 */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
