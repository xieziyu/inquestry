/**
 * 两条时间线与报告章节的投影查询。
 * 报告的每一栏都对应下面某一条 SQL——agent 只写未决型的「下一步怎么查」，其余是投影（D17）。
 */

import { z } from 'zod';

import type { Db } from './database.js';
import { capRoster, METRIC_BOUNDS, METRICS_MAX, type Metric, type Roster } from '../../shared/ipc.js';

export type InvestigationRow = {
  ordinal: number;
  step_id: string;
  kind: string;
  status: string;
  direction: string | null;
  verdict_text: string | null;
  superseded_by: string | null;
  calls: number;
  evidence: number;
};

export type IncidentRow = {
  occurred_at_ms: number;
  occurred_at_raw: string | null;
  actor: string | null;
  claim: string;
  step_id: string;
  step_status: string;
  tool_call_id: string;
  anchor: string | null;
  anchor_resolved: string | null;
  output_sha256: string | null;
};

/** 排查时间线：我按什么顺序做了什么。 */
export function investigationTimeline(db: Db, sessionId: string): InvestigationRow[] {
  return db
    .prepare(
      `SELECT s.ordinal, s.id AS step_id, s.kind, s.status, s.direction, s.verdict_text, s.superseded_by,
              (SELECT COUNT(*) FROM tool_calls tc WHERE tc.step_id=s.id) AS calls,
              (SELECT COUNT(*) FROM evidence_refs e WHERE e.step_id=s.id) AS evidence
       FROM steps s WHERE s.session_id=? ORDER BY s.ordinal`,
    )
    .all(sessionId) as InvestigationRow[];
}

/**
 * 系统时间线：系统当时到底发生了什么。
 *
 * **不按 step.status 过滤。** 结论可以被推翻，事实不会——被 superseded 的 step
 * 查到的证据照样是真实发生过的事件（data-model.md §3）。step_status 只带出来供 UI 标注。
 */
export function incidentTimeline(db: Db, caseId: string): IncidentRow[] {
  return db
    .prepare(
      `SELECT e.occurred_at_ms, e.occurred_at_raw, e.actor, e.claim, e.step_id,
              st.status AS step_status, e.tool_call_id, e.anchor, e.anchor_resolved, tc.output_sha256
       FROM evidence_refs e
       JOIN steps st ON st.id = e.step_id
       JOIN sessions se ON se.id = st.session_id
       JOIN tool_calls tc ON tc.id = e.tool_call_id
       WHERE se.case_id = ? AND e.occurred_at_ms IS NOT NULL
       ORDER BY e.occurred_at_ms`,
    )
    .all(caseId) as IncidentRow[];
}

export type CaseRow = {
  id: string;
  title: string;
  status: 'open' | 'closed' | 'aborted';
  updated_at: number;
  /**
   * 这次调查**真的跑过没有**（有没有开过会话）。SQLite 给 0/1。
   *
   * 列表上那句状态一度是按「main 还持有它的运行时」（`CaseBrief.loaded`）说的，已推翻：
   * 那是内存里的事实，不是调查的状态——一个点开看过一眼、一轮都没跑过的调查会被读成
   * 「已停止」，而它点进去写的是「待开始」；反过来一个真跑过又被限流降级掉的调查
   * 会读成「未打开」。两种都不报错，只是那一栏在说一件没发生过的事。
   */
  started: number;
};

// 表别名固定为 c：三个调用点都要能把它拼进带 JOIN / 子查询的语句里而不歧义
const CASE_ORDER = `ORDER BY (c.status='open') DESC, c.updated_at DESC`;
/**
 * 一行调查的公共列。**三处查询共用这一串**（最近列表 / 钉住的补查 / 检索命中）：
 * 各写各的话，加一列只加进其中两处，第三处那一列会安静地是 `undefined`——
 * 而 `started` 这种布尔列 undefined 之后读出来正好是"没跑过"，与真值反着。
 */
const CASE_COLS = `c.id, c.title, c.status, c.updated_at,
  EXISTS(SELECT 1 FROM sessions se WHERE se.case_id = c.id) AS started`;
