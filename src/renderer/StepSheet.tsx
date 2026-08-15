import type { CallNode, CaseMeta } from '../shared/ipc.js';
import type { StageBox } from './track.js';
import { directionText } from './track.js';
import { kindLabel, statusLabel } from './Stage.js';
import { Icon } from './Icon.js';

/**
 * 详情浮层：舞台上那张卡的全文。
 *
 * **不做居中弹窗**：读完这一步多半要接着看它的上一步、或推翻它的那一步；
 * 居中的浮层把画布整个盖住，等于每看一步就要关一次。做成右侧抽屉之后，
 * 画布还在旁边，选中的那张卡也一直看得见。
 *
 * 舞台的卡面只留五样，**证据与工具调用整个搬到了这里**——它们是逐字读的东西，
 * 而舞台那一档是扫视与介入用的（ui.md §2 的密度分层）。
 */
export function StepSheet({
  box,
  meta,
  liveLanes,
  onClose,
  onExcerpt,
  onStopLane,
  onGo,
  step,
  canStep,
}: {
  box: StageBox;
  meta: CaseMeta;
  liveLanes: string[];
  onClose: () => void;
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
  onStopLane: (lane: string) => void;
  /** 跳到别的一步（承接的那一步 / 推翻它的那一步）。 */
  onGo: (id: string) => void;
  step: (dir: 1 | -1) => void;
  canStep: (dir: 1 | -1) => boolean;
}) {
  if (box.kind === 'say') return null;

  return (
    <aside className="stepsheet">
      <div className="sh-head">
        {box.kind === 'case' ? (
          <>
            <span className="ord">信息卡</span>
            <span className="kind">这次调查的由来</span>
          </>
        ) : (
          <>
            <span className="ord">{box.row.label}</span>
            <span className="kind">{kindLabel(box.row.step.kind)}</span>
            <span className={`state ${box.row.step.status}`}>{statusLabel(box.row.step.status)}</span>
          </>
        )}
        <button className="x" title="关闭（Esc）" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="sh-body">
        {box.kind === 'case' ? <CaseBody meta={meta} /> : <StepBody box={box} onExcerpt={onExcerpt} onGo={onGo} liveLanes={liveLanes} onStopLane={onStopLane} />}
      </div>

      {/* 「上一步 / 下一步」走的是**到达顺序**，不是这一列自己的顺序：
          读的人在这儿要的是"接下来 agent 干了什么"，而那条线是跨列的 */}
      {box.kind === 'step' && (
        <div className="sh-foot">
          <button disabled={!canStep(-1)} onClick={() => step(-1)}>
            <Icon name="back" size={12} />
            上一步
          </button>
          <button disabled={!canStep(1)} onClick={() => step(1)}>
            <Icon name="arrow" size={12} />
            下一步
          </button>
        </div>
      )}
    </aside>
  );
}

function CaseBody({ meta }: { meta: CaseMeta }) {
  return (
    <>
      <section className="sh-sec">
        <h4>标题</h4>
        <p className="sh-lead">{meta.title}</p>
      </section>
      <section className="sh-sec">
        <h4>问题描述</h4>
        <p className="sh-quote">{meta.question}</p>
      </section>
      <section className="sh-sec">
        <h4>建单信息</h4>
        <div className="sh-rel">
          <span>
            工作区 <code>{meta.projectRoot ?? '无'}</code>
          </span>
          <span>
            基准日期 <code>{meta.incidentDate}</code> <code>{meta.tzOffset}</code>
            {/* 建单那一刻只能按本机当天猜，猜错了整条系统时间线静默挪一天 */}
            {meta.incidentDateSource === 'intake' && <em className="unconfirmed">未确认（建单当天猜的）</em>}
          </span>
          <span>
            agent <code>{meta.agent.backend}</code>
            {meta.agent.model && <code>{meta.agent.model}</code>}
            {meta.agent.effort && <code>{meta.agent.effort}</code>}
          </span>
        </div>
      </section>
    </>
  );
}

