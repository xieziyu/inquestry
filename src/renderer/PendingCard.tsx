import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import type { OperatorReply, PendingAsk } from '../shared/ipc.js';

/**
 * 人工回填节点。两个设计要点落在这张卡上：
 *   ① `expect` 先于结果呈现，挡住「看到数据再倒推解释」
 *   ② 语句只读，主路是**复制走人**——要改在自己的客户端里改，这张卡不当编辑器。
 *      代价是改法不回传，agent 学不到真实 schema；那一档由人在结果框里写一句补上
 *      （结果是原样喂回去的）。
 *
 * 第三个手势是**拒绝**：人自己也没那个权限、或这条不该在生产上跑的时候，这张卡得有出口。
 * 没有它的话唯一的走法是干等到超时——十分钟里 agent 一动不动，而人早就知道这条跑不成了。
 * 理由选填，见 `OperatorReply` 那儿写的为什么。
 *
 * 时间不在卡上：agent 拿到的是 `case-runner` 收到答案时自己盖的**回填时刻**，
 * renderer 报上来的时间戳 main 没法验。
 */
export function PendingCard({
  ask,
  focused,
  grab,
  draft,
  onDraft,
  onSubmit,
}: {
  ask: PendingAsk;
  focused: boolean;
  /** 待办栏这会儿该不该拿着键盘（`App` 的 `handKeyboard`）。 */
  grab: () => boolean;
  /**
   * 人已经敲进去的东西**存在 App 那边**，不放这张卡的局部 state。
   * 卡片是跟着快照渲染的，一换调查它就卸载——粘了半天的查询结果会随之蒸发。
   */
  draft: Record<string, string>;
  onDraft: (patch: Record<string, string | undefined>) => void;
  onSubmit: (r: OperatorReply) => void;
}) {
  const answer = draft.answer ?? '';
  /**
   * 键不在 = 还在回填态，键在 = 进了拒绝态（两个模式互斥）。
   * **这里不能像别处那样用「内容非空」代替模式位**：理由本来就允许留空，
   * 那样写会让人一按「拒绝」就自己弹回回填态。
   */
  const note = draft.note ?? null;
  const setAnswer = (v: string) => onDraft({ answer: v });
  const setNote = (v: string | null) => onDraft({ note: v ?? undefined });
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const box = useRef<HTMLElement>(null);
  const result = useRef<HTMLTextAreaElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);

  const submit = () => answer.trim() && onSubmit({ id: ask.id, action: 'answer', answer });
  const decline = () => onSubmit({ id: ask.id, action: 'decline', reason: note?.trim() || undefined });
  const openNote = () => {
    setNote(note ?? '');
    // 切模式与聚焦不在同一帧：输入框这会儿还没挂上
    setTimeout(() => message.current?.focus(), 0);
  };
  // 只退出拒绝态，`draft.answer` 一个字都不动：取消回来人还得看见自己粘的结果
  const cancelNote = () => {
    setNote(null);
    setTimeout(() => result.current?.focus(), 0);
  };
  const copy = () =>
    void navigator.clipboard.writeText(ask.statement).then(
      () => setCopied('ok'),
      () => setCopied('fail'),
    );

  // 复制成功那一下退回原样，失败的留着——那句话人得看见
  useEffect(() => {
    if (copied !== 'ok') return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  /**
   * 键盘走到这张卡时直接把光标放进这一模式下唯一的输入框：切窗口跑完 SQL 回来就是要粘贴，
   * 已经在拒绝态的卡则是要写理由。
   *
   * 🔴 **`focused` 不等于该抢焦点**，两道闸各挡一种情形：
   *   - `grab()`：待办从无到有时 App 的顺位 effect 会把 `focused` 落到第一条，那一刻人多半
   *     正在底部输入框打字——只看 `focused` 的话，他接着敲的字会进到查询结果框里；
   *   - 卡里已经有焦点：`focused` 正是跟着焦点走的，点一下「复制」也会让这张卡成为 focused，
   *     不挡的话光标会被从按钮上拽进结果框。
   */
  useEffect(() => {
    if (!focused) return;
    box.current?.scrollIntoView({ block: 'nearest' });
    if (grab() && !box.current?.contains(document.activeElement)) (result.current ?? message.current)?.focus();
  }, [focused, grab]);

  /**
   * ⌘↵ 归这张卡自己，**不挂 window 监听**：焦点落在卡内哪个控件上都算数，落在卡外就按不到——
   * 多张待办同时挂着时，"哪一张收到这一下"因此不必再去对账。
   *
   * 🔴 **按当前模式分派，不能按焦点落在哪个控件上。** 两个模式互斥之后，落点那套错得没声音：
   * 拒绝态下回填控件根本不在屏上，一旦判成回填，人明明要作废的结果被隐形交上去了；
   * 反过来同理（②档同一处写错的话是放行一次生产调用）。
   */
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (note !== null) decline();
    else submit();
  };

  return (
    <section className={`pending ${focused ? 'focus' : ''}`} ref={box} data-todo={ask.id} onKeyDown={onKey}>
      <div className="head">
        <span className="tag">需要你执行</span>
        <span className="engine">{ask.engine}</span>
        {ask.env && <span className="env">{ask.env}</span>}
      </div>

      <dl className="brief">
        <dt>为什么</dt>
        <dd>{ask.why}</dd>
        <dt>预期看到</dt>
        <dd>{ask.expect}</dd>
      </dl>

      {/* 语句是拿去别处跑的，不是在这儿编辑的：只读 + 一键复制。
          封了高度而不是让它长下去——超长语句会把结果框和回填钮顶出屏幕，
          而那两个才是这张卡要人做的事 */}
      <div className="stmt">
        <div className="bar">
          <span className="what">语句</span>
          <button className={copied === 'ok' ? 'done' : ''} onClick={copy}>
            <Icon name={copied === 'ok' ? 'check' : copied === 'fail' ? 'deny' : 'copy'} size={13} />
            {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败，手动选中吧' : '复制'}
          </button>
        </div>
        <pre>{ask.statement}</pre>
      </div>

      {/* 拒绝分两下：理由可以为空，一下就走的话一次误点就把这条查询判了死刑，
          而它与放弃不同——agent 收到的是"别再问了"，不会再自己回来试。
          第二下的保险靠的是**独占**：拒绝态里回填的输入框与按钮整个撤走，人不会以为自己
          还在回填的路上（也就不再需要靠"第一下是灰的"来提示还没判死刑）。
          出口在左、主路在右：右下角是全 app 的主操作位，回填态的主路是回填、拒绝态的是
          确认拒绝，出口（拒绝／取消）都不该坐在那儿 */}
      {note === null ? (
        <>
          <textarea
            className="answer"
            ref={result}
            placeholder="把执行结果粘贴到这里"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={5}
          />
          <div className="acts">
            <button className="out deny" onClick={openNote}>
              <Icon name="deny" size={13} />
              拒绝
            </button>
            <button className="go" disabled={!answer.trim()} onClick={submit}>
              <Icon name="send" size={13} />
              回填 <small>⌘↵</small>
            </button>
          </div>
        </>
      ) : (
        <>
          <textarea
            className="note"
            ref={message}
            value={note}
            rows={2}
            placeholder="为什么跑不了——可以不写。写了会原样给它，好让它知道换哪个方向"
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="acts">
            <button className="out" onClick={cancelNote}>
              取消
            </button>
            <button className="go bad" onClick={decline}>
              <Icon name="deny" size={13} />
              确认拒绝{note.trim() ? '' : '（不留理由）'} <small>⌘↵</small>
            </button>
          </div>
        </>
      )}
    </section>
  );
}
