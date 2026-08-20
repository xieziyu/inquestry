import type { TailSummary } from '../shared/report.js';
import { SHAPE_COPY } from '../shared/report.js';
import type { StageBox } from './track.js';
import { Icon } from './Icon.js';

/**
 * 收束卡：舞台上主干的**尾**，与信息卡（头）一对。
 *
 * 它回答的是「这次调查停在哪儿」。在它出现之前，画布最低的东西永远是一句旁白——
 * 而旁白按分工只做索引和判断（overview.md §1.2），让它当终点等于把调查的结论
 * 交给一段可以说错的话。更实在的一条：agent 收尾时那句「影响面和遗留问题都收了、
 * 定稿闸是通的」，逐字都是 harness 自己看得见的状态，它之所以要说，
 * 正是因为舞台上没有任何东西把这件事说出来。
 *
 * 🔴 **卡上一个字都不是生成的**，全部来自 `tailSummary()` 的投影（D17）。
 * 尤其是根因那一条：装不装由 `reportedRootCause()` 判，与报告屏同一条规则——
 * 在这儿另写一遍的话，归档的调查会在舞台上顶着一条报告里根本不印的根因。
 *
 * 🔴 **高度是定额**（`TAIL_VERDICT_LINES`），与卡上这会儿有没有根因无关。
 * 尾卡自己可以随主干下移，但它不许**长高**：长高就等于把旁白那一栏往上挤，
 * 而那些是已经落笔的东西。
 *
 * 它**没有详情浮层**：这张卡的"全文"就是报告屏，所以点它直接过去。
 */
export function TailCard({
  box,
  tail,
  onReport,
}: {
  box: Extract<StageBox, { kind: 'tail' }>;
  tail: TailSummary;
  onReport: () => void;
}) {
  const state = stateLabel(tail);
  return (
    <section
      // 状态类带 `tail-` 前缀：裸的 `open` 会撞上 `.s-card.open` 那条给 step 用的左边框色
      className={`s-card tailcard tail-${tail.status}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button')) onReport();
      }}
    >
      <div className="c-head">
        <span className="ord">收束</span>
        <span className="kind" title={shapeTitle(tail)}>
          {SHAPE_COPY[tail.shape].label}
        </span>
        <span className={`state ${state.tone}`}>{state.text}</span>
      </div>

      {/* 有根因就印根因，没有就印**为什么没有**——留一块白读起来像是漏了一段。
          `minHeight` 与 clamp 用的是同一个行数：只裁不撑的话，根因只有一行时
          下面的记号行与按钮会整体上浮，卡底空出一整行（高度是定死的，浮上去就是块白） */}
      <p
        className={`t-vd${tail.rootCause ? '' : ' none'}`}
        style={{ WebkitLineClamp: box.vdLines, minHeight: box.vdLines * 19 } as React.CSSProperties}
      >
        {tail.rootCause?.text ?? tail.why}
      </p>

      {/* 三个记号说的是**定稿闸**，不是"调查进度"：分母恒为二，就是 overview §6.2
          那两个固定动作。写成「3/7」那样的话，等于在暗示一个并不存在的总步数 */}
      <div className="t-gaps">
        <span className={tail.gaps.includes('impact') ? 'miss' : ''}>
          影响面 {tail.gaps.includes('impact') ? '缺' : '有'}
        </span>
        <span className={tail.gaps.includes('leftover') ? 'miss' : ''}>
          遗留问题 {tail.gaps.includes('leftover') ? '缺' : `${tail.leftovers} 条`}
        </span>
        {/* 「下一步怎么查」只属于未决型报告（查出根因的报告不留修复建议），别的形态不印这一格；
            照旧只提醒不阻挡：它不进定稿闸，缺了也不用暖色 */}
        {tail.shape === 'open' && <span>下一步怎么查 {tail.hasRemediation ? '有' : '无'}</span>}
      </div>

      <button className="t-report" onClick={onReport}>
        <Icon name="report" />
        看报告
      </button>
    </section>
  );
}

/**
 * 状态词。**「可定稿」与「未定稿」分开写**：闸通没通是这张卡上唯一有下一步动作的信息，
 * 都写成「未定稿」的话，人得自己去数那三个记号。
 *
 * 色调只借用已有的三档，不新造颜色（ui.md §5）：闸没通用暖色——它确实是"还要人动手"。
 *
 * 🔴 **已归档走中性的 `shut`，不许借「被推翻」那一档。** 半程放弃不是推翻，借那个色等于给它
 * 添一层新含义（同一条见 `caseline.tsx` 的 `caseTerminal`，以及卡左边框的 `.tailcard`）。
 */
function stateLabel(tail: TailSummary): { text: string; tone: string } {
  if (tail.status === 'closed') return { text: '已定稿', tone: 'confirmed' };
  if (tail.status === 'aborted') return { text: '已归档', tone: 'shut' };
  return tail.gaps.length
    ? { text: '未定稿', tone: 'inconclusive' }
    : { text: '可定稿', tone: 'open' };
}

/** 形态的出处要说得出口：冻住的那个与"还会变的预选值"是两回事（ui.md §8.4.2）。 */
function shapeTitle(tail: TailSummary) {
  const when = SHAPE_COPY[tail.shape].when;
  if (tail.shapeSource === 'frozen') return `收尾时定的形态：${when}。报告按它装，事后没有入口再改。`;
  const from = tail.shapeSource === 'agent' ? 'agent 声明的' : '没人声明过，按现有数据推的';
  return `${when}。这是预选值（${from}），定稿那一下由你按下去才算数。`;
}
