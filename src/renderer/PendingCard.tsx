import { useEffect, useRef } from 'react';
import { Icon } from './Icon.js';
import type { OperatorReply, PendingAsk } from '../shared/ipc.js';
import { isPlainKey, isTyping } from './keys.js';

/**
 * 人工回填节点。三个设计要点都落在这张卡上（overview §5.1）：
 *   ① 语句可编辑再执行，改后的语句要回传给 agent —— 它才能学到真实 schema
 *   ② 执行时间必须能填：手工结果是唯一拿不到自动时间戳的来源
 *   ③ expect 先于结果呈现，挡住「看到数据再倒推解释」
 *
 * 第四个手势是**拒绝**：人自己也没那个权限、或这条不该在生产上跑的时候，这张卡得有出口。
 * 没有它的话唯一的走法是干等到超时——十分钟里 agent 一动不动，而人早就知道这条跑不成了。
 * 理由选填，见 `OperatorReply` 那儿写的为什么。
 */
export function PendingCard({
  ask,
  focused,
  draft,
  onDraft,
  onSubmit,
}: {
  ask: PendingAsk;
  focused: boolean;
  /**
   * 人已经敲进去的东西**存在 App 那边**，不放这张卡的局部 state。
   * 卡片是跟着快照渲染的，一换调查它就卸载——粘了半天的查询结果会随之蒸发。
   */
  draft: Record<string, string>;
  onDraft: (patch: Record<string, string | undefined>) => void;
  onSubmit: (r: OperatorReply) => void;
}) {
  const statement = draft.statement ?? ask.statement;
  const answer = draft.answer ?? '';
  const executedAt = draft.executedAt ?? '';
  /**
   * 键不在 = 拒绝那栏还没展开。**这里不能像别处那样用「内容非空」代替展开状态**：
   * 理由本来就允许留空，那样写会让人一按「无法执行」栏就自己收回去。
   */
  const note = draft.note ?? null;
  const setStatement = (v: string) => onDraft({ statement: v });
  const setAnswer = (v: string) => onDraft({ answer: v });
  const setExecutedAt = (v: string) => onDraft({ executedAt: v });
  const setNote = (v: string | null) => onDraft({ note: v ?? undefined });
  const changed = statement !== ask.statement;
  const box = useRef<HTMLElement>(null);
  const result = useRef<HTMLTextAreaElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);

  const submit = () =>
    answer.trim() &&
    onSubmit({ id: ask.id, action: 'answer', statement, answer, executedAt: executedAt || undefined });
  const decline = () => onSubmit({ id: ask.id, action: 'decline', reason: note?.trim() || undefined });
  const openNote = () => {
    setNote(note ?? '');
    // 展开与聚焦不在同一帧：输入框这会儿还没挂上
    setTimeout(() => message.current?.focus(), 0);
  };

  // J/K 移到这张卡时直接把光标放进结果框：切窗口跑完 SQL 回来就是要粘贴
  useEffect(() => {
    if (!focused) return;
    box.current?.scrollIntoView({ block: 'nearest' });
    result.current?.focus();
  }, [focused]);

  // 光标一进结果框单字母键就归它了，所以 `D` 只在人按过 Esc 交还键盘之后才轮得到——
  // 与②档同一个键位，为的是两张卡在键盘上是同一套动作
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainKey(e) || isTyping(e.target) || e.key.toLowerCase() !== 'd') return;
      e.preventDefault();
      openNote();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <section className={`pending ${focused ? 'focus' : ''}`} ref={box}>
      <div className="head">
        <span className="tag">需要你执行</span>
        <span className="engine">{ask.engine}</span>
        {ask.env && <span className="env">{ask.env}</span>}
        {changed && <span className="changed">语句已改，会连同结果一起回传</span>}
      </div>

      <p className="why">
        <b>为什么</b>
        {ask.why}
      </p>
      <p className="expect">
        <b>预期看到</b>
        {ask.expect}
      </p>

      <textarea className="stmt" value={statement} onChange={(e) => setStatement(e.target.value)} rows={4} />

      <div className="fill">
        <textarea
          ref={result}
          placeholder="把执行结果粘贴到这里"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            // 结果框要能粘多行，`↵` 得留给换行，提交只认 ⌘↵（与底部输入带一致）
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            // 光标在这儿时单字母键归输入框所有，J/K 与 A/E/D 都失效——Esc 是交还键盘的那一下
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
          rows={5}
        />
        <div className="side">
          <label>
            执行时间
            <input
              placeholder="2026-08-09 12:41:07 +08:00"
              value={executedAt}
              onChange={(e) => setExecutedAt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </label>
          <button className="primary" disabled={!answer.trim()} onClick={submit}>
            <Icon name="send" />
            回填 <small>⌘↵</small>
          </button>
        </div>
      </div>

      {note !== null && (
        <textarea
          className="note"
          ref={message}
          value={note}
          rows={2}
          placeholder="为什么跑不了——可以不写。写了会原样给它，好让它知道换哪个方向"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) decline();
            // 收起留话栏顺带把键盘交还给待办栏，不然收起来了焦点还在原地
            if (e.key === 'Escape') {
              setNote(null);
              e.currentTarget.blur();
            }
          }}
        />
      )}

      {/* 拒绝分两下：理由可以为空，一下就走的话一次误点就把这条查询判了死刑，
          而它与放弃不同——agent 收到的是"别再问了"，不会再自己回来试 */}
      <div className="acts">
        {note === null ? (
          <button className="ghost" onClick={openNote}>
            <Icon name="deny" />
            这条我跑不了 <small>D</small>
          </button>
        ) : (
          <button className="ghost bad" onClick={decline}>
            <Icon name="deny" />
            确认拒绝{note.trim() ? '' : '（不留理由）'} <small>⌘↵</small>
          </button>
        )}
      </div>
    </section>
  );
}
