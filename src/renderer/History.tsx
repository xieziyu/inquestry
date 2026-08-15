import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import type { CaseBrief, CaseHit, CaseListQuery, CaseListRow } from '../shared/ipc.js';
import { ago, caseShape, caseState, rootLabel, TodoBadge } from './caseline.js';
import { freshenHits } from './drafts.js';

/** ≥3 字走得到索引，快到可以边打边查。 */
const SEARCH_DEBOUNCE_MS = 120;
/** <3 字是全表扫（trigram 的结构性下限）：等人停下来再查，别按键盘节奏扫库。 */
const SEARCH_DEBOUNCE_SHORT_MS = 400;
const PAGE = 30;

/** 命中出自哪儿。**别把 `ref_kind` 直接印出来**：那是索引的内部分类，不是给人读的。 */
const HIT_WHERE: Record<CaseHit['where'], string> = {
  case: '问题',
  verdict: '结论',
  direction: '方向',
  evidence: '证据',
  lane: '支线',
  chat: '对话',
};

const FILTERS: { v: NonNullable<CaseListQuery['status']>; label: string }[] = [
  { v: 'all', label: '全部' },
  { v: 'open', label: '进行中' },
  { v: 'closed', label: '已定稿' },
  { v: 'aborted', label: '已归档' },
];

/**
 * 历史调查页（ui.md §8.3）：检索、切换、导出。
 *
 * **这一页同时是切换调查的入口。** 工作区里那排 chip 已经撤掉——rail 上有常驻入口之后，
 * 切换不再是工作区内的手势。代价是切一次多一跳，换来的是每一行放得下
 * 「为什么它被搜出来」（chip 的 title 属性塞不下，而那正是要看的）。
 *
 * 检索**换掉的是这一页的列表本身**，不另开一层：找旧调查的下一步动作就是切过去，
 * 而切过去的入口就在这一行上。
 */
