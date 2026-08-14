import { useEffect, useState } from 'react';
import type { AgentChoice, IntakeDraft, IntakeOptions, IntakeResult, ModelOption } from '../shared/ipc.js';
import { rootLabel } from './caseline.js';

/** backend 报出来的「不指定模型」那一档的 value。 */
const DEFAULT_ROW = 'default';

/** 「不指定」在 `<select>` 里的 value：`null` 不是合法的 option value。 */
const NONE = '';

/**
 * 下拉里一行模型怎么写。
 *
 * **版本号要露出来**：backend 报的 `label` 只有系列名（`Sonnet`），而同一个系列换代之后
 * 界面上一个字都不会变——报告里却要标"这一步是哪个模型跑的"。`resolvedModel` 是 backend
 * 自己说的那个 id，没有它（内置兜底表）就只写系列名，不自己拼一个版本号出来。
 */
function modelText(m: ModelOption): string {
  return m.resolvedModel ? `${m.label} · ${m.resolvedModel}` : m.label;
}

/**
 * 新建排查的合成器（ui.md §8.1），住在首页左栏。
 *
 * 三件事按**必须先做的在上面**排：选工作区 → 写问题 → 开始排查。
 * 工作区一度挂在页头，已否决——顶栏读起来像状态栏，人不会把那儿当成"第一步"，
 * 而它恰恰是不做就没法往下走的那一步。
 *
 * 其余填一次就不再动的收进「更多选项」。agent 三项（backend / 模型 / 思考强度）都用原生下拉：
 * 探测出来的模型是十几个的量级，摊成一排按钮会把这个面板撑成一堵墙；
 * backend 用按钮则读起来像"点一下就执行"，而它是个单选。
 */
