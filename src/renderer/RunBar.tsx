import type { Snapshot } from '../shared/ipc.js';
import { runState } from './caseline.js';
import { Icon } from './Icon.js';

/**
 * 底部状态栏：**这一轮在跑什么、用什么跑、还剩多少上下文**（参照 `~/Projects/duetlens`
 * 的 `ReviewStatusBar`）。
 *
 * 运行态从顶栏下沉到这儿的理由：顶栏是"我在哪个工作区、能去哪儿"，与"agent 这会儿在干嘛"
 * 是两件事；而后者与输入框是同一件事的两端——发一句话进去、看着它跑起来，视线不该在
 * 屏幕上下两头来回跳。**模式开关同理长在这儿**：自动 / 接管说的是"接下来这些调用怎么过"，
 * 那正是输入框旁边该有的东西。
 *
 * 这一条只显示与操作**当前这一轮**：收尾三档不在这儿（定稿与归档搬去了报告屏，
 * ui.md §8.4），只有「停止」留着——它中断的就是这一轮。
 */
export function RunBar({
  snap,
  todos,
  takeover,
  frozen,
  onStop,
  onTakeover,
}: {
  snap: Snapshot;
  /** 当前调查等人处理的条数（①档 + ②档合起来）。 */
  todos: number;
  /** 按人最后按的那一下画，不是快照上那个——回执与快照都要一会儿才到。 */
  takeover: boolean;
  frozen: boolean;
  onStop: () => void;
  onTakeover: (on: boolean) => void;
}) {
  const state = stateOf(snap);
  const st = snap.busy ? 'busy' : snap.sessionStatus === 'crashed' ? 'crashed' : snap.sessionStatus;
  const agent = snap.case?.agent;
  const ctx = snap.context;

  return (
    <div className="runbar">
      <span className={`rb-state s-${st}`} title={sessionDetail(snap)}>
        {snap.busy && <span className="pulse" />}
        {state}
      </span>

      {/* 「停止」长在状态旁边：它中断的正是左边这枚正在跳的点（D7 会连排队消息一起清） */}
      {snap.busy && (
        <button className="rb-item act" title="中断当前轮，连排队消息一起清；调查照旧开着" onClick={onStop}>
          <Icon name="stop" size={10} />
          停止
        </button>
      )}

      {/* 支线默认就在后台跑（overview §3.4）：主线这一轮收了，后台可能还有一条在查。
          与「进行中」是两枚独立的东西——合成一个的话，只剩支线时界面要么说主线在跑，要么说空闲 */}
      {snap.backgroundLanes > 0 && (
        <span className="rb-item lanes" title="子 agent 支线在后台跑，主线不等它">
          支线 {snap.backgroundLanes}
        </span>
      )}

      {todos > 0 && (
        <span className="rb-item todo" title="有事卡在你这儿——卡片在上面的工作台里">
          等你 {todos}
        </span>
      )}

      <span className="rb-sep" />

      {agent && (
        <span className="rb-item rb-agent" title={agentTitle(snap)}>
          {agent.backend}
          {/* 没选模型时印 backend 报回来的那一个，而不是「账号默认」四个字：
              报告里要标"这一步是哪个模型跑的"，而这一栏是唯一说得出它的地方。
              还没跑过第一轮就问不到，那时才退回那句话 */}
          <span className="mono">{agent.model ?? ctx?.model ?? '账号默认'}</span>
          {agent.effort && <span className="effort mono">{agent.effort}</span>}
        </span>
      )}

      {/* 上下文用量每轮收尾时问一次（`case-runner` 的 `refreshContext`）。
          **分母要露面**：只给「63K · 31%」的话，占比看着不对也没法就地核对窗口有多大 */}
      {ctx && (
        <span className="rb-item" title={ctxTitle(ctx)}>
          <svg className="ring" viewBox="0 0 18 18" style={{ ['--ctx' as string]: String(ctx.percent / 100) }}>
            <circle className="bg" cx="9" cy="9" r="7" />
            <circle className="fg" cx="9" cy="9" r="7" />
          </svg>
          <span className="mono">
            {compact(ctx.usedTokens)}
            {ctx.maxTokens ? ` / ${compact(ctx.maxTokens)}` : ''} · {Math.round(ctx.percent)}%
          </span>
        </span>
      )}

      <span className="rb-spacer" />

      {/* 接管模式（overview §3.5）。**开着时要一直看得见**：它把非放行档的每次调用都挂到
          闸门上，而那些闸门没有超时兜底——不显示的话，人下次回到屏幕前看到的是一个"卡住不动"的
          agent，而原因是他自己几天前按下的这个开关。
          文案要说清"除只读与杂务"：说成"每次调用"会让人以为连读文件都过了人，
          于是拿一个并不存在的保护去对敏感仓库（放行档见 case-runner 的 `allowed`） */}
      {!frozen && (
        <span className="modesw" role="group" aria-label="权限模式">
          <button
            className={takeover ? '' : 'on'}
            title="自动模式：只读与杂务直接放行，其余交给 backend 的分类器按后果判"
            onClick={() => onTakeover(false)}
          >
            自动
          </button>
          <button
            className={takeover ? 'on' : ''}
            title="接管：除只读与杂务外，每次工具调用都要你放行 / 改写 / 拒绝，且不会自己过去"
            onClick={() => onTakeover(true)}
          >
            接管
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * 这一格的字。**四个基本档走 `runState`，与两个列表同一个出处**——各写各的下场就是
 * 首页写「已停止」、点进去写「待开始」（`caseline.tsx` 里那段说明）。
 *
 * 「会话中断」是这儿独有的一档：崩了与停了对人的下一步动作不一样（前者该看错误横幅），
 * 而列表那侧给不出这个区别，多说一句不构成矛盾。
 *
 * 「会话还开着没开着」不出现在这儿：那是实现细节，两种情况下人能做的事一模一样
 * （照样打字、照样发送）。它留在 title 里。
 */
export function stateOf(snap: Snapshot): string {
  if (snap.case?.status === 'open' && snap.sessionStatus === 'crashed' && !snap.busy) return '会话中断';
  return runState({
    status: snap.case?.status ?? 'open',
    running: snap.busy,
    // 库里那份 `started` 到不了这一屏，用等价的两条：跑出过步骤，或这个运行时开过会话
    started: snap.steps.length > 0 || snap.sessionStatus !== 'idle',
  }).label;
}

/** 会话这会儿开着没开着只进 title：它不改变人能做什么，但调查为什么慢半拍时它是线索。 */
function sessionDetail(snap: Snapshot): string {
  return (
    {
      idle: '还没开会话；发一句话就起一轮',
      live: '会话开着，随时接着发',
      ended: '上一轮的会话已经收了；再发一句会新起一轮',
      crashed: '上一轮会话中断了，原因看上面的横幅',
    } as const
  )[snap.sessionStatus];
}

function agentTitle(snap: Snapshot): string {
  const a = snap.case?.agent;
  const parts = [`agent：${a?.backend ?? '—'}`, `模型 ${a?.model ?? '账号默认'}`];
  if (a?.effort) parts.push(`思考强度 ${a.effort}`);
  // 落到哪一代只有 backend 说得出：面板上选的是 `sonnet` 这样的档位名（ui.md §8.1）
  if (snap.context?.model) parts.push(`本轮实际跑的是 ${snap.context.model}`);
  return parts.join(' · ');
}

function ctxTitle(ctx: NonNullable<Snapshot['context']>): string {
  const win = ctx.maxTokens ? ` / ${ctx.maxTokens.toLocaleString()}` : '';
  return `上下文 ${ctx.usedTokens.toLocaleString()}${win} tokens（上一轮收尾时问的，本轮跑完再更新）`;
}

/** 状态栏空间有限，只给量级；精确值留在 title 里。 */
function compact(n: number): string {
  if (n < 1000) return String(n);
  const [v, unit] = n < 1_000_000 ? [n / 1000, 'K'] : [n / 1_000_000, 'M'];
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${unit}`;
}
