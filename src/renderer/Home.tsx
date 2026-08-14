import type { CaseBrief } from '../shared/ipc.js';
import { ago, caseState, TodoBadge } from './caseline.js';
import { Intake } from './Intake.js';

/** 首页最多列这么多次排查（ui.md §8.5）。再往前走历史排查页。 */
const RECENT_LIMIT = 20;

/**
 * 首页：起一次新排查，或接着上次那个。
 *
 * 与历史排查页的分工要守住——**这一页只回答"接着上次那个"**：固定最近 20 条、
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
  const recent = cases.slice(0, RECENT_LIMIT);
  return (
    <div className="page home">
      <header className="pagehead">
        <h1>首页</h1>
        <span className="sub">起一次新排查，或接着上次那个</span>
      </header>
      <div className="pagebody">
        <div className="pad">
          <Intake onSubmit={(d) => window.inquestry.createCase(d)} onCreated={onCreated} />

          <div className="sec-h">
            <h2>最近排查</h2>
            {/* 只说得出"这一页列了几条"。库里总数要另查一次，为一行说明多跑一条 COUNT
                不值得——想知道全部有多少，那正是历史排查页第一行写着的 */}
            <span className="c">{recent.length ? `${recent.length} 次` : ''}</span>
            <button className="more" onClick={onAll}>
              全部历史 →
            </button>
          </div>

          {recent.length === 0 ? (
            <p className="blank">还没有排查。上面写下问题就能开始。</p>
          ) : (
            <div className="cases">
              {recent.map((c) => {
                const st = caseState(c);
                return (
                  <button key={c.id} className="crow" onClick={() => onOpen(c.id)}>
                    <span className="t">
                      <span className={`title ${st.tone === 'done' ? 'done' : ''}`}>{c.title}</span>
                      <TodoBadge n={c.todos} />
                      {c.current && <span className="badge cur">当前</span>}
                    </span>
                    <span className={`st ${st.tone}`}>{st.label}</span>
                    <span className="meta">{ago(c.updatedAt)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
