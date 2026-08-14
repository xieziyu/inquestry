import { useEffect, useState } from 'react';
import type { AgentChoice, IntakeDraft, IntakeOptions, IntakeResult } from '../shared/ipc.js';
import { tzOffsetOn } from '../shared/time.js';

/** backend 报出来的「不指定模型」那一档的 value。 */
const DEFAULT_ROW = 'default';

/**
 * 格式对不代表日子存在，而且两种错法都要接住：`2026-02-30` 会被悄悄算成 3 月 2 日，
 * `2026-13-01` 直接是 Invalid Date（这时 `toISOString()` 会抛）。
 */
function checkDate(v: string): string | null {
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s ? '格式要是 YYYY-MM-DD' : '基准日期必填';
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return '这一天不存在';
  return new Date(ms).toISOString().slice(0, 10) === s ? null : '这一天不存在';
}

/**
 * 新建排查的合成器（ui.md §8.1），住在首页顶上。
 *
 * 字段顺序仍是**先项目起点再写问题**：起点决定 agent 继承哪套 skill / MCP，
 * 先选它，问题才写得有的放矢。压缩掉的只是那些填一次就不再动的——
 * 已知现象、思考强度、权限模式收进「更多选项」，**基准日期不在里面**：
 * 它填错不会报错，只会让系统时间线悄悄排乱，所以必须一直露在外面。
 *
 * 时区不收，取本机的。
 */
