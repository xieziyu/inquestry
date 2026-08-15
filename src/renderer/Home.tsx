import { useEffect, useState } from 'react';
import type { CaseBrief, IntakeOptions } from '../shared/ipc.js';
import { ago, caseState, TodoBadge } from './caseline.js';
import { Icon } from './Icon.js';
import { Intake } from './Intake.js';
import { LogoMark } from './LogoMark.js';

/** 首页最多列这么多次调查（ui.md §8.5）。再往前走历史调查页。 */
const RECENT_LIMIT = 20;

/**
 * 首页：起一次新调查，或接着上次那个。
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

  // ⚠️ **顺序照库里那份，当前调查不提前**：这条轨道是一根时间轴（`.tr::before` 那条竖线
  // 与首尾两个半截收口），把当前那条抽到第一行就是让轴上的先后说假话——
  // 而点进去再回来并不产生任何领域事件，`updated_at` 没动过。当前是哪一条由 `.cur` 说。
  const rows = cases.slice(0, RECENT_LIMIT);

  return (
    <div className="page home">
      <header className="pagehead">
        <h1>首页</h1>
      </header>

      <div className="pagebody">
        <div className="homecol">
          <div className="mast">
            {/* 名字就在旁边写着，标记这时是装饰——不藏起来读屏会把 Inquestry 念两遍 */}
            <span aria-hidden="true">
              <LogoMark size={34} />
            </span>
            <span className="word">Inquestry</span>
          </div>

          <Intake opts={opts} onSubmit={(d) => window.inquestry.createCase(d)} onCreated={onCreated} />

          <section>
            <div className="bandhead">
              <h2>近期调查</h2>
              <span className="c">{rows.length || ''}</span>
              <button className="all" onClick={onAll}>
                全部历史
                <Icon name="arrow" size={12} />
              </button>
            </div>

            {rows.length === 0 ? (
              <p className="blank">暂无记录</p>
            ) : (
              <div className="track">
                {rows.map((c) => (
                  <TrackRow key={c.id} c={c} onOpen={onOpen} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * 轨道上的一条调查。
 *
 * ⚠️ 节点分档的次序**不是 `caseState` 那一套**：等人处理排在运行中之前。
 * 暖色是「需要人动手」的全局专属（ui.md §4），一条边跑边等人的调查该先说它在等你。
 */
function TrackRow({ c, onOpen }: { c: CaseBrief; onOpen: (id: string) => void }) {
  const st = caseState(c);
  const node = st.tone === 'done' ? 'shut' : c.todos > 0 ? 'wait' : st.tone === 'run' ? 'live' : '';
  return (
    <button className={`tr ${node}${c.current ? ' cur' : ''}`} onClick={() => onOpen(c.id)}>
      <span className="nd" />
      <span className={`title ${st.tone === 'done' ? 'done' : ''}`}>{c.title}</span>
      <span className="when">{ago(c.updatedAt)}</span>
      <span className="m">
        <span className={`st ${st.tone}`}>{st.label}</span>
        <TodoBadge n={c.todos} />
      </span>
    </button>
  );
}
