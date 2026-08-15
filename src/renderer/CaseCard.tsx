import { useEffect, useRef, useState } from 'react';
import type { CaseMeta } from '../shared/ipc.js';
import { Icon } from './Icon.js';

/**
 * 立案卡：舞台上的第一个节点。
 *
 * **建单信息不在顶栏。** 顶栏那一条是定高的整幅一格，横向就那么宽，标题、基准日期、
 * 工作区、模型挤进去之后每一项都只剩几个字，而它们的读法各不相同（标题要能改、
 * 问题描述要能读全、基准日期是个要对得上的数）。搬到舞台上之后它们有了自己的行宽，
 * 顶栏也就腾出来只说"这是哪个工作区"。
 *
 * 它同时是**每次会话开场那段话的唯一出处**：轨道不再把开场白当成一条对话织进去
 * （`track.ts` 的 `weaveChat`），因为那段话逐字就是这张卡。
 */
export function CaseCard({
  meta,
  onRename,
}: {
  meta: CaseMeta;
  /** 回执是改没改成；没改成时把编辑框留着，别把人刚敲的字吞掉。 */
  onRename: (title: string) => Promise<boolean>;
}) {
  /**
   * 编辑中的那份文本。**编辑期间不认快照**：快照 60ms 一轮，而 agent 起的标题可能正好
   * 在这几秒里落地——认快照的话，人正打着字，输入框里的内容被换掉了。
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [full, setFull] = useState(false);
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
    <section className="casecard">
      <div className="head">
        {draft === null ? (
          <>
            <h2 title={meta.title}>{meta.title}</h2>
            <button className="rename" title="改标题" onClick={() => setDraft(meta.title)}>
              <Icon name="pencil" size={12} />
              改标题
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

      {/* 问题描述是人自己写的那段，可能很长。默认收成几行，展开只在这一张卡里发生 */}
      <p className={`question ${full ? 'full' : ''}`} onClick={() => setFull(!full)} title="点一下展开 / 收起">
        {meta.question}
      </p>

      {/* 工作区不在这儿：顶栏那一条就是它，同一屏上写两遍只会让人怀疑是两个东西 */}
      <div className="meta">
        {/* 基准日期要一直看得见：agent 补齐无日期时间串用的就是它，
            对不上的表现是整条系统时间线平移几天，而那时报告已经导出去了 */}
        <span>
          基准日期 <code>{meta.incidentDate}</code> <code>{meta.tzOffset}</code>
        </span>
      </div>
    </section>
  );
}