export function Intake({
  onSubmit,
  onCreated,
}: {
  onSubmit: (d: IntakeDraft) => Promise<IntakeResult>;
  /** 建成了。由首页负责翻到工作区——这个组件不知道外面有几个屏。 */
  onCreated: () => void;
}) {
  const [opts, setOpts] = useState<IntakeOptions | null>(null);
  // 存原字符串而不是 null：输入阶段做 trim 会把目录名里刚敲下的空格吃掉
  const [root, setRoot] = useState('');
  const [question, setQuestion] = useState('');
  const [incidentDate, setIncidentDate] = useState('');
  const [clues, setClues] = useState('');
  const [agent, setAgent] = useState<AgentChoice>({ backend: 'claude', model: null, effort: null });
  const [takeover, setTakeover] = useState(false);
  const [more, setMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  useEffect(() => {
    void window.inquestry.intakeOptions().then((o) => {
      setOpts(o);
      setIncidentDate((d) => d || o.defaults.incidentDate);
      // 设置屏定的预填。**只在首次载入时铺**：人已经在面板上改过之后，
      // 一次 options 重取不该把他挑的那套冲掉
      setAgent((a) => (a.model === null && a.effort === null ? o.agentDefaults.agent : a));
      setTakeover(o.agentDefaults.takeover);
    });
  }, []);

  const hasDefaultRow = !!opts?.models.some((m) => m.value === DEFAULT_ROW);
  const model = opts?.models.find((m) => m.value === (agent.model ?? DEFAULT_ROW));
  // 模型不支持 effort 就整项不出现，而不是给个拧了不生效的假开关（D19）
  const efforts = model?.efforts ?? [];
  // 基准日期错了不会有任何报错，只会让整条系统时间线排乱，
  // 所以在这里拦住，而不是在下游悄悄替换成一个默认值
  const dateError = checkDate(incidentDate);
  const ready = question.trim().length > 0 && !dateError && !submitting;
  // 与 main 落库时用的是同一个函数、同一个日期，面板上显示的偏移不会和库里的对不上
  const tzOffset = dateError ? null : tzOffsetOn(incidentDate.trim());
  /**
   * 设置屏挑的模型这会儿可能探测不到了（那时探到、这时退回内置表）。
   * 说出来比默默换掉强：默默换掉的话，人以为在用 opus，报告里记的是另一个。
   */
  const modelMissing = agent.model !== null && !!opts && !model;

  const submit = async () => {
    setSubmitting(true);
    setRootError(null);
    try {
      const r = await onSubmit({
        projectRoot: root.trim() || null,
        question: question.trim(),
        incidentDate: incidentDate.trim(),
        clues: clues.trim() || null,
        agent,
        takeover,
      });
      if (r.ok) {
        // 建完就清空：首页不会自己换掉，留着上一次的问题会让下一次误以为没提交成功
        setQuestion('');
        setClues('');
        setSubmitting(false);
        onCreated();
      } else {
        setRootError(r.error);
        setSubmitting(false);
      }
    } catch (err) {
      setRootError(String((err as Error).message ?? err));
      setSubmitting(false);
    }
  };

  const useDemo = () => {
    if (!opts) return;
    setRoot('');
    setQuestion(opts.demo.question);
    setIncidentDate(opts.demo.incidentDate);
    setClues('');
  };

  return (
    <div className="compose">
      {/* 起点在最前：它决定挂哪套工具，也决定这是真项目还是演示模式（ui.md §8.1） */}
      <div className="rootrow">
        <span className="k">项目起点</span>
        <input
          value={root}
          placeholder="不填 = 演示模式（挂内置玩具数据源）"
          className={rootError ? 'bad' : ''}
          onChange={(e) => {
            setRoot(e.target.value);
            setRootError(null);
          }}
        />
        <button onClick={() => void window.inquestry.pickProjectRoot().then((p) => p && setRoot(p))}>
          选目录
        </button>
        {opts?.recentRoots.slice(0, 3).map((r) => (
          <button
            key={r}
            className={`ghost ${r === root ? 'on' : ''}`}
            title={r}
            onClick={() => setRoot(r)}
          >
            {r.split('/').slice(-1)[0]}
          </button>
        ))}
      </div>
      {rootError && <p className="hint err">{rootError}</p>}

      <textarea
        value={question}
        placeholder="线上发生了什么、谁受影响、你已经知道的现象…"
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) {
            e.preventDefault();
            void submit();
          }
        }}
      />

      <div className="row">
        <label className="chip">
          基准日期
          <input
            className={`date ${dateError ? 'bad' : ''}`}
            value={incidentDate}
            placeholder="YYYY-MM-DD"
            onChange={(e) => setIncidentDate(e.target.value)}
          />
          <em>{tzOffset ?? '—'}</em>
        </label>

        {opts?.backends.map((b) => (
          <button
            key={b.value}
            className={`chip pick ${agent.backend === b.value ? 'on' : ''}`}
            disabled={!b.enabled}
            title={b.note}
            onClick={() => setAgent({ backend: b.value, model: null, effort: null })}
          >
            {b.label}
            {b.note && <em>{b.note}</em>}
          </button>
        ))}

        <button className="more" onClick={() => setMore(!more)}>
          {more ? '收起选项 ▴' : '更多选项 ▾'}
        </button>
        <span className="spacer" />
        <button className="ghost" onClick={useDemo} disabled={!opts || submitting}>
          用演示数据填一份
        </button>
        <button className="primary" disabled={!ready} onClick={() => void submit()}>
          开始排查 <small>⌘↵</small>
        </button>
      </div>

      {/* 基准日期填错不报错、只让时间线悄悄排乱，所以这条提示与「更多选项」无关，始终在 */}
      <p className={dateError ? 'hint err' : 'hint'}>
        {dateError ?? '日志时间串多半只有 12:03:01.220，没有这一天就排不出系统时间线。时区取本机的，不可改。'}
      </p>

      {more && (
        <div className="adv">
          <label className="f">
            <span className="k">
              已知现象 <em>可选</em>
            </span>
            <input
              value={clues}
              placeholder="涉及服务 / traceId / 用户 ID / 报错码"
              onChange={(e) => setClues(e.target.value)}
            />
            <span className="hint">填了能省掉 agent 前几轮试探，不填也能跑。</span>
          </label>

          <div className="f">
            <span className="k">权限模式</span>
            <div className="seg">
              <button className={takeover ? '' : 'on'} onClick={() => setTakeover(false)}>
                分层放行
              </button>
              <button className={takeover ? 'on' : ''} onClick={() => setTakeover(true)}>
                全程接管
              </button>
            </div>
            <span className="hint">随时可切。接管档每次调用都要你放行，且不会自动过去。</span>
          </div>

          <div className="f wide">
            <span className="k">模型</span>
            <div className="row wrap">
              {!hasDefaultRow && (
                <button
                  className={`chip pick ${agent.model === null ? 'on' : ''}`}
                  onClick={() => setAgent((a) => ({ ...a, model: null, effort: null }))}
                >
                  默认模型
                </button>
              )}
              {opts?.models.map((m) => {
                // backend 报的 default 那一档就是「不指定」：存 null，不把 'default' 当模型名传下去
                const value = m.value === DEFAULT_ROW ? null : m.value;
                return (
                  <button
                    key={m.value}
                    className={`chip pick ${agent.model === value ? 'on' : ''}`}
                    title={m.description}
                    onClick={() => setAgent((a) => ({ ...a, model: value, effort: null }))}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
            {modelMissing && (
              <span className="hint err">
                设置里挑的 <code>{agent.model}</code> 这会儿没探测到，跑起来会退回默认模型。
              </span>
            )}
            {opts && !opts.modelsProbed && (
              <span className="hint">没能从 backend 问到模型列表（可能是还没登录），这几项是内置兜底。</span>
            )}
          </div>

          {efforts.length > 0 && (
            <div className="f wide">
              <span className="k">思考强度</span>
              <div className="row wrap">
                {efforts.map((e) => (
                  <button
                    key={e}
                    className={`chip pick ${agent.effort === e ? 'on' : ''}`}
                    onClick={() => setAgent((a) => ({ ...a, effort: a.effort === e ? null : e }))}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
