import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import type {
  CaseBrief,
  CaseHit,
  CaseListQuery,
  CaseListRow,
  DeleteOutcome,
} from '../shared/ipc.js';
import { ago, caseNode, caseShape, caseSnip, caseState, caseTerminal, rootLabel, TodoBadge } from './caseline.js';
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

/** 空态那句要跟着筛选变：四档说同一句「还没有调查」的话，人会以为库是空的。 */
const BLANK_COPY: Record<NonNullable<CaseListQuery['status']>, string> = {
  all: '还没有任何调查。回首页起一次新的。',
  open: '没有进行中的调查。',
  closed: '还没有定稿的调查。',
  aborted: '还没有归档的调查。',
};

/**
 * 历史调查页（ui.md §8.3）：检索、切换、看报告、删除。
 *
 * **这一页同时是切换调查的入口。** 工作区里那排 chip 已经撤掉——rail 上有常驻入口之后，
 * 切换不再是工作区内的手势。代价是切一次多一跳，换来的是每一行放得下
 * 「为什么它被搜出来」（chip 的 title 属性塞不下，而那正是要看的）。
 *
 * 检索**换掉的是这一页的列表本身**，不另开一层：找旧调查的下一步动作就是切过去，
 * 而切过去的入口就在这一行上。
 */