function StepBody({
  box,
  liveLanes,
  onExcerpt,
  onGo,
  onStopLane,
}: {
  box: Extract<StageBox, { kind: 'step' }>;
  liveLanes: string[];
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
  onGo: (id: string) => void;
  onStopLane: (lane: string) => void;
}) {
  const { row } = box;
  const step = row.step;
  const live = !!step.lane && liveLanes.includes(step.lane);
  return (
    <>
      <section className="sh-sec">
        <h4>这一步要验证什么</h4>
        <p className={`sh-lead ${step.status === 'refuted' || step.status === 'superseded' ? 'struck' : ''}`}>
          {directionText(step)}
        </p>
      </section>

      {step.verdict && (
        <section className="sh-sec">
          <h4>结论</h4>
          <p className="sh-quote">
            {step.verdict}
            {step.confidence !== null && <span className="conf">置信度 {step.confidence}</span>}
          </p>
        </section>
      )}

      <section className="sh-sec">
        <h4>它长在哪一列</h4>
        <div className="sh-rel">
          <span>{laneWord(row.laneId, step.lane)}</span>
          {row.parentLabel && <span>↳ 接 {row.parentLabel}</span>}
          {row.refutedBy !== null && (
            <span className="bad">
              ← {row.refutedBy ? `被 ${row.refutedBy} 推翻` : '已被推翻'}，这条结论已作废
            </span>
          )}
          {row.refutes.length > 0 && <span className="bad">推翻了 {row.refutes.join('、')}</span>}
          {/* **推翻者不在本次调查里时不给这枚钮**（跨案、或还没到）：`refutedBy` 恰好在
              那种情况下是空串——上面那句「已被推翻」照旧说得出事，而一枚点了没反应
              （或者把浮层弄没了）的按钮比没有更糟 */}
          {step.supersededBy && row.refutedBy && (
            <button className="jump" onClick={() => onGo(step.supersededBy!)}>
              跳到推翻它的那一步
            </button>
          )}
          {live && step.lane && (
            <button className="stoplane" onClick={() => onStopLane(step.lane!)}>
              <Icon name="stop" size={9} />
              停掉这条支线
            </button>
          )}
        </div>
      </section>

      {step.evidence.length > 0 && (
        <section className="sh-sec">
          <h4>证据 {step.evidence.length} 条 · 点一条看原始输出</h4>
          <ul className="sh-evi">
            {step.evidence.map((e) => (
              <li key={e.id} onClick={() => onExcerpt(e.callId, e.anchor, e.claim)}>
                <span className="when">{e.occurredAtRaw ?? '—'}</span>
                <span>
                  {e.actor && <span className="who">{e.actor}</span>}
                  {e.claim}
                  {e.anchor && <span className="anc">L{e.anchor}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {step.calls.length > 0 && (
        <section className="sh-sec">
          <h4>工具调用 {step.calls.length} 次 · 原始输入输出完整留存</h4>
          {step.calls.map((c) => (
            <div key={c.id} className={`sh-call ${c.status}`} onClick={() => onExcerpt(c.id, null, c.toolName)}>
              <div className="ch">
                <b>#{c.callNumber}</b>
                {c.toolName}
                <span className={`origin ${c.origin}`}>{c.origin === 'operator' ? '人工' : 'agent'}</span>
                {gateLabel(c.gate) && <span className="gated">{gateLabel(c.gate)}</span>}
                {callStatusLabel(c.status) && <span className={`cs ${c.status}`}>{callStatusLabel(c.status)}</span>}
                <span className="lines">{c.outputLines} 行</span>
              </div>
              <pre>{c.outputPreview}</pre>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function laneWord(laneId: string, lane: string | null) {
  if (lane) return `支线 · 子 agent ${lane.slice(-6)}（它的调用不经过主线的判断）`;
  return laneId === 'trunk' ? '主干' : '分叉 · agent 自己声明的一条';
}

/**
 * 跑完的是多数，不标。其余三种都要写出来：一次查不到东西，原因常常是它压根没跑成，
 * 而不是"这里确实没有数据"——这两件事在报告里的分量完全不同。
 */
function callStatusLabel(status: string) {
  return ({ pending: '进行中', failed: '失败', abandoned: '已放弃' } as Record<string, string>)[status];
}

/**
 * 自动放行的是多数（`auto`），标出来只会成噪声；其余都要在节点上留痕。
 *
 * **两种拒必须分得开**：`auto_deny` 是 backend 那侧按后果判的，人根本没被问到——
 * 写成同一个「被拒」的话，读的人会以为那是自己当时拦的（ui.md §8.1）。
 */
function gateLabel(gate: CallNode['gate']) {
  return (
    {
      allow: '已放行',
      rewrite: '参数被改写',
      deny: '被你拒了',
      auto_deny: '被自动拒了',
      timeout: '自动放行',
    } as Record<string, string>
  )[gate ?? ''];
}
