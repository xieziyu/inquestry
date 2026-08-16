import { useEffect, useState } from 'react';
import { Icon } from './Icon.js';
import type { AgentChoice, IntakeDraft, IntakeOptions, IntakeResult, ModelOption } from '../shared/ipc.js';
import { rootLabel, rootParent } from './caseline.js';
import { Picker, type PickerItem } from './Picker.js';

/** backend 报出来的「不指定模型」那一档的 value。 */
const DEFAULT_ROW = 'default';

/** 「不指定」那一档的 value：`null` 不能当选项的值。 */
const NONE = '';

/** 「更多选项」收起时那一行写什么：这次拿什么跑。 */
function optionSummary(
  opts: IntakeOptions | null,
  agent: AgentChoice,
  model: ModelOption | undefined,
  takeover: boolean,
): string {
  const backend = opts?.backends.find((b) => b.value === agent.backend)?.label ?? agent.backend;
  const name = model?.label ?? agent.model ?? '默认模型';
  return [backend, name, agent.effort, takeover ? '全程接管' : '自动模式'].filter(Boolean).join(' · ');
}

/**
 * 新建调查的合成器（ui.md §8.1），首页上面那一带。
 *
 * 三件事按**必须先做的在上面**排：选工作区 → 写问题 → 启动。
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

  // 从别处挑来的路径不在最近列表里，也要能在菜单里显示成选中的那一个
  const recents = opts?.recentRoots ?? [];
  const roots: PickerItem[] = [...(root && !recents.includes(root) ? [root] : []), ...recents].map((p) => ({
    value: p,
    label: rootLabel(p),
    note: rootParent(p),
    title: p,
  }));

  const backends: PickerItem[] = (opts?.backends ?? []).map((b) => ({
    value: b.value,
    label: b.label,
    note: b.note,
    disabled: !b.enabled,
  }));

  const models: PickerItem[] = [
    { value: NONE, label: defaultRow?.label ?? '默认模型', note: defaultRow?.resolvedModel },
    // backend 报的 default 那一档就是上面那条「不指定」，不再列一遍
    ...(opts?.models ?? [])
      .filter((m) => m.value !== DEFAULT_ROW)
      .map((m) => ({ value: m.value, label: m.label, note: m.resolvedModel, title: m.description })),
    // 设置里挑的那个探测不到时也要显示成选中的，否则按钮上会跳回默认那一档
    ...(modelMissing ? [{ value: agent.model!, label: agent.model! }] : []),
  ];

  return (
    <div className="compose">
      <div className="target">
        <span className="k">工作区</span>
        <Picker
          label="工作区"
          value={root}
          items={roots}
          onPick={choose}
          placeholder="选择目录…"
          icon={<Icon name="folder" size={15} />}
          need={!root}
          noteTruncate="head"
          action={{ label: '打开其他目录…', icon: <Icon name="plus" />, onSelect: pick }}
        />
        {/* 只在提交时才知道目录不合法（可能刚被删掉），那条错误要回到这一格上 */}
        {rootError && <p className="hint err">{rootError}</p>}
      </div>

      <div className="qwrap">
        <textarea
          className="qbox"
          value={question}
          placeholder="请描述需要排查的具体问题或者调研任务"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>

      {more && (
        <div className="adv">
          <div className="f">
            <span className="k">Agent</span>
            <Picker
              label="Agent"
              value={agent.backend}
              items={backends}
              onPick={(v) => setAgent({ backend: v as AgentChoice['backend'], model: null, effort: null })}
            />
          </div>

          <div className="f">
            <span className="k">模型</span>
            <Picker
              label="模型"
              value={agent.model ?? NONE}
              items={models}
              bad={modelMissing}
              onPick={(v) => setAgent((a) => ({ ...a, model: v || null, effort: null }))}
            />
            {modelMissing && (
              <span className="hint err">
                设置里挑的 <code>{agent.model}</code> 这会儿探测不到，仍会原样交给 backend；
                真下线了的话这次调查起不来。
              </span>
            )}
            {opts && !opts.modelsProbed && (
              <span className="hint">
                没能从 backend 问到模型列表（可能是还没登录），这几项是内置兜底，因此也报不出版本号。
              </span>
            )}
          </div>

          {efforts.length > 0 && (
            <div className="f">
              <span className="k">思考强度</span>
              <Picker
                label="思考强度"
                value={agent.effort ?? NONE}
                items={[{ value: NONE, label: '默认' }, ...efforts.map((e) => ({ value: e, label: e }))]}
                onPick={(v) => setAgent((a) => ({ ...a, effort: v || null }))}
              />
            </div>
          )}

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
        </div>
      )}

      <div className="bar">
        <button
          className={`opts${modelMissing ? ' bad' : ''}`}
          aria-expanded={more}
          title="更多选项"
          onClick={() => setMore(!more)}
        >
          {optionSummary(opts, agent, model, takeover)}
          <span className="caret">{more ? '▴' : '▾'}</span>
        </button>
        <span className="right">
          {!root.trim() && <span className="hint">先选一个工作区目录。</span>}
          <button className="go" disabled={!ready} onClick={() => void submit()}>
            <Icon name="play" />
            启动 <small>⌘↵</small>
          </button>
        </span>
      </div>
    </div>
  );
}
