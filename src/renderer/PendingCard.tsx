import { useEffect, useRef, useState } from 'react';
import type { OperatorReply, PendingAsk } from '../shared/ipc.js';

/**
 * 人工回填节点。三个设计要点都落在这张卡上（overview §5.1）：
 *   ① 语句可编辑再执行，改后的语句要回传给 agent —— 它才能学到真实 schema
 *   ② 执行时间必须能填：手工结果是唯一拿不到自动时间戳的来源
 *   ③ expect 先于结果呈现，挡住「看到数据再倒推解释」
 */
export function PendingCard({
  ask,
  focused,
  onSubmit,
}: {
  ask: PendingAsk;
  focused: boolean;
  onSubmit: (r: OperatorReply) => void;
}) {
  const [statement, setStatement] = useState(ask.statement);
  const [answer, setAnswer] = useState(ask.suggestedAnswer ?? '');
  const [executedAt, setExecutedAt] = useState('');
  const changed = statement !== ask.statement;
  const box = useRef<HTMLElement>(null);
  const result = useRef<HTMLTextAreaElement>(null);

  const submit = () =>
    answer.trim() && onSubmit({ id: ask.id, statement, answer, executedAt: executedAt || undefined });

  // J/K 移到这张卡时直接把光标放进结果框：切窗口跑完 SQL 回来就是要粘贴
  useEffect(() => {
    if (!focused) return;
    box.current?.scrollIntoView({ block: 'nearest' });
    result.current?.focus();
  }, [focused]);

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
            回填 <small>⌘↵</small>
          </button>
        </div>
      </div>
    </section>
  );
}