const byCaseOrder = (a: CaseRow, b: CaseRow) =>
  Number(b.status === 'open') - Number(a.status === 'open') || b.updated_at - a.updated_at;

/**
 * 首页最近列表的库侧一半（D28）：进行中的排在前面，同档按最近活动倒序。
 * 「运行中 / 等你 N」是运行时状态，库里没有，由 main 合上去。
 *
 * `pinned` 里的调查**一定在结果里**，哪怕排在 limit 之外。它装的是 main 还持有运行时的那些，
 * 而待办只存在于运行时里：被 limit 截掉的话，那次调查会连同它「等你 N」一起从首页那份列表
 * 和全局汇总里消失——人看不见，也切不回去处理，正好废掉 D28 要保的东西。
 */
export function caseList(db: Db, opts: { limit?: number; pinned?: string[] } = {}): CaseRow[] {
  const rows = db
    .prepare(`SELECT ${CASE_COLS} FROM cases c ${CASE_ORDER} LIMIT ?`)
    .all(opts.limit ?? 20) as CaseRow[];

  const have = new Set(rows.map((r) => r.id));
  const missing = (opts.pinned ?? []).filter((id) => !have.has(id));
  if (!missing.length) return rows;

  const extra = db
    .prepare(
      `SELECT ${CASE_COLS} FROM cases c
       WHERE c.id IN (${missing.map(() => '?').join(',')})`,
    )
    .all(...missing) as CaseRow[];
  return [...rows, ...extra].sort(byCaseOrder);
}

export type CasePageRow = CaseRow & {
  project_root: string | null;
  incident_date: string;
  verdict_shape: string | null;
  steps: number;
  headline: string | null;
};

/**
 * 历史调查页那一页（ui.md §8.3）。**与 `caseList` 分开的两条路**：
 * 那一条给的是首页那 20 条，每 60ms 随快照推一遍；这一条带筛选与分页，
 * 只在那一页开着时跑一次，所以负担得起每行再算步数与结论。
 *
 * `headline` 取的是**当前生效**那条结论：排除已被推翻的，按会话先后取最新一条。
 * 与报告那几栏共用 `CHRONO_DESC` 的排序理由——只按 `ordinal` 排会让旧会话的结论压过新的。
 * ⚠️ 它只是列表上的一句摘要，**不是报告认定的根因**：那一条由 `reportSections()` 独家选，
 * 在这儿另起一条选择器去凑"更准的根因"就等于让两处指着不同的步。
 */
export function casePage(
  db: Db,
  opts: { status?: 'all' | 'open' | 'closed' | 'aborted'; limit?: number; offset?: number } = {},
): { rows: CasePageRow[]; total: number } {
  const status = opts.status && opts.status !== 'all' ? opts.status : null;
  const where = status ? `WHERE c.status = ?` : '';
  const args = status ? [status] : [];

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM cases c ${where}`).get(...args) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT ${CASE_COLS}, c.project_root, c.incident_date, c.verdict_shape,
              -- 只数有方向的步：兜底步是 harness 就地开的容器，没有命题也不出卡，
              -- 数进来的话这一栏比人在工作区里数得出的方向多出好几。direction 只有
              -- agent 显式 open_step 时才写，所以它同时排掉了主干与支线两种兜底
              (SELECT COUNT(*) FROM steps s JOIN sessions se ON se.id = s.session_id
                WHERE se.case_id = c.id AND s.direction IS NOT NULL) AS steps,
              (SELECT s.verdict_text FROM steps s JOIN sessions se ON se.id = s.session_id
                WHERE se.case_id = c.id AND s.verdict_text IS NOT NULL AND s.status != 'superseded'
                ORDER BY ${CHRONO_DESC} LIMIT 1) AS headline
         FROM cases c ${where} ${CASE_ORDER} LIMIT ? OFFSET ?`,
    )
    .all(...args, opts.limit ?? 30, opts.offset ?? 0) as CasePageRow[];

  return { rows, total };
}