export function History({ cases, onOpen }: { cases: CaseBrief[]; onOpen: (caseId: string) => void }) {
  const [term, setTerm] = useState('');
  const [status, setStatus] = useState<NonNullable<CaseListQuery['status']>>('all');
  const [page, setPage] = useState<{ rows: CaseListRow[]; total: number } | null>(null);
  /**
   * 上一次查完的检索结果，**连它是哪个词查的一起记**。只存命中的话，输入框换成新词之后
   * 到下一次结果回来之间（短词那档 400ms 起）屏上还是上个词的命中，而那些行点得下去
   * ——人会照着一个跟当前输入毫无关系的列表切走。
   *
   * `hits: null` 是**查砸了**，与"查完了、零命中"是两回事：库坏了、FTS 语法不成立、
   * IPC 断了都会落到这里，一律说成"没有命中"的话，人拿到的是"历史里确实没有这次调查"这个错结论。
   */
  const [found, setFound] = useState<{ term: string; hits: CaseHit[] | null } | null>(null);
  /**
   * 只认最后一次查询的结果。打字快的时候几次 invoke 会并发在飞，
   * **回来的顺序不保证**——不认的话，一个更早、更宽的结果会盖掉刚打完那个词的结果，
   * 而屏幕上看起来只是"搜出来的东西不对"。检索与翻页各占一个序号：两条路都会写 state。
   */
  const seq = useRef(0);
  const pageSeq = useRef(0);

  const load = useCallback(
    (offset: number) => {
      const mine = ++pageSeq.current;
      void window.inquestry
        .listCases({ status, limit: PAGE, offset })
        .then((r) => {
          if (pageSeq.current !== mine) return;
          // 翻页是**追加**不是替换：翻到第三页再回头看第一页那几条正等着人的调查，
          // 换掉的话它们连同「等你 N」一起从屏幕上消失了
          setPage((prev) =>
            offset && prev ? { total: r.total, rows: [...prev.rows, ...r.rows] } : r,
          );
        })
        .catch((e: unknown) => {
          console.error('listCases failed', e);
          if (pageSeq.current === mine) setPage(null);
        });
    },
    [status],
  );

  // 换筛选就从头取。**要连同已经翻出来的那些一起丢掉**：留着的话，
  // 「已定稿」那一档下面会挂着上一档翻出来的进行中调查
  useEffect(() => {
    setPage(null);
    load(0);
  }, [load]);

  useEffect(() => {
    const t = term.trim();
    if (!t) {
      // 序号也要往前推：清空之后，还在飞的那一次回来时不能再往屏上写
      seq.current += 1;
      setFound(null);
      return;
    }
    const mine = ++seq.current;
    /**
     * 🔴 **短词要多等一会儿。** <3 字走不到 trigram 索引（那是 trigram 的结构性下限，
     * 不是我们的写法问题），一次**没有命中**的短词查询是实打实的全表扫，且随库线性增长。
     * 而它跑在 main 的同步 better-sqlite3 上——按每个键都发的话，越往后打字越顿。
     */
    const timer = setTimeout(
      () => {
        void window.inquestry
          .searchCases(t)
          .then((r) => seq.current === mine && setFound({ term: t, hits: r }))
          .catch((e: unknown) => {
            // 界面只说得出"没搜成"，原因得留在控制台里，否则这条路径两头都没有线索
            console.error('searchCases failed', e);
            if (seq.current === mine) setFound({ term: t, hits: null });
          });
      },
      t.length >= 3 ? SEARCH_DEBOUNCE_MS : SEARCH_DEBOUNCE_SHORT_MS,
    );
    return () => clearTimeout(timer);
  }, [term]);

  // 只认与当前输入同一个词的那份结果：对不上就当还在查
  const t = term.trim();
  const fresh = found?.term === t ? found : null;
  const hits = t ? (fresh?.hits ?? null) : null;
  const searching = !!t;

  /**
   * 两条路的结果都要**每帧按最新快照兑一次**运行时那一半（D28）：
   * 冻在查出来那一刻的话，人停在这一页时新冒出来的待办一条都不会显示。
   */
  const rows: CaseListRow[] = searching
    ? freshenHits(
        (hits ?? []).map((h) => toRow(h)),
        cases,
      )
    : freshenHits(page?.rows ?? [], cases);

  // 「在手上」= 运行时里还持有它的那些。分组只在不检索时给：检索结果按命中排，
  // 再按在不在手上切两段，人会以为搜漏了下半段
  const inHand = searching ? [] : rows.filter((c) => c.loaded || c.todos > 0);
  const earlier = searching ? rows : rows.filter((c) => !(c.loaded || c.todos > 0));
  const more = !searching && page && page.rows.length < page.total;

  return (
    <div className="page history">
      <header className="pagehead">
        <h1>历史调查</h1>
        <span className="sub">
          {page ? `${page.total} 次` : '…'} · 检索、切换、导出
        </span>
      </header>
      <div className="pagebody">
        <div className="pad">
          <div className="filters">
            <input
              className="q"
              value={term}
              placeholder="搜问题 / 结论 / 方向 / 证据 / 支线 / 对话"
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setTerm('')}
            />
            <div className="seg">
              {FILTERS.map((f) => (
                <button
                  key={f.v}
                  className={status === f.v ? 'on' : ''}
                  // 检索是跨全库的，与状态筛不叠加：叠加的话一次零命中说不清是
                  // "库里没有"还是"这一档里没有"
                  disabled={searching}
                  onClick={() => setStatus(f.v)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {searching && (
            <p className="note">
              {!fresh
                ? `搜「${t}」…`
                : !fresh.hits
                  ? `「${t}」没搜成，换个词再试一次`
                  : fresh.hits.length === 0
                    ? `没有命中「${t}」`
                    : `命中 ${fresh.hits.length} 次调查 · 排序与最近列表同一条规则（不按命中条数排）`}
            </p>
          )}

          {!searching && inHand.length > 0 && (
            <>
              <p className="grouplab">在手上 · 点一行就切过去，不中断任何一个</p>
              <div className="cases">
                {inHand.map((c) => (
                  <Row key={c.id} c={c} hit={null} onOpen={onOpen} />
                ))}
              </div>
            </>
          )}

          {earlier.length > 0 && (
            <>
              {!searching && inHand.length > 0 && <p className="grouplab">更早</p>}
              <div className="cases">
                {earlier.map((c) => (
                  <Row
                    key={c.id}
                    c={c}
                    hit={searching ? (hits?.find((h) => h.id === c.id) ?? null) : null}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </>
          )}

          {!searching && page?.total === 0 && <p className="blank">这一档下面还没有调查。</p>}

          {more && (
            <button className="loadmore" onClick={() => load(page.rows.length)}>
              还有 {page.total - page.rows.length} 次，接着看
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 检索命中补齐成一行。**缺的那几项一律给"不知道"而不是编一个**：
 * 命中那条路查的是 FTS，拿不到工作区与步数，填 0 的话它会显示成"一次没有步骤的调查"。
 */
function toRow(h: CaseHit): CaseListRow {
  return { ...h, projectRoot: null, incidentDate: '', verdictShape: null, steps: 0, headline: null };
}

function Row({
  c,
  hit,
  onOpen,
}: {
  c: CaseListRow;
  /** 检索命中时的「为什么找到它」。不是检索结果就是 null。 */
  hit: CaseHit | null;
  onOpen: (caseId: string) => void;
}) {
  const st = caseState(c);
  const shape = caseShape(c);
  return (
    <div className={`hitrow ${c.current ? 'cur' : ''}`} onClick={() => onOpen(c.id)}>
      <div className="l1">
        <span className={`t ${st.tone === 'done' ? 'done' : ''}`}>{c.title}</span>
        <TodoBadge n={c.todos} />
        <span className={`meta ${st.tone}`}>
          {st.label} · {ago(c.updatedAt)}
        </span>
        <div className="acts" onClick={(e) => e.stopPropagation()}>
          <button
            title="导出 Markdown"
            onClick={() => void window.inquestry.exportMarkdown(c.id)}
          >
            <Icon name="download" size={12} />
            导出
          </button>
        </div>
      </div>
      <div className="l2">
        {hit ? (
          <>
            <span className="where">
              {HIT_WHERE[hit.where]}
              {hit.hits > 1 ? ` ×${hit.hits}` : ''}
            </span>
            <span className="snip">{hit.snippet}</span>
          </>
        ) : (
          <>
            <span className="where" title={c.projectRoot ?? '这条调查没有工作区'}>
              {shape ?? rootLabel(c.projectRoot)}
            </span>
            <span className="snip">
              {c.headline ?? (c.steps ? `${c.steps} 步，还没有结论` : '还没开始查')}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
