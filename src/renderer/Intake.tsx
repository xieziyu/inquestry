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
 * 新建排查面板（ui.md §8.1）。
 *
 * 字段顺序是**先项目起点再写问题**：起点决定 agent 继承哪套 skill / MCP，
 * 先选它，问题才写得有的放矢。
 *
 * 基准日期不放在「已知现象」那一档可选项里，因为它不是背景信息：没有它 `occurred_at_ms`
 * 落不成绝对时刻，系统时间线就是空的（D11 / D27）。时区不收，取本机的。
 */
export function Intake({ onSubmit }: { onSubmit: (d: IntakeDraft) => Promise<IntakeResult> }) {
  const [opts, setOpts] = useState<IntakeOptions | null>(null);
  // 存原字符串而不是 null：输入阶段做 trim 会把目录名里刚敲下的空格吃掉
  const [root, setRoot] = useState('');
  const [question, setQuestion] = useState('');
  const [incidentDate, setIncidentDate] = useState('');
  const [clues, setClues] = useState('');
  const [agent, setAgent] = useState<AgentChoice>({ backend: 'claude', model: null, effort: null });
  const [submitting, setSubmitting] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  useEffect(() => {
    void window.inquestry.intakeOptions().then((o) => {
      setOpts(o);
      setIncidentDate((d) => d || o.defaults.incidentDate);
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
      });
      // 成功时不复位 submitting：建完单整屏就换掉了，复位只会让按钮闪一下
      if (!r.ok) {
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
    <div className="intake">
      <h1>新建排查</h1>
      <p className="lede">
        一个问题一次排查。一次排查可以跨多个会话，中途换模型是常态——所以 agent 三项记在会话上，
        项目起点与基准日期记在排查上。
      </p>

      <label className="field">
        <span className="k">项目起点</span>
        <div className="row">
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
        </div>
        <span className={rootError ? 'hint err' : 'hint'}>
          {rootError ?? (
            <>
              agent 在这个目录下运行，继承该项目的 skill 与 MCP；会话记录也落在它对应的
              <code> ~/.claude/projects </code>目录下。
            </>
          )}
        </span>
        {!!opts?.recentRoots.length && (
          <div className="recent">
            {opts.recentRoots.map((r) => (
              <button key={r} className={r === root ? 'on' : ''} onClick={() => setRoot(r)}>
                {r.split('/').slice(-1)[0]}
              </button>
            ))}
          </div>
        )}
      </label>

      <label className="field">
        <span className="k">问题</span>
        <textarea
          rows={4}
          value={question}
          placeholder="线上发生了什么、谁受影响、你已经知道的现象…"
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>

      <label className="field">
        <span className="k">基准日期</span>
        <input
          className={dateError ? 'bad' : ''}
          value={incidentDate}
          placeholder="YYYY-MM-DD"
          onChange={(e) => setIncidentDate(e.target.value)}
        />
        <span className={dateError ? 'hint err' : 'hint'}>
          {dateError ?? (
            <>
              日志时间串多半只有 <code>12:03:01.220</code>，没有这一天就排不出系统时间线。不带时区的时间串按这一天的本机时区{' '}
              <code>{tzOffset ?? '…'}</code> 解释。
            </>
          )}
        </span>
      </label>

      <label className="field">
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

      <div className="agent">
        <span className="k">Agent</span>
        <div className="row">
          {opts?.backends.map((b) => (
            <button
              key={b.value}
              className={agent.backend === b.value ? 'on' : ''}
              disabled={!b.enabled}
              title={b.note}
              onClick={() => setAgent({ backend: b.value, model: null, effort: null })}
            >
              {b.label}
              {b.note && <em> {b.note}</em>}
            </button>
          ))}
        </div>

        <div className="row wrap">
          {!hasDefaultRow && (
            <button
              className={agent.model === null ? 'on' : ''}
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
                className={agent.model === value ? 'on' : ''}
                title={m.description}
                onClick={() => setAgent((a) => ({ ...a, model: value, effort: null }))}
              >
                {m.label}
              </button>
            );
          })}
        </div>

        {efforts.length > 0 && (
          <div className="row wrap">
            <span className="k sub">思考强度</span>
            {efforts.map((e) => (
              <button
                key={e}
                className={agent.effort === e ? 'on' : ''}
                onClick={() => setAgent((a) => ({ ...a, effort: a.effort === e ? null : e }))}
              >
                {e}
              </button>
            ))}
          </div>
        )}

        {opts && !opts.modelsProbed && (
          <span className="hint">没能从 backend 问到模型列表（可能是还没登录），下面这几项是内置兜底。</span>
        )}
      </div>

      <div className="actions">
        <button onClick={useDemo} disabled={!opts || submitting}>
          用演示数据填一份
        </button>
        <button className="primary" disabled={!ready} onClick={() => void submit()}>
          创建排查
        </button>
      </div>
    </div>
  );
}