export type ReportSections = {
  /**
   * 根因那一步。**形态声明也从这里取**（`shape`）：形态说的是"这次调查的根因属于哪一类故障"，
   * 它只能由**报告认定的那条根因**说出来。另起一条选择器（比如"全案最新那条带声明的"）的后果是
   * 一条误填了 shape 的 impact step 就能决定报告装哪几块，而根因与应然实然仍来自另一步——
   * 报告的结构与内容自相矛盾，且毫无报错。这与影响面共用 `effectiveStep` 是同一条纪律。
   */
  rootCause:
    | {
        step_id: string;
        verdict_text: string;
        confidence: number;
        expected: string | null;
        actual: string | null;
        shape: string | null;
      }
    | undefined;
  impact: { verdict_text: string } | undefined;
  /** 影响面那一节里的指标，已解析。影响面步没填、或它还开着时是空数组。 */
  metrics: Metric[];
  /** 名单那一节，见 `effectiveRoster`。 */
  roster: { step_id: string; roster: Roster } | undefined;
  /** 「下一步怎么查」那一栏，见 `effectiveRemediation`。 */
  remediation: { step_id: string; text: string } | undefined;
  leftovers: { step_id: string; direction: string | null; verdict_text: string }[];
  refuted: { step_id: string; direction: string | null; verdict_text: string; superseded_by: string | null }[];
};

const STEP_BASE = `FROM steps s JOIN sessions se ON se.id = s.session_id WHERE se.case_id = ?`;
/**
 * **跨会话的顺序不能只看 `ordinal`**：它是会话内序号，一次调查重开一次就从 1 重来。
 * 只按它排的话，旧会话 ordinal=10 的影响面会压过新会话 ordinal=3 的更新结论，
 * 报告静静地展示过期信息。凡是要「最新那条」的章节都得先按会话先后排。
 */
const CHRONO = `se.started_at, se.rowid, s.ordinal`;
const CHRONO_DESC = `se.started_at DESC, se.rowid DESC, s.ordinal DESC`;

export type EffectiveStep = {
  step_id: string;
  status: string;
  verdict_text: string | null;
  /** 影响面那一节的指标，JSON 串（`shared/ipc.ts` 的 `Metric[]`）。别的 kind 上恒为 null。 */
  metrics: string | null;
};

/**
 * 某一 kind **当前生效**的那一步：失去出处的一律排掉，取时间上最新的一条。
 *
 * 定稿校验与报告章节必须共用这一条规则，否则两边各算各的：
 * 「历史上出现过一个收好的影响面」会放行定稿，而报告取的是最新那条——
 * 那可能是 agent 正在重做、还没 close 的空壳，于是影响面栏是空的。
 *
 * 🔴 **`refuted` 与 `superseded` 一起排掉**，与 `effectiveRemediation` 同一条：
 * 前者的假设自己被否掉了，后者被后来的 step 顶掉了，两种情况下那一步都不再是
 * 「当前生效的影响面 / 遗留问题」。一度只排 `superseded`，于是一个被否掉的影响面步
 * 既放行定稿、又把结论连同 `metrics` 一起印进报告——**而 `metrics` 走 COALESCE，
 * 重新 close 成 `refuted` 时它照旧留在库里**，于是报告上会是「一段被推翻的话 +
 * 一组仍按旧口径算的数」，两者各自看都自洽。
 *
 * 代价是影响面步被 close 成 `refuted` 时定稿闸会重新报缺，agent 未必知道为什么——
 * 所以写入侧当场说一句（`closingStepWarnings`）。
 */
export function effectiveStep(db: Db, caseId: string, kind: string): EffectiveStep | undefined {
  return db
    .prepare(
      `SELECT s.id AS step_id, s.status, s.verdict_text, s.metrics ${STEP_BASE}
         AND s.kind=? AND s.status NOT IN ('superseded','refuted')
       ORDER BY ${CHRONO_DESC} LIMIT 1`,
    )
    .get(caseId, kind) as EffectiveStep | undefined;
}

