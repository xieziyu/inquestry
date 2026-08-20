import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import type { GateDecision, PendingGate } from '../shared/ipc.js';

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
  grab,
  draft,
  onDraft,
  onDecide,
}: {
  gate: PendingGate;
  focused: boolean;
  /** 待办栏这会儿该不该拿着键盘（`App` 的 `handKeyboard`）。 */
  grab: () => boolean;
  /**
   * 改过的参数与写好的拒绝理由**存在 App 那边**，不放这张卡的局部 state。
   * 一换调查这张卡就卸载，写好的理由会跟着没——而它正是拒绝这个动作的全部内容。
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

  /**
   * 聚焦的是卡本身（`tabIndex={-1}`），不是里面某个输入框——为的是接着能直接 ⌘↵ 放行。
   *
   * 🔴 **`focused` 不等于该抢焦点**，两道闸各挡一种情形：
   *   - `grab()`：`focused` 也会由 App 的顺位 effect 自动落上来（待办从无到有时指向第一条），
   *     那一下人可能正在底部输入框打字：跟着它聚焦的话光标被夺走，
   *     而他接着按的 ⌘↵ 会把这道闸门放行掉；
   *   - 卡里已经有焦点：`focused` 正是跟着焦点走的，点进参数框也会让它成为 focused，
   *     不挡的话光标会被从参数框拽到卡本身上。
   */
  useEffect(() => {
    if (!focused) return;
    box.current?.scrollIntoView({ block: 'nearest' });
    if (grab() && !box.current?.contains(document.activeElement)) box.current?.focus({ preventScroll: true });
  }, [focused, grab]);

  /**
   * ⌘↵ 归这张卡自己，**不挂 window 监听**：焦点在卡内哪儿都算数，在卡外就按不到——
   * 多张待办同时挂着时不必再对账"这一下是谁的"。闭包每次渲染都是新的，
   * 也就没有了「放行的是上一次渲染时的参数」那个坑。
   *
   * 🔴 **按落点属于哪个动作分派，不能写成「不是留话栏就当放行」。** 拒绝区不止那一个
   * textarea——「确认拒绝」钮上也印着 ⌘↵，从理由栏 Tab 过去再按，那一下会**反过来放行**
   * 这次调用，而它多半正是一条要动生产的写操作。拒绝区整块标 `data-deny`。
   */
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if ((e.target as HTMLElement | null)?.closest?.('[data-deny]')) deny();
    else allow();
  };

  const total = Math.max(1, (gate.deadline ?? gate.askedAt) - gate.askedAt);
  return (
    <section className={`gate ${focused ? 'focus' : ''}`} ref={box} tabIndex={-1} data-todo={gate.id} onKeyDown={onKey}>
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
      />
      {invalid && <p className="err">参数不是合法的 JSON 对象，改回去或修好才能放行。</p>}

      {note !== null && (
        <textarea
          className="note"
          data-deny
          ref={message}
          value={note}
          rows={2}
          placeholder="告诉它为什么不行、该换成什么——这句会原样进 turn，不中断当前轮"
          onChange={(e) => setNote(e.target.value)}
        />
      )}

      <div className="acts">
        {note === null ? (
          <button className="ghost" onClick={() => { setNote(''); setTimeout(() => message.current?.focus(), 0); }}>
            <Icon name="deny" />
            拒绝并留话
          </button>
        ) : (
          <button className="ghost bad" data-deny disabled={!note.trim()} onClick={deny}>
            <Icon name="deny" />
            确认拒绝 <small>⌘↵</small>
          </button>
        )}
        <button className="primary" disabled={invalid} onClick={allow}>
          <Icon name={changed ? 'pencil' : 'check'} />
          {changed ? '改写并放行' : '放行'} <small>⌘↵</small>
        </button>
      </div>
    </section>
  );
}

/** 会自己动的东西只活在正在跑的那一轮（ui.md §5，见 `styles.css` 的 `.state.open .pulse`）：
    这枚环里唯一在动的量是剩余时间，闸门一处置它就整个消失。 */
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
