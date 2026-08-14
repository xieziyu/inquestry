import { useEffect, useState } from 'react';
import type { CaseBrief, IntakeOptions } from '../shared/ipc.js';
import { ago, caseState, TodoBadge } from './caseline.js';
import { Intake } from './Intake.js';

/** 首页最多列这么多次排查（ui.md §8.5）。再往前走历史排查页。 */
const RECENT_LIMIT = 20;

/**
 * 首页：起一次新排查，或接着上次那个。
 *
 * 版面是**左右两栏**，因为这一页答的正好是两个问题：左边写新的，右边接上次。
 * 单栏时右边三分之一是死空，而两件事挤在一列里又要靠滚动才发现列表。
 *
 * 与历史调查页的分工要守住——**这一页只回答"接着上次那个"**：固定最近 20 条、
 * 不筛选、不检索、不分页。两页都做成全量列表的话，人得先想"该去哪一页找"，
 * 而那正是把一个入口拆成两个的唯一代价。
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
  // 可选项在这一层取一次交给新建面板；探测要 spawn 一次 CLI，不该由面板每次重挂时重取
  const [opts, setOpts] = useState<IntakeOptions | null>(null);

  useEffect(() => {
    void window.inquestry.intakeOptions().then(setOpts);
  }, []);

  const recent = cases.slice(0, RECENT_LIMIT);
  const current = recent.find((c) => c.current) ?? null;
  const rest = recent.filter((c) => c !== current);

  return (
    <div className="page home">
      <header className="pagehead">
        <h1>新排查</h1>
      </header>

      <div className="pagebody">
        <div className="homegrid">
          <section className="make">
            <Intake opts={opts} onSubmit={(d) => window.inquestry.createCase(d)} onCreated={onCreated} />
          </section>

          <aside className="side">
            <div className="side-h">
              <h2>历史调查</h2>
              <span className="c">{recent.length || ''}</span>
              <button className="more" onClick={onAll}>
                全部 →
              </button>
            </div>

            {recent.length === 0 ? (
              <p className="blank">还没有排查。选个工作区、写下问题就能开始。</p>
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