/** 有几条证据落到了系统时间线上 —— 没人声明形态时，它决定时序型装不装得出来。 */
export function timestampedEvidenceCount(db: Db, caseId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) c FROM evidence_refs e
         JOIN steps s ON s.id = e.step_id
         JOIN sessions se ON se.id = s.session_id
         WHERE se.case_id=? AND e.occurred_at_ms IS NOT NULL`,
      )
      .get(caseId) as { c: number }
  ).c;
}

/**
 * 报告「下一步怎么查」那一栏（overview §6.1）：**leftover 步上最新一条仍然成立的声明**。
 *
 * 它是报告里唯一由 agent 生成的内容，所以只能从 step 上取——`close_step` 的 `remediation`
 * 挂在汇总遗留问题的那一步上，建议是基于「还有什么没查清」给的。
 *
 * **只认 kind='leftover'，且这一节只进未决型报告**（装不装在 shared/report.ts 判）：
 * 查出根因的调查不再留修复建议——排查 agent 没有修复语境，一条自信但偏了的方案会锚定
 * 动手修的人；而「没查出来，下一步先加哪些观测」只有排查过的它给得出来。不限 kind 的话，
 * 根因步上残留的修复方案会顶掉 leftover 步上的续查方向（case_1baca6bb 真发生过）。
 *
 * 排除 `superseded` 与 `refuted`：前者的判断被后来的 step 顶掉了，后者的假设自己被否掉了，
 * 两种情况下那条建议都失去了出处。留着它报告里会躺一条基于作废判断的建议，且毫无报错。
 */
/**
 * 名单那一节（overview.md 的「产出物」）：**最新那条仍然成立的声明**。
 *
 * 只认 `confirmed`——名单是这次调查的答案，而被推翻、没查清、还开着的那些结论交不出答案。
 * 这一条同时把 `superseded` 与 `refuted` 排掉了，理由与 `effectiveRemediation` 相同：
 * 那条声明失去了出处，留着报告里会躺一份基于作废判断的名单，且毫无报错。
 *
 * **不认 kind。** 与「下一步怎么查」不同，名单没有一个会顶掉它的同类字段：
 * 「受影响的订单」落在影响面那一步上、「关联的小号」落在普通排查步上，都同样正当。
 *
 * 坏 JSON 当作没有：库里这一列由写入侧 `JSON.stringify` 落，读不出来说明有人手改过库，
 * 那时静静少一节远好过让整个快照抛错（报告屏、导出、定稿闸全走这一条）。
 */
export function effectiveRoster(
  db: Db,
  caseId: string,
): { step_id: string; roster: Roster } | undefined {
  const row = db
    .prepare(
      `SELECT s.id AS step_id, s.roster AS json ${STEP_BASE}
         AND s.roster IS NOT NULL AND s.status='confirmed'
       ORDER BY ${CHRONO_DESC} LIMIT 1`,
    )
    .get(caseId) as { step_id: string; json: string } | undefined;
  if (!row) return undefined;
  const roster = readColumn(row.json, STORED_ROSTER, `${row.step_id}.roster`);
  // 🔴 **读侧也要拦上限，且用的是写入侧那一份规则**（`capRoster`）：
  // `seed-cases` 与任何直接发 `step.closed` 的路径压根不经过 `normalizeRoster`，
  // 只在写入侧拦的话，库里那份无界的名单照旧一路进快照、进报告、把长图导出撑断
  return roster ? { step_id: row.step_id, roster: capRoster(roster) } : undefined;
}

/**
 * 产出物那两列**在库里的**形状。与 `tools/schemas.ts` 那两份**不是同一个契约**，
 * 别合并：那边是 agent 的入参（带 `.describe`、带 trim、没有 `truncated`），
 * 这边是投影的形状（`truncated` 由 harness 加，条目已经归一过）。
 *
 * 🔴 **语法合法不等于形状合法。** 上游一度只 `JSON.parse` 加一个 `as Roster`：
 * 一份 `{"items":[{"id":"u1"}]}`（手工修库、半截写入、或**将来改了字段之后重放老事件**）
 * 解析得出来、`items` 也非空，于是一路放行到 `reportPlan` 对 `undefined` 调 `.trim()`——
 * **报告屏、Markdown 与长图三个出口一起抛**，而库里那一行看着好好的。
 * 这与 `checkEventShapes` 是同一条纪律，只是换到了读的这一头。
 */
const STORED_ROSTER = z.object({
  label: z.string(),
  idKind: z.string(),
  complete: z.boolean(),
  basis: z.string(),
  // 空名单按没有算，与写入侧那一条一致
  items: z.array(z.object({ id: z.string(), note: z.string().optional() })).min(1),
  // 负数与小数是结构上就不可能的值，按坏列降级；`0` 放行，`capRoster` 会把它当没截过收掉。
  // 「截过就不可能是全集」那条不在这儿拦——拦了的话，一份 300 条的好名单会因为
  // 一个写错的 complete 整份消失，而 `capRoster` 把它改对的代价是零
  truncated: z.number().int().nonnegative().optional(),
});

/**
 * 指标**超上限就整列不要**，不像名单那样截断——理由见 `shared/ipc.ts` 的 `METRICS_MAX`：
 * 它是 agent 亲手写的一张表，条数完全由它定，超了说明写法就不对，没有"保住一部分"的意义。
 * 库里出现这种值只可能来自手工修库或不走归一的写入，那时按读不出来处理最省事，
 * 而 `readColumn` 会把哪一步的哪一列喊出来。
 */
const STORED_METRICS = z
  .array(
    z.object({
      label: z.string(),
      value: z.string(),
      bound: z.enum(METRIC_BOUNDS),
      basis: z.string(),
    }),
  )
  .max(METRICS_MAX);

/**
 * 已经喊过的那几列，**按 step 与列名记**。
 *
 * `reportSections` 是每次快照都跑的（60ms 合流一次），不记的话一行坏数据会把终端刷满，
 * 而真正要人看见的是"哪一步的哪一列坏了"这一句——刷屏之后它反而没人看得见。
 */
const complained = new Set<string>();

/**
 * 读一列存着 JSON 的产出物：**语法或形状不对就当作没有**，并且喊一声（每列只喊一次）。
 *
 * 不抛：整个快照、定稿闸与两种导出都挂在这几条查询上，为一行坏数据让 app 打不开，
 * 比少一节严重得多。但也不能静静吞掉——`where` 里带上 step 与列名，好让人回库里去看那一行。
 */
function readColumn<T>(json: string | null, schema: z.ZodType<T>, where: string): T | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return complain(where, '不是合法 JSON');
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : complain(where, parsed.error.issues[0]?.message ?? '形状不对');
}

function complain(where: string, why: string): null {
  if (!complained.has(where)) {
    complained.add(where);
    console.warn(`[db] ${where} 读不出来（${why}），这一节按没有处理`);
  }
  return null;
}

export function effectiveRemediation(db: Db, caseId: string): { step_id: string; text: string } | undefined {
  const row = db
    .prepare(
      `SELECT s.id AS step_id, s.remediation AS text ${STEP_BASE}
         AND s.kind='leftover'
         AND s.remediation IS NOT NULL AND TRIM(s.remediation) <> ''
         AND s.status NOT IN ('superseded','refuted')
       ORDER BY ${CHRONO_DESC} LIMIT 1`,
    )
    .get(caseId) as { step_id: string; text: string } | undefined;
  return row;
}

export function reportSections(db: Db, caseId: string): ReportSections {
  const q = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
  const base = STEP_BASE;
  const chrono = CHRONO;
  const chronoDesc = CHRONO_DESC;
  // 影响面取当前生效的那一步，且**必须已经收尾**——还开着的那条 verdict 是空的，
  // 印出来就是一栏空白；而定稿校验用的是同一个函数，两边不会各说各话
  const impact = effectiveStep(db, caseId, 'impact');
  return {
    rootCause: q<ReportSections['rootCause'] & object>(
      `SELECT s.id AS step_id, s.verdict_text, s.verdict_confidence AS confidence,
              s.expected, s.actual, s.shape ${base}
         AND s.status='confirmed' AND s.kind='normal'
       ORDER BY s.verdict_confidence DESC, ${chronoDesc} LIMIT 1`,
      caseId,
    )[0],
    impact: impact && impact.status !== 'open' ? { verdict_text: impact.verdict_text ?? '' } : undefined,
    // 指标与它上面那段散文**同出一步**：各取各的选择器就会出现「数是新那次量的、
    // 话还是上一次写的」，而两边看着都自洽。还开着的那一步同样不取，理由见 `impact`
    metrics:
      impact && impact.status !== 'open'
        ? (readColumn(impact.metrics, STORED_METRICS, `${impact.step_id}.metrics`) ?? [])
        : [],
    roster: effectiveRoster(db, caseId),
    remediation: effectiveRemediation(db, caseId),
    leftovers: q(
      `SELECT s.id AS step_id, s.direction, s.verdict_text ${base}
         AND s.status='inconclusive' ORDER BY ${chrono}`,
      caseId,
    ),
    refuted: q(
      `SELECT s.id AS step_id, s.direction, s.verdict_text, s.superseded_by ${base}
         AND s.status IN ('refuted','superseded') ORDER BY ${chrono}`,
      caseId,
    ),
  };
}

export type NarrativeHit = { ref_id: string; ref_kind: string; case_id: string; text: string };

/**
 * 一次检索最多搬回多少条命中。
 *
 * 🔴 **没有它时，主导成本不是扫描而是"把命中全搬回来"**（实测 5 万行的表，一个常见词
 * 走 MATCH 走出 5 万行、30ms 全在 main 线程上；加了 LIMIT 之后 0.2ms）。
 * 而这条查询是**人每打一个字就跑一次**的同步 IPC，对话带越攒越长，代价只增不减。
 *
 * 截断的代价是"常见词只看得到前 N 条命中里出现过的调查"，这是检索框的正常契约；
 * 而它换来的是**代价与库的大小脱钩**。取值远大于首页那 20 行，
 * 好让归并之后仍有足够多的调查可排。
 */
export const MAX_HITS = 2000;

/**
 * 跨 case 检索。中文查询串 <3 字时 trigram 的 MATCH 不成立，回退 LIKE
 * ——trigram 索引本身支持 LIKE，不是全表扫（data-model.md §5）。
 *
 * **两条路的分界只此一处。** 上层（`searchCases`）按 case 归并，不再自己判长度：
 * 各判各的话，2 字与 3 字的查询会走出两套不同的结果，而人只会以为"这个词搜不到"。
 *
 * 🔴 **`ESCAPE` 子句会把 trigram 的 LIKE 优化整个关掉**（实测：`INDEX 0:L3` 变成
 * `INDEX 0:`，一次罕见词查询从 0.1ms 涨到 5.1ms，且随表增长）。所以只在查询串**真的
 * 含通配符**时才带它——那种查询很少，慢一点认了；其余一律走得到索引的那条路。
 * 不能一律不带：`%` `_` 是通配符，搜一个 `_` 会把全部调查翻出来。
 */
export function searchNarrative(db: Db, term: string): NarrativeHit[] {
  const t = term.trim();
  const cols = `SELECT ref_id, ref_kind, case_id, text FROM narrative_fts`;
  // 按 code point 数，**不是 `String.length`**：emoji 与 CJK 扩展区的字各占两个 UTF-16 单元，
  // 两个这样的字会被当成够 3 字走 MATCH，而 trigram 那侧数的是字符——原文在库里也搜不出来
  if ([...t].length >= 3) {
    return db
      .prepare(`${cols} WHERE narrative_fts MATCH ? LIMIT ?`)
      .all(`"${t.replace(/"/g, '')}"`, MAX_HITS) as NarrativeHit[];
  }
  const wild = /[\\%_]/.test(t);
  return wild
    ? (db
        .prepare(`${cols} WHERE text LIKE ? ESCAPE '\\' LIMIT ?`)
        .all(`%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, MAX_HITS) as NarrativeHit[])
    : (db.prepare(`${cols} WHERE text LIKE ? LIMIT ?`).all(`%${t}%`, MAX_HITS) as NarrativeHit[]);
}

/**
 * 命中出自哪一类文本。**顺序就是优先级**：找旧调查的心智是"上次那个从库延迟的"，
 * 而人记得的多半是自己写的问题，其次才是最后的结论；对话带排最后——它最长也最杂，
 * 拿它当摘要，一屏结果里全是"好的，我这就查"。
 */
const HIT_KINDS = ['case', 'verdict', 'direction', 'evidence', 'lane', 'chat'] as const;
export type HitKind = (typeof HIT_KINDS)[number];

const hitKind = (refKind: string): HitKind =>
  refKind.startsWith('chat') ? 'chat' : ((HIT_KINDS as readonly string[]).includes(refKind) ? (refKind as HitKind) : 'evidence');

export type CaseSearchRow = CaseRow & { hits: number; snippet: string; where: HitKind };

/** 摘要窗口。太长会把那一行撑破（列表上它只占一行，超出即省略号），太短则看不出为什么命中。 */
const SNIPPET = 60;

/** 摘要**要围着命中处取**：从头截 60 字的话，命中在第 200 字的那条看着像没命中。 */
function snippetAround(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
  const from = Math.max(0, at - Math.floor((SNIPPET - term.length) / 2));
  const cut = text.slice(from, from + SNIPPET);
  return `${from > 0 ? '…' : ''}${cut}${from + SNIPPET < text.length ? '…' : ''}`;
}

/**
 * 历史调查页上的检索（ui.md §8.3）：把 `narrative_fts` 的命中按 case 归并。
 *
 * **排序与 `caseList` 同一条规则**（进行中的在前、同档按最近活动倒序），不按命中条数排：
 * 两处各排各的话，同一次调查在"最近 20 个"里排第一、搜出来却排第七，人会以为搜到的是另一个。
 * 命中条数只作为附带信息给出来，不参与排序。
 *
 * 归并要**在 JS 里做**而不是 `GROUP BY`：摘要得挑优先级最高的那一条，
 * 而 SQL 的聚合给不出"这一组里按另一套顺序排第一的那行"。
 */
export function searchCases(db: Db, term: string, opts: { limit?: number } = {}): CaseSearchRow[] {
  const t = term.trim();
  if (!t) return [];
  const best = new Map<string, { hits: number; row: NarrativeHit; kind: HitKind }>();
  for (const hit of searchNarrative(db, t)) {
    const kind = hitKind(hit.ref_kind);
    const cur = best.get(hit.case_id);
    if (!cur) best.set(hit.case_id, { hits: 1, row: hit, kind });
    else {
      cur.hits += 1;
      if (HIT_KINDS.indexOf(kind) < HIT_KINDS.indexOf(cur.kind)) {
        cur.row = hit;
        cur.kind = kind;
      }
    }
  }
  if (!best.size) return [];

  // 调查数被 `MAX_HITS` 顶死（一条命中最多贡献一次调查），所以这串占位符不会撞上
  // SQLite 的变量上限——上限那一头不必再单独截，截了反而是按 Map 的插入顺序丢调查
  const ids = [...best.keys()];
  // INNER JOIN 是有意的：`narrative_fts` 上没有外键，指不到 `cases` 的命中就是脏索引，
  // 拿它渲染出的 chip 点下去会切到一个不存在的调查（`switchTo` 回 false，界面一动不动）
  const rows = db
    .prepare(
      `SELECT ${CASE_COLS} FROM cases c WHERE c.id IN (${ids.map(() => '?').join(',')}) ${CASE_ORDER}`,
    )
    .all(...ids) as CaseRow[];

  return rows.slice(0, opts.limit ?? 20).map((c) => {
    const hit = best.get(c.id)!;
    return { ...c, hits: hit.hits, snippet: snippetAround(hit.row.text, t), where: hit.kind };
  });
}
