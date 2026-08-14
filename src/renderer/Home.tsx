import { useEffect, useState } from 'react';
import type { CaseBrief, IntakeOptions } from '../shared/ipc.js';
import { ago, caseState, rootLabel, TodoBadge } from './caseline.js';
import { Intake } from './Intake.js';

/** 首页最多列这么多次排查（ui.md §8.5）。再往前走历史排查页。 */
const RECENT_LIMIT = 20;

/**
 * 首页：起一次新排查，或接着上次那个。
 *
 * 版面是**左右两栏**，因为这一页答的正好是两个问题：左边写新的，右边接上次。
 * 单栏时右边三分之一是死空，而两件事挤在一列里又要靠滚动才发现列表。
 *
 * 与历史排查页的分工要守住——**这一页只回答"接着上次那个"**：固定最近 20 条、
 * 不筛选、不检索、不分页。两页都做成全量列表的话，人得先想"该去哪一页找"，
 * 而那正是把一个入口拆成两个的唯一代价。
 *
 * 项目起点被提到页头，见 {@link RootBar}。它因此归这一层管，而不是新建面板里的一个字段。
 */
export function Home({
  cases,
  onOpen,
  onCreated,
  onAll,
}: {
  /** 快照里那份最近列表（`caseList` 已按 open 优先 + 最近活动倒序排过）。 */
  cases: CaseBrief[];
  onOpen: (caseId: string) => void;
  onCreated: () => void;
  onAll: () => void;
}) {
  /**
   * 可选项与项目起点都住在这一层：页头的起点条和新建面板读的必须是同一份，
   * 各自取一次的话两边会显示成两个起点，而真正生效的只有一个。
   */
  const [opts, setOpts] = useState<IntakeOptions | null>(null);
  // 存原字符串而不是 null：输入阶段做 trim 会把目录名里刚敲下的空格吃掉
  const [root, setRoot] = useState('');
  const [rootError, setRootError] = useState<string | null>(null);

  useEffect(() => {
    void window.inquestry.intakeOptions().then(setOpts);
  }, []);

  const recent = cases.slice(0, RECENT_LIMIT);
  const current = recent.find((c) => c.current) ?? null;
  const rest = recent.filter((c) => c !== current);

  return (
    <div className="page home">
      <RootBar
        root={root}
        recents={opts?.recentRoots ?? []}
        error={rootError}
        onPick={(v) => {
          setRoot(v);
          setRootError(null);
        }}
      />

      <div className="pagebody">
        <div className="homegrid">
          <section className="make">
            <h1>起一次新排查</h1>
            <p className="lead">起点在页头上，它决定 agent 继承哪套 skill 与 MCP。</p>
            <Intake
              opts={opts}
              root={root}
              onRoot={setRoot}
              onSubmit={(d) => window.inquestry.createCase(d)}
              onRootError={setRootError}
              onCreated={onCreated}
            />
          </section>

          <aside className="side">
            <div className="side-h">
              <h2>接着上次那个</h2>
              <span className="c">{recent.length || ''}</span>
              <button className="more" onClick={onAll}>
                全部 →
              </button>
            </div>

            {recent.length === 0 ? (
              <p className="blank">还没有排查。左边写下问题就能开始。</p>
            ) : (
              <>
                {current && <CurrentCard c={current} onOpen={onOpen} />}
                <div className="recent">
                  {rest.map((c) => (
                    <RecentRow key={c.id} c={c} onOpen={onOpen} />
                  ))}
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

/**
 * 页头那条起点条。
 *
 * 起点是**一种模式而不是一个表单字段**：它决定这次是真项目还是演示模式、
 * 挂哪套工具、信任边界在哪（ui.md §8.1）。做成常驻的一条比做成表单里第一格更诚实，
 * 也顺手答了"这次到底是不是演示模式"——那件事原来在界面上一点痕迹都没有。
 *
 * 最近用过的直接摊平成一行可点文字，不收进下拉：切起点是高频动作，
 * 而原先「选目录」实心按钮 + 三个 ghost 按钮是两种按钮样式在抢同一件事。
 */
function RootBar({
  root,
  recents,
  error,
  onPick,
}: {
  root: string;
  recents: string[];
  error: string | null;
  onPick: (v: string) => void;
}) {
  // 从别处挑来的路径不在最近列表里，也要能显示成选中的那一个
  const extra = root && !recents.includes(root) ? [root] : [];
  const options = [...extra, ...recents.slice(0, 4)];

  return (
    <header className="pagehead roots">
      <span className="k">起点</span>
      <nav className="picks">
        <button className={root ? '' : 'on'} onClick={() => onPick('')}>
          演示数据源
        </button>
        {options.map((p) => (
          <button key={p} className={p === root ? 'on' : ''} title={p} onClick={() => onPick(p)}>
            {rootLabel(p)}
          </button>
        ))}
      </nav>
      <button
        className="browse"
        onClick={() => void window.inquestry.pickProjectRoot().then((p) => p && onPick(p))}
      >
        选目录…
      </button>
      {/* 靠右那一段读的是「这次挂的是什么」，不夹在可点的那几个中间。
          起点不合法时它整个让位给错误——那时"挂的是什么"已经不成立了，而且顶栏是定高的，
          两条并排会把其中一条挤没 */}
      {error ? (
        <span className="what err">{error}</span>
      ) : (
        <span className="what">
          {root ? '真项目 · 继承该目录的 skill 与 MCP' : '隔离模式 · 内置玩具数据源'}
        </span>
      )}
    </header>
  );
}

/**
 * 「当前那一次」那张卡。
 *
 * 它是这一栏唯一值得占三行的东西：状态、等你几条、多久没动过，
 * 三样凑齐才决定得了要不要现在点进去；其余的一行足够。
 */
function CurrentCard({ c, onOpen }: { c: CaseBrief; onOpen: (id: string) => void }) {
  const st = caseState(c);
  return (
    <button className="curcard" onClick={() => onOpen(c.id)}>
      <span className="l1">
        <span className={`st ${st.tone}`}>
          {st.tone === 'run' && <i />}
          {st.label}
        </span>
        <TodoBadge n={c.todos} />
      </span>
      <span className={`title ${st.tone === 'done' ? 'done' : ''}`}>{c.title}</span>
      <span className="l3">
        {ago(c.updatedAt)}
        <span className="go">继续 →</span>
      </span>
    </button>
  );
}

function RecentRow({ c, onOpen }: { c: CaseBrief; onOpen: (id: string) => void }) {
  const st = caseState(c);
  return (
    <button className="rrow" onClick={() => onOpen(c.id)}>
      <span className={`title ${st.tone === 'done' ? 'done' : ''}`}>{c.title}</span>
      <span className="when">{ago(c.updatedAt)}</span>
      <span className="l2">
        <span className={`st ${st.tone}`}>{st.label}</span>
        <TodoBadge n={c.todos} />
      </span>
    </button>
  );
}
