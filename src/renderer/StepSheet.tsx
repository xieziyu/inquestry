import { useEffect, useState } from 'react';
import type { CallNode, CaseMeta, ChatLine } from '../shared/ipc.js';
import type { StageBox } from './track.js';
import { directionText } from './track.js';
import { kindLabel, sayLabel, statusLabel } from './Stage.js';
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
  stray,
  liveLanes,
  aside,
  onClose,
  onExcerpt,
  onStopLane,
  onGo,
  step,
  canStep,
}: {
  box: StageBox;
  meta: CaseMeta;
  /**
   * 不属于任何方向的那几次调用（`unassignedCalls`）。**这儿是它们唯一读得到的地方**：
   * 兜底步不出卡、报告也不列它，卡面那条带子只报个数。
   */
  stray: CallNode[];
  liveLanes: string[];
  /**
   * 点开的是一句旁白时，它所在的那一组。**由舞台那侧按 `ownerId` 取好送进来**——
   * 归属只在 `weaveChat` 算一次，这儿再算一遍的话两处迟早对不上，而对不上时不报错。
   */
  aside: { at: string; lines: ChatLine[]; currentId: string; onPick: (id: string) => void } | null;
  onClose: () => void;
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
  onStopLane: (lane: string) => void;
  /** 跳到别的一步（承接的那一步 / 推翻它的那一步）。 */
  onGo: (id: string) => void;
  step: (dir: 1 | -1) => void;
  canStep: (dir: 1 | -1) => boolean;
}) {
  /**
   * 尾卡的"全文"是报告屏那一整页，所以它不开浮层（点它直接过去）。
   *
   * **旁白开**：浮层不是"节点的特权"，是"逐字读的那一档"——画布上那一份恒裁到三行，
   * 这儿是全 app 唯一读得到一句长旁白全文的地方。它只是没有证据与调用，
   * 所以进来时不带序号、也不带上一步/下一步。
   */
  if (box.kind === 'tail' || box.kind === 'group') return null;
  const say = box.kind === 'say' ? aside : null;
  if (box.kind === 'say' && !say) return null;

  return (
    <aside className="stepsheet">
      <div className="sh-head">
        {say ? (
          <>
            <span className="ord">旁白</span>
            <span className="kind">{say.at}</span>
            <span className="dim">共 {say.lines.length} 轮</span>
          </>
        ) : box.kind === 'case' ? (
          <>
            <span className="ord">信息卡</span>
            <span className="kind">这次调查的由来</span>
          </>
        ) : box.kind === 'step' ? (
          <>
            <span className="ord">{box.row.label}</span>
            <span className="kind">{kindLabel(box.row.step.kind, box.row.step.lane)}</span>
            <span className={`state ${box.row.step.status}`}>{statusLabel(box.row.step.status)}</span>
          </>
        ) : null}
        <button className="x" title="关闭（Esc）" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="sh-body">
        {say ? (
          <SayGroupBody group={say} />
        ) : box.kind === 'case' ? (
          <CaseBody meta={meta} stray={stray} onExcerpt={onExcerpt} />
        ) : box.kind === 'step' ? (
          <StepBody box={box} onExcerpt={onExcerpt} onGo={onGo} liveLanes={liveLanes} onStopLane={onStopLane} />
        ) : null}
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

/**
 * 一组旁白：被点那句全文在上，同组其余在下、点一条换一条。
 *
 * **不给序号**（序号是节点的），也**不做「上一句 / 下一句」**——组内点选已经覆盖了它要解决的事。
 * 也不必再标"哪几句在画布上被折叠掉了"：能点进来就说明这一组是展开着的，
 * 每一句都在画布上，只是各自裁到了三行。
 */
function SayGroupBody({
  group,
}: {
  group: { at: string; lines: ChatLine[]; currentId: string; onPick: (id: string) => void };
}) {
  const cur = group.lines.find((l) => l.id === group.currentId) ?? group.lines[0];
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  // 复制成功那一下退回原样，失败的留着——那句话人得看见（同回填卡上那枚）
  useEffect(() => {
    if (copied !== 'ok') return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => setCopied(null), [group.currentId]);
  if (!cur) return null;
  return (
    <>
      <section className="sh-sec">
        <h4>它说了什么</h4>
        <p className="sh-quote">{cur.text}</p>
        <div className="sh-act">
          <button
            onClick={() =>
              void navigator.clipboard.writeText(cur.text).then(
                () => setCopied('ok'),
                () => setCopied('fail'),
              )
            }
          >
            {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制这句'}
          </button>
        </div>
      </section>

      {group.lines.length > 1 && (
        <section className="sh-sec">
          <h4>这一组 {group.lines.length} 轮 · 点一条换一条</h4>
          <ul className="sh-aside">
            {group.lines.map((l) => (
              <li key={l.id} className={l.id === cur.id ? 'cur' : ''} onClick={() => group.onPick(l.id)}>
                <span className="who">{sayLabel(l.role)}</span>
                <span className="t">{l.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function CaseBody({
  meta,
  stray,
  onExcerpt,
}: {
  meta: CaseMeta;
  stray: CallNode[];
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
}) {
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

      {/* 那几次不属于任何方向的调用。**开场摸底与收尾杂务混在一起，不去猜是哪一类**：
          它们的共同点只有"发生时没有开着的步"，按时刻分成两段就是替 agent 编一个意图 */}
      {stray.length > 0 && (
        <section className="sh-sec">
          <h4>不属于任何方向的调用 {stray.length} 次 · 原始输入输出完整留存</h4>
          {/* 「还说不出假设，先摸一眼」与收尾时那几发都落在这儿——它们不是一个排查方向，
              但确实发生过，所以留得住、找得到 */}
          <CallList calls={stray} onExcerpt={onExcerpt} />
        </section>
      )}
    </>
  );
}

/** 一串工具调用。**step 卡与信息卡共用这一份**：两处各写一遍的话，一处加了标记另一处不会有。 */
function CallList({
  calls,
  onExcerpt,
}: {
  calls: CallNode[];
  onExcerpt: (callId: string, anchor: string | null, title: string) => void;
}) {
  return (
    <>
      {calls.map((c) => (
        <div key={c.id} className={`sh-call ${c.status}`} onClick={() => onExcerpt(c.id, null, c.toolName)}>
          <div className="ch">
            <b>#{c.callNumber}</b>
            {c.toolName}
            <span className={`origin ${c.origin}`}>{c.origin === 'operator' ? '人工' : 'agent'}</span>
            {gateLabel(c.gate) && <span className="gated">{gateLabel(c.gate)}</span>}
            {callStatusLabel(c.status, c.gate) && (
              <span className={`cs ${c.status}`}>{callStatusLabel(c.status, c.gate)}</span>
            )}
            <span className="lines">{c.outputLines} 行</span>
          </div>
          <pre>{c.outputPreview}</pre>
        </div>
      ))}
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
          <CallList calls={step.calls} onExcerpt={onExcerpt} />
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
 * 跑完的是多数，不标。其余几种都要写出来：一次查不到东西，原因常常是它压根没跑成，
 * 而不是"这里确实没有数据"——这两件事在报告里的分量完全不同。
 *
 * `denied` 分两种出处，**同一个标签写两遍就成了同一件事的两个说法**：闸门拦下的那些
 * `gateLabel` 已经写过了，这里只认另一种——人在回填卡上拒了这条查询。
 *
 * 🔴 让位的条件是**`gateLabel` 这次到底写没写**，不是"有没有闸门判决"：每次调用都带着
 * 判决进库（没人问到的记 `auto`），按后者判的话这个标签在真实数据上一次都不会出现，
 * 而那次调用在详情页里与跑成功的长得一模一样。两处各写一份 key 集合同样不行——
 * 迟早对不上，且对不上时不报错。
 */
export function callStatusLabel(status: string, gate: CallNode['gate']) {
  if (status === 'denied') return gateLabel(gate) ? undefined : '你拒绝执行';
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