export function History({
  cases,
  onOpen,
  onReport,
}: {
  cases: CaseBrief[];
  onOpen: (caseId: string) => void;
  /** 切过去并直接翻到报告屏。列表上想看的多半是结论，不是再点一遍工作区。 */
  onReport: (caseId: string) => void;
}) {
  const [term, setTerm] = useState('');
  const [status, setStatus] = useState<NonNullable<CaseListQuery['status']>>('all');
  /**
   * `null` 是**还在读**，不是"读出来是空的"。取不到时另有 `listErr` 说话——
   * 两者合成一个的话，一次失败的读取在屏幕上就是一片永远停在载入中的空白。
   */
  const [page, setPage] = useState<{ rows: CaseListRow[]; total: number } | null>(null);
  const [listErr, setListErr] = useState(false);
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
   * 删除确认挂在哪一行，**连标题一起记**。
   *
   * 记标题是因为确认那句话要指名删的是哪一次调查：只记 id 的话，那句话只能写成
   * 「删掉这次调查」——而它悬在一屏五六行长得差不多的调查上面，指的是哪一行全靠位置。
   */
  const [wipe, setWipe] = useState<{ id: string; title: string } | null>(null);
  /** 删完没走成要说出来。挂在这一层而不是行上：那一行这时可能已经不在了。 */
  const [wipeErr, setWipeErr] = useState<string | null>(null);
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
          setListErr(false);
          // 翻页是**追加**不是替换：翻到第三页再回头看第一页那几条正等着人的调查，
          // 换掉的话它们连同「等你 N」一起从屏幕上消失了
          setPage((prev) =>
            offset && prev ? { total: r.total, rows: [...prev.rows, ...r.rows] } : r,
          );
        })
        .catch((e: unknown) => {
          console.error('listCases failed', e);
          if (pageSeq.current !== mine) return;
          setListErr(true);
          setPage(null);
        });
    },
    [status],
  );

  // 换筛选就从头取。**要连同已经翻出来的那些一起丢掉**：留着的话，
  // 「已定稿」那一档下面会挂着上一档翻出来的进行中调查
  useEffect(() => {
    setPage(null);
    setListErr(false);
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

  // 上面那一段 = 运行时里还持有它的那些（或挂着待办的），**不是库里 status='open'**
  // ——那是筛选栏那枚「进行中」筛的东西，两者同名不同义（见分组标题那处注释）。
  // 分组只在不检索时给：检索结果按命中排，再切两段的话人会以为搜漏了下半段
  const inHand = searching ? [] : rows.filter((c) => c.loaded || c.todos > 0);
  const earlier = searching ? rows : rows.filter((c) => !(c.loaded || c.todos > 0));
  const more = !searching && page && page.rows.length < page.total;

  /**
   * 删掉一行。**删完当场把它从这一页摘掉**，不等下一轮快照：快照里那份 `cases`
   * 只有最近 20 条 + 钉住的，一个翻了三页才翻出来的旧调查不在里面，
   * 光靠 `freshenHits` 兑不掉它——屏幕上那一行会一直留着，点下去是一次空切换。
   */
  const remove = async (id: string) => {
    setWipe(null);
    setWipeErr(null);
    const r = await window.inquestry
      .deleteCase(id)
      .catch((): DeleteOutcome => ({ ok: false, pendingBlobs: 0 }));
    if (!r.ok) {
      setWipeErr('没删掉。它可能已经被删过了，也可能库这会儿写不进去——原因在应用日志里。');
      return;
    }
    // 库删干净了但有原文这次没能从磁盘删掉，仍旧要说出来：这一下的承诺是"原文一并销毁"，
    // 而那几份此刻还在。**同时要说它会自己再试**，否则人只会以为它就留在那儿了
    if (r.pendingBlobs > 0) {
      setWipeErr(
        `已从库里删掉，但有 ${r.pendingBlobs} 份证据原文这次没能从磁盘上删掉（多半是被占用）。已经记下来了，下次启动会接着删。`,
      );
    }
    setPage((prev) =>
      prev ? { total: Math.max(0, prev.total - 1), rows: prev.rows.filter((c) => c.id !== id) } : prev,
    );
    // 检索结果那一路同理：命中列表是查出来的一份快照，删掉的那条不会自己消失
    setFound((prev) => (prev?.hits ? { ...prev, hits: prev.hits.filter((h) => h.id !== id) } : prev));
  };

  const row = (c: CaseListRow, hit: CaseHit | null) => (
    <Row
      key={c.id}
      c={c}
      hit={hit}
      wiping={wipe?.id === c.id}
      onOpen={onOpen}
      onReport={onReport}
      onAskWipe={() => {
        setWipeErr(null);
        setWipe({ id: c.id, title: c.title });
      }}
      onCancelWipe={() => setWipe(null)}
      onWipe={() => void remove(c.id)}
    />
  );

  return (
    <div className="page history">
      <header className="pagehead">
        <h1>历史调查</h1>
        <span className="sub">{page ? `共 ${page.total} 次` : ''}</span>
      </header>
      <div className="pagebody">
        <div className="pad">
          <div className="filters">
            <div className="qbox">
              <Icon name="search" size={13} />
              <input
                className="q"
                value={term}
                placeholder="搜索..."
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setTerm('')}
              />
              {/* 清空得有个看得见的手势：Esc 只有知道的人才按得到，而这一页多数时候是用鼠标翻的 */}
              {term && (
                <button className="clear" title="清空搜索（Esc）" onClick={() => setTerm('')}>
                  <Icon name="deny" size={11} />
                </button>
              )}
            </div>
            <div className="seg">
              {FILTERS.map((f) => (
                <button
                  key={f.v}
                  className={status === f.v ? 'on' : ''}
                  // 检索是跨全库的，与状态筛不叠加：叠加的话一次零命中说不清是
                  // "库里没有"还是"这一档里没有"
                  disabled={searching}
                  title={searching ? '检索是跨全库的，不与状态筛叠加' : undefined}
                  onClick={() => setStatus(f.v)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {wipeErr && <p className="note bad">{wipeErr}</p>}

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
              {/*
                ⚠️ 这个词与筛选栏那枚「进行中」**同名不同义**：那一枚筛的是库里 status='open'，
                这一段分的是"运行时还持有它 / 挂着待办"。所以一个刚看过的已定稿调查会落进这一段，
                而它自己那一行写着「已定稿」。改这个词之前先看一眼那枚筛选。
              */}
              <p className="grouplab">进行中</p>
              <div className="cases">{inHand.map((c) => row(c, null))}</div>
            </>
          )}

          {earlier.length > 0 && (
            <>
              {!searching && inHand.length > 0 && <p className="grouplab">更早</p>}
              <div className="cases">
                {earlier.map((c) => row(c, searching ? (hits?.find((h) => h.id === c.id) ?? null) : null))}
              </div>
            </>
          )}

          {/* 读不出来与读出来是空的要分开说：合成一句的话，一次坏掉的读取看起来像"库里确实没有" */}
          {!searching && listErr && (
            <p className="blank bad">
              这一页没读出来。原因在应用日志里。
              <button className="retry" onClick={() => load(0)}>
                <Icon name="undo" size={12} />
                重试
              </button>
            </p>
          )}
          {!searching && !listErr && !page && <p className="blank">载入中…</p>}
          {!searching && page?.total === 0 && <p className="blank">{BLANK_COPY[status]}</p>}

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
  wiping,
  onOpen,
  onReport,
  onAskWipe,
  onCancelWipe,
  onWipe,
}: {
  c: CaseListRow;
  /** 检索命中时的「为什么找到它」。不是检索结果就是 null。 */
  hit: CaseHit | null;
  /** 这一行正挂着删除确认。挂着时整行不再接切换——那一下按下去人是想读确认，不是想切走。 */
  wiping: boolean;
  onOpen: (caseId: string) => void;
  onReport: (caseId: string) => void;
  onAskWipe: () => void;
  onCancelWipe: () => void;
  onWipe: () => void;
}) {
  const st = caseState(c);
  const shape = caseShape(c);
  // 一个 `caseNode` 同时决定节点长什么样与这一行的边线/竖条走哪个色：
  // 各算各的话，一条挂着待办的调查完全可能节点是暖的而边线还是中性的
  const node = caseNode(c);
  return (
    <div className={`hitrow ${node} ${c.current ? 'cur' : ''} ${wiping ? 'wiping' : ''}`}>
      {/*
        整行是一颗按钮而不是带 onClick 的 div：**键盘要够得到**。这一页是切换调查的唯一入口，
        div 那种写法在 Tab 序列里压根不存在，于是不用鼠标就换不了调查。
        动作按钮因此不能嵌在里面（button 不能套 button），它们与它并排、由网格摆位。
      */}
      <button
        className="pick"
        disabled={wiping}
        title={c.current ? '这就是当前打开的调查' : '切过去；正在跑的那些一个都不会中断'}
        onClick={() => onOpen(c.id)}
      >
        {/* 与首页轨道同一颗（`caseNode`）：五档各有形状与颜色，扫一眼就分得出谁还活着 */}
        <span className={`nd ${node}`} />
        <span className="l1">
          <span className={`t ${caseTerminal(c.status) ?? ''}`}>{c.title}</span>
          {c.current && <span className="badge cur">当前</span>}
          <TodoBadge n={c.todos} />
        </span>
        <span className="l2">
          {hit ? (
            <>
              <span className="where">
                {HIT_WHERE[hit.where]}
                {hit.hits > 1 ? ` ×${hit.hits}` : ''}
              </span>
              <span className="dot">·</span>
              <span className="snip">{hit.snippet}</span>
            </>
          ) : (
            <>
              <span className="where" title={c.projectRoot ?? '这条调查没有工作区'}>
                {shape ?? rootLabel(c.projectRoot)}
              </span>
              <span className="dot">·</span>
              <span className="snip">
                {caseSnip(c)}
              </span>
            </>
          )}
        </span>
      </button>

      {/* 状态与时间各占一格竖着叠、一起右对齐，行与行之间因此对得齐（标题长短不影响） */}
      <span className={`side ${st.tone}`}>
        <span className="stat">{st.label}</span>
        <span className="when">{ago(c.updatedAt)}</span>
      </span>

      {/*
        两枚动作常驻但压暗，鼠标进这一行才提亮。整条藏起来（原先的 `opacity: 0`）的代价是
        没人知道它们在——「导出」当初就是这么被当成这一页仅有的动作的。
        **它们自己占最右一格**，不叠在状态时间下面：叠着的时候这一列从上到下是
        「状态 / 时间 / 报告 / 删除」四样，前两样是信息、后两样是控件，读起来是一列。
      */}
      <span className="acts">
        <button
          title="切过去并直接翻到报告屏"
          onClick={() => onReport(c.id)}
        >
          <Icon name="report" size={12} />
          报告
        </button>
        <button className="wipe" title="删掉这次调查（不可撤销）" onClick={onAskWipe}>
          <Icon name="trash" size={12} />
          删除
        </button>
      </span>

      {/*
        就地展开的二次确认，与报告屏那两档收尾同一块样式（`.confirm`）：
        全应用没有回头路的手势只有这三个，它们该长成同一个样子。
        这一个比那两个更重——定稿与归档只是冻住，证据一条不少；这一下把证据也一并销毁。
      */}
      {wiping && (
        <div className="confirm">
          {/* ⚠️ 整句不能断行：JSX 把换行加缩进折成一个空格，中文里那就是句子中间凭空多一个空格 */}
          <p>
            删掉<b>{c.title}</b>
            ：这次调查的步骤、对话、以及只被它引用的证据原文都会从库里清掉，没有任何入口找得回来。要留着记录但不再查了的话，用归档。
          </p>
          <div className="acts">
            <button className="seal" onClick={onWipe}>
              <Icon name="trash" size={12} />
              确认删除
            </button>
            <button onClick={onCancelWipe}>
              <Icon name="deny" size={12} />
              再想想
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
