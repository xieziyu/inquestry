import { useEffect, useRef, useState } from 'react';
import type { CallNode, CaseMeta } from '../shared/ipc.js';
import type { StageBox } from './track.js';
import { Elapsed } from './Elapsed.js';
import { Icon } from './Icon.js';

/**
 * 信息卡：舞台上的第一个节点，也是主干那一列的开头。
 *
 * **建单信息不在顶栏。** 顶栏那一条是定高的整幅一格，横向就那么宽，标题、基准日期、
 * 工作区、模型挤进去之后每一项都只剩几个字，而它们的读法各不相同（标题要能改、
 * 问题描述要能读全、基准日期是个要对得上的数）。搬到舞台上之后它们有了自己的行宽。
 *
 * 它同时是**每次会话开场那段话的唯一出处**：轨道不再把开场白当成一条对话织进去
 * （`track.ts` 的 `weaveChat`），因为那段话逐字就是这张卡。
 *
 * 它也是**那几次不属于任何方向的调用**的落点（`shared/report.ts` 的 `unassignedCalls`）：
 * 没有开着的步时发生的调用由 harness 记在一个兜底节点上，那个节点永远没有命题、没有结论，
 * 占一张与"一个排查方向"同等规格的卡就是纯噪声——但调用本身要留得住、找得到，
 * 而"这次调查开场先摸了什么底、收尾又跑了些什么杂务"回答的正是这张卡问的那件事。
 *
 * 🔴 **卡上的东西一律不许改变高度。** 舞台是画布，位置是算出来的（`stage.ts`），
 * 高度一变就等于把它下面每一张卡都推走一截。所以问题描述在这儿只按估好的行数收着，
 * 要读全文点开详情浮层——改标题那一档不改高度，所以它照旧在卡上。
 * 那条带子同理**恒占一行**（`STRAY_H`）：调用数来一次涨一个，按"有没有"决定出不出的话，
 * 第一次兜底调用落地的那一刻整条主干往下掉一截。
 */
export function CaseCard({
  box,
  meta,
  stray,
  thinking,
  onRename,
  onOpen,
}: {
  box: Extract<StageBox, { kind: 'case' }>;
  meta: CaseMeta;
  /** 不属于任何方向的那几次调用。带子上的数与抽屉里的清单是同一份。 */
  stray: CallNode[];
  /**
   * 「agent 在想」这会儿在不在这张卡上，以及秒表从哪一刻起算；null = 不出这条底带。
   *
   * 正常步全关之后主干上唯一开着的就是那个不出卡的兜底步，落点因此在这儿（`thinkingStep`）。
   * `since` 为 null = 出带子但不写秒数：**这一轮真的还什么都没发生**（`sessionLastTouch`），
   * 而这张卡跨会话一直在，随手拿上一次会话的活动当起点的话，新一轮一开屏秒表就是几小时。
   */
  thinking: { since: number | null } | null;
  /** 回执是改没改成；没改成时把编辑框留着，别把人刚敲的字吞掉。 */
  onRename: (title: string) => Promise<boolean>;
  onOpen: () => void;
}) {
  /**
   * 编辑中的那份文本。**编辑期间不认快照**：快照 60ms 一轮，而 agent 起的标题可能正好
   * 在这几秒里落地——认快照的话，人正打着字，输入框里的内容被换掉了。
   */
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft !== null) input.current?.select();
  }, [draft !== null]);

  // 换了调查就退出编辑：卡片是跟着快照渲染的，留着的话新调查的标题上会顶着上一个的草稿
  useEffect(() => setDraft(null), [meta.id]);

  const save = async () => {
    const next = draft?.trim();
    if (!next || next === meta.title) return setDraft(null);
    if (await onRename(next)) setDraft(null);
  };

  return (
    <section
      className="s-card casecard"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onClick={(e) => {
        if (draft === null && !(e.target as HTMLElement).closest('button,input')) onOpen();
      }}
    >
      <div className="head">
        {draft === null ? (
          <>
            <h2 title={meta.title} style={{ WebkitLineClamp: box.titleLines } as React.CSSProperties}>
              {meta.title}
            </h2>
            <button className="rename" title="改标题" onClick={() => setDraft(meta.title)}>
              <Icon name="pencil" size={12} />
            </button>
          </>
        ) : (
          <input
            ref={input}
            className="titleedit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              // Esc 是"我不改了"，所以丢草稿而不是保存——两个键在这儿的语义必须相反
              if (e.key === 'Escape') setDraft(null);
            }}
            onBlur={() => void save()}
          />
        )}
      </div>

      <p className="question" style={{ WebkitLineClamp: box.questionLines } as React.CSSProperties}>
        {meta.question}
      </p>

      {/* 这条带子是那几次调用唯一的入口（点卡片开详情抽屉，清单在里面）。
          **空着也占这一行**，理由见上面那段红字；空的时候不写「0 次」——
          那是一句没有信息量的话，而这张卡上每一行都得是要读的东西 */}
      <div className="stray">
        {stray.length > 0 && (
          <>
            另有 {stray.length} 次调用不属于任何方向
            <span className="go">看调用 →</span>
          </>
        )}
      </div>

      {/* 工作区不在这儿：顶栏那一条就是它，同一屏上写两遍只会让人怀疑是两个东西 */}
      <div className="meta">
        {/* 基准日期要一直看得见：agent 补齐无日期时间串用的就是它，
            对不上的表现是整条系统时间线平移几天，而那时报告已经导出去了 */}
        <span>
          基准日期 <code>{meta.incidentDate}</code> <code>{meta.tzOffset}</code>
          {/* 还没确认过的那一档要标出来。**这是这张卡上唯一会错而不报错的东西**：
              建单那一刻只能按本机当天猜，猜错了整条系统时间线静默挪一天。
              agent 读完问题会确认或改掉它，这个记号也就消失了 */}
          {meta.incidentDateSource === 'intake' && (
            <em className="unconfirmed" title="建单当天，agent 还没从问题描述里确认过">
              未确认
            </em>
          )}
        </span>
      </div>

      {/* 🔴 绝对定位在卡底那 20px 保留带里，一个像素都不许改变卡高（同 step 卡的 `.cardstrip`）。
          这儿只报「在想」这一档：卡上没有调用与证据的计数，把那两个数搬过来是另一张卡的读法 */}
      {thinking && (
        <div className="cardstrip">
          <i className="dot" />
          <span className="what">agent 在想</span>
          {thinking.since !== null && (
            <span className="el">
              <Elapsed from={thinking.since} />
            </span>
          )}
        </div>
      )}
    </section>
  );
}