export function Intake({
  opts,
  onSubmit,
  onCreated,
}: {
  /** 由首页取一次交下来；还没到手时按"探测不到"渲染，不要自己再取一次。 */
  opts: IntakeOptions | null;
  onSubmit: (d: IntakeDraft) => Promise<IntakeResult>;
  /** 建成了。由首页负责翻到工作区——这个组件不知道外面有几个屏。 */
  onCreated: () => void;
}) {
  // 存原字符串而不是 null：输入阶段做 trim 会把目录名里刚敲下的空格吃掉
  const [root, setRoot] = useState('');
  /** 工作区不合法只有提交时才知道（目录可能刚被删掉），那条错误要回到工作区那一格上。 */
  const [rootError, setRootError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [agent, setAgent] = useState<AgentChoice>({ backend: 'claude', model: null, effort: null });
  const [takeover, setTakeover] = useState(false);
  const [more, setMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!opts) return;
    // 设置屏定的预填。**只在首次载入时铺**：人已经在面板上改过之后，
    // 一次 options 重取不该把他挑的那套冲掉
    setAgent((a) => (a.model === null && a.effort === null ? opts.agentDefaults.agent : a));
    setTakeover(opts.agentDefaults.takeover);
  }, [opts]);

  const model = opts?.models.find((m) => m.value === (agent.model ?? DEFAULT_ROW));
  // 模型不支持 effort 就整项不出现，而不是给个拧了不生效的假开关（D19）
  const efforts = model?.efforts ?? [];
  // backend 报得出「默认」那一档时就用它那行——它说得出默认到底落到哪个模型
  const defaultRow = opts?.models.find((m) => m.value === DEFAULT_ROW);
  const ready = question.trim().length > 0 && root.trim().length > 0 && !submitting;
  /**
   * 设置屏挑的模型这会儿可能探测不到了（那时探到、这时退回内置表）。
   * 说出来比默默换掉强：默默换掉的话，人以为在用 opus，报告里记的是另一个。
   */
  const modelMissing = agent.model !== null && !!opts && !model;

  const pick = () => void window.inquestry.pickProjectRoot().then((p) => p && choose(p));
  const choose = (v: string) => {
    setRoot(v);
    setRootError(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setRootError(null);
    try {
      const r = await onSubmit({
        projectRoot: root.trim(),
        question: question.trim(),
        agent,
        takeover,
      });
      if (r.ok) {
        // 建完就清空：首页不会自己换掉，留着上一次的问题会让下一次误以为没提交成功
        setQuestion('');
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

  // 从别处挑来的路径不在最近列表里，也要能显示成选中的那一个
  const recents = opts?.recentRoots ?? [];
  const chips = [...(root && !recents.includes(root) ? [root] : []), ...recents.slice(0, 5)];

  return (
    <div className="compose">
      <div className="f ws">
        <span className="k">工作区</span>
        <div className="row">
          <button className={`dir ${root ? '' : 'need'}`} onClick={pick}>
            {root ? '更换目录…' : '选择目录…'}
          </button>
          {root && (
            // 截断要从头上截（末级目录才是认得出是哪个项目的那一段），所以外层走 rtl；
            // 路径本身必须留在 ltr 的隔离里，否则开头那个 `/` 会被 bidi 挪到末尾
            <span className="path" title={root}>
              <bdi>{root}</bdi>
            </span>
          )}
        </div>
        {chips.length > 0 && (
          <div className="row wrap chips">
            {chips.map((p) => (
              <button
                key={p}
                className={p === root ? 'on' : ''}
                title={p}
                onClick={() => choose(p)}
              >
                {rootLabel(p)}
              </button>
            ))}
          </div>
        )}
        {/* 只在提交时才知道目录不合法（可能刚被删掉），那条错误要回到这一格上 */}
        {rootError && <p className="hint err">{rootError}</p>}
      </div>

      <label className="f">
        <span className="k">问题描述</span>
        <textarea
          value={question}
          placeholder="线上发生了什么、谁受影响、你已经知道的现象（涉及服务 / traceId / 用户 ID / 报错码都写进来）…"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </label>

      <div className="row">
        <button className="more" onClick={() => setMore(!more)}>
          {more ? '收起选项 ▴' : '更多选项 ▾'}
        </button>
      </div>

      {more && (
        <div className="adv">
          <label className="f">
            <span className="k">Agent</span>
            <select
              value={agent.backend}
              onChange={(e) =>
                setAgent({ backend: e.target.value as AgentChoice['backend'], model: null, effort: null })
              }
            >
              {opts?.backends.map((b) => (
                <option key={b.value} value={b.value} disabled={!b.enabled}>
                  {b.label}
                  {b.note ? `（${b.note}）` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="f">
            <span className="k">权限模式</span>
            <div className="seg">
              <button className={takeover ? '' : 'on'} onClick={() => setTakeover(false)}>
                自动模式
              </button>
              <button className={takeover ? 'on' : ''} onClick={() => setTakeover(true)}>
                全程接管
              </button>
            </div>
          </div>

          <label className="f wide">
            <span className="k">模型</span>
            <select
              value={agent.model ?? NONE}
              onChange={(e) =>
                setAgent((a) => ({ ...a, model: e.target.value || null, effort: null }))
              }
            >
              <option value={NONE}>{defaultRow ? modelText(defaultRow) : '默认模型'}</option>
              {opts?.models
                // backend 报的 default 那一档就是上面那条「不指定」，不再列一遍
                .filter((m) => m.value !== DEFAULT_ROW)
                .map((m) => (
                  <option key={m.value} value={m.value} title={m.description}>
                    {modelText(m)}
                  </option>
                ))}
              {/* 设置里挑的那个探测不到时也要显示成选中的，否则下拉会自己跳回默认那一档 */}
              {modelMissing && <option value={agent.model!}>{agent.model}</option>}
            </select>
            {modelMissing && (
              <span className="hint err">
                设置里挑的 <code>{agent.model}</code> 这会儿没探测到，跑起来会退回默认模型。
              </span>
            )}
            {opts && !opts.modelsProbed && (
              <span className="hint">
                没能从 backend 问到模型列表（可能是还没登录），这几项是内置兜底，因此也报不出版本号。
              </span>
            )}
          </label>

          {efforts.length > 0 && (
            <label className="f">
              <span className="k">思考强度</span>
              <select
                value={agent.effort ?? NONE}
                onChange={(e) => setAgent((a) => ({ ...a, effort: e.target.value || null }))}
              >
                <option value={NONE}>默认</option>
                {efforts.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      <div className="acts">
        <button className="primary" disabled={!ready} onClick={() => void submit()}>
          开始排查 <small>⌘↵</small>
        </button>
        {!root.trim() && <span className="hint">先选一个工作区目录。</span>}
      </div>
    </div>
  );
}
