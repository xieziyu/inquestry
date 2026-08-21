import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { checkEventShapes, rebuildProjections } from './projector.js';
import { PRAGMA_SQL, SCHEMA_SQL } from './schema.js';

/**
 * 9：`evidence_refs.seq` / `steps.closed_seq` —— evidence 全量替换的批次边界（projector.ts 的
 *    `replaceEvidenceBatch`）。两个 nullable 列，值由重放从 `events.seq` 填回来；
 *    **老事件形状没动过**，边界用的是它们天生就有的 seq，所以存量与新数据认的是同一条规则。
 *    这一级顺带把老库里按旧规则（无条件 append）投出来的重复证据重投掉。
 * 8：`steps.roster` / `steps.metrics` —— 产出物（名单与指标，overview.md 的「产出物」）。
 *    两个 nullable 的 JSON 列，老事件里压根没有这两项，重放后照旧是 NULL——additive 的标准形状。
 * 7：`cases.incident_date_source` —— 基准日期是建单猜的还是被确认过的。
 *    默认 `'intake'` 就是老库的真实情况：那时还没有 `case.timebase_set` 这条事件。
 * 6：`steps.remediation` —— 修复建议的写入方（后来收窄成未决型的「下一步怎么查」，只认 leftover 步）。
 *    **第一级真正走重放迁移的升级**：只加一个 nullable 列，老事件形状没动过。
 * 5：`tool_calls.gate_decision` 多一档 `auto_deny`（分类器/规则拒的，人没被问到）
 *    + `chat_lines` 表与事件 `chat.appended` —— 对话带落库，它是唯一重建不出来的东西。
 * 4：`steps.status` 多一档 `converged` + 事件 `lane.converged` —— 支线跑完由 harness 收口（data-model.md 的 `converged` 一节）。
 * 3：`steps.shape` —— agent 声明的报告形态（v2 只有 `cases.verdict_shape` 这个终态）。
 */
export const SCHEMA_VERSION = 9;

export type Db = Database.Database;

/**
 * 一级可重放的升级：**只加东西**（新表 / nullable 列 / 索引），老事件形状没动过。
 * `apply` 里写这一级需要的 DDL，其余交给幂等的 `SCHEMA_SQL` 与一次重放。
 *
 * 索引不必写进步骤：DDL 跑在幂等 `SCHEMA_SQL` **之前**，所以那条依赖新列的
 * `CREATE INDEX` 随 schema 一起建得出来。
 */
export type MigrationStep = {
  to: number;
  /**
   * 这一级新增的列，**声明式的**：DDL 由它生成（`applyStep`），自检也靠它把库降回上一级
   * （`spike:cases` 那段「造一份真的是上一版的库」）。
   *
   * 一度写成一段手写的 `ALTER TABLE`，而自检那边另写一句 `DROP COLUMN` 与它对着——
   * 加下一级时忘了改自检的表现是**它去删一列已经不存在的东西**，报出来的成了
   * 「迁移会失败」而不是「自检过期了」。两处指的既然是同一件事，就只该写一处。
   */
  adds?: { table: string; column: string; ddl: string }[];
  /** 加列之外的 DDL。新表与索引由幂等 `SCHEMA_SQL` 承接，一般用不上这一项。 */
  apply?: (db: Db) => void;
};

/** 跑一级升级：先补列，再跑它自己的 DDL。 */
export function applyStep(db: Db, step: MigrationStep): void {
  for (const c of step.adds ?? []) {
    db.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.ddl}`);
  }
  step.apply?.(db);
}

/**
 * 升级阶梯。v1→v5 每一级都动过 CHECK 约束或字段语义，那类只能重建库，所以阶梯从 v6 起。
 *
 * **只写这一级需要的 DDL**，其余交给幂等的 `SCHEMA_SQL` 与一次重放：`ALTER TABLE` 补出来的
 * 是一个空列，值要靠重放 `step.closed` 才填得回去——而 v5 的老事件里压根没有 `remediation`，
 * 于是它们重放后照旧是 NULL。**这正是 additive 的定义**：老数据不掉、新列由新事件填。
 */
export const MIGRATIONS: MigrationStep[] = [
  { to: 6, adds: [{ table: 'steps', column: 'remediation', ddl: 'TEXT' }] },
  {
    to: 7,
    // 带 DEFAULT 的 NOT NULL 列：老行当场就有了正确的值，不必等重放。
    // 与 SCHEMA_SQL 那份声明必须逐字一致——两处写出不同的可空性，只有在很久以后
    // 某次插入上才会炸，而那时看不出是这里埋的
    adds: [
      {
        table: 'cases',
        column: 'incident_date_source',
        ddl: `TEXT NOT NULL DEFAULT 'intake' CHECK (incident_date_source IN ('intake','agent','operator'))`,
      },
    ],
  },
  {
    to: 8,
    adds: [
      { table: 'steps', column: 'roster', ddl: 'TEXT' },
      { table: 'steps', column: 'metrics', ddl: 'TEXT' },
    ],
  },
  {
    to: 9,
    adds: [
      { table: 'evidence_refs', column: 'seq', ddl: 'INTEGER' },
      { table: 'steps', column: 'closed_seq', ddl: 'INTEGER' },
    ],
  },
];

type Upgrade =
  | { kind: 'fresh' }
  | { kind: 'archive'; from: number }
  | { kind: 'replay'; from: number; steps: MigrationStep[] };

/**
 * `:memory:` 走内存库（spike 用）。文件库时 blob 目录与库同级：
 * 两者合起来才是真相，缺一半都无法重放。
 *
 * **版本对不上时分两条路**（data-model.md §2）：
 *
 * - 阶梯上每一级都有步骤 → **重放迁移**：补 DDL、按 events 重建投影，调查留在原地
 * - 缺任何一级（或降级、或没打过版本号的老库）→ **挪开重建**，旧库改名留着
 *
 * 顺序是**先体检再动土**：`checkEventShapes` 抛错时这个库一个字节都没被改过，
 * 报错停下远好过一个半迁移的库——后者与一次成功的迁移长得一模一样。
 *
 * `steps` 只有自检会传：生产用内置阶梯，spike 用一级假步骤把这条路真走一遍。
 */
export function openDatabase(file: string, opts: { steps?: MigrationStep[] } = {}): Db {
  const plan = file === ':memory:' ? ({ kind: 'fresh' } as Upgrade) : planUpgrade(file, opts.steps ?? MIGRATIONS);
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true });
    if (plan.kind === 'archive') archive(file, plan.from);
  }
  const db = new Database(file);
  // 连接级设置要在事务之前落定（`journal_mode` 改不进事务里）
  db.exec(PRAGMA_SQL);
  if (plan.kind === 'replay') {
    // **先体检再动土**：这一刻库还一个字节都没被改过。
    // 体检不过 = 有人把一级"其实改了载荷形状"的升级声明成了可重放——那是代码写错了，
    // 不是数据的错。此时**退回挪库**：既不硬迁一半（那与成功的迁移长得一样），
    // 也不让 app 起不来。声明错的代价因此是"这次没迁成"，而不是"迁出一批半残的调查"
    const problem = shapeProblem(db);
    if (problem) {
      db.close();
      archive(file, plan.from);
      console.warn(`[db] v${plan.from} 声明为可重放，实际迁不动，已退回挪库：${problem}`);
      return openFresh(file);
    }
    // DDL 与重放一起走一个事务：中途崩掉时留下的是原样，不是半迁移。
    // `user_version` 也在里面——它没跟着提上去的话，下次启动会再走一遍这条路，
    // 而 `ALTER TABLE ADD COLUMN` 第二次会直接报重复列
    db.transaction(() => {
      // 🔴 **每一级的 DDL 必须跑在幂等 schema 之前。** 反过来的话，一次"加 nullable 列 +
      // 给它建索引"的升级会当场炸在 `SCHEMA_SQL` 自己身上：那条 `CREATE INDEX` 落在还没
      // 补列的旧表上，报 `no such column`，而 `apply` 连跑的机会都没有——
      // 也就是说文档里明写支持的那一类升级，会让 app 起不来
      for (const s of plan.steps) applyStep(db, s);
      db.exec(SCHEMA_SQL);
      rebuildProjections(db, { blobDir: blobDir(file) });
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    console.warn(`[db] schema v${plan.from} → v${SCHEMA_VERSION}：按 events 重放迁移，调查留在原地`);
    return db;
  }
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** 载荷体检的结果：能迁就返回 null，迁不动就返回那句话（含 seq 与缺的键）。 */
function shapeProblem(db: Db): string | null {
  try {
    checkEventShapes(db);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function openFresh(file: string): Db {
  const db = new Database(file);
  db.exec(PRAGMA_SQL);
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** 这一次启动该走哪条路。**只读，不动库**——决定与执行分开，好让自检能单独验它。 */
export function planUpgrade(file: string, steps: MigrationStep[] = MIGRATIONS): Upgrade {
  if (!existsSync(file)) return { kind: 'fresh' };
  const probe = new Database(file, { readonly: true });
  const version = Number(probe.pragma('user_version', { simple: true }));
  // `user_version` 的默认值就是 0，所以 0 既可能是一个空文件，也可能是一个没打过版本号的老库。
  // 靠有没有应用表来分：**有表的 0 号库必须按不兼容处理**——`CREATE TABLE IF NOT EXISTS`
  // 不会给已存在的表补列，放过它只会把老结构标成当前版本，等第一次查新列才炸。
  const populated =
    !!probe
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('events','cases') LIMIT 1`)
      .get();
  probe.close();
  if (version === SCHEMA_VERSION || (version === 0 && !populated)) return { kind: 'fresh' };
  // 0 号老库无从判断，降级（版本比代码新）更没法处理：两种都只能挪开
  if (version === 0 || version > SCHEMA_VERSION) return { kind: 'archive', from: version };

  const path: MigrationStep[] = [];
  for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
    const step = steps.find((s) => s.to === v);
    // **缺一级就整条走不通**：跳过那一级等于把它那几列悄悄留空
    if (!step) return { kind: 'archive', from: version };
    path.push(step);
  }
  return { kind: 'replay', from: version, steps: path };
}

/**
 * 旧库改名让路，不删——调查记录哪怕格式过时也不该被工具自己抹掉。
 * WAL 的两个边车文件必须一起挪走，留下任何一个都会让新库读到半截旧状态。
 */
function archive(file: string, version: number) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(file + suffix)) renameSync(file + suffix, `${file}.v${version}.${stamp}.bak${suffix}`);
  }
  console.warn(`[db] schema v${version} → v${SCHEMA_VERSION}：旧库已挪到 ${file}.v${version}.${stamp}.bak，新建空库`);
}

export function blobDir(dbFile: string): string {
  return dbFile === ':memory:'
    ? path.join(process.env.TMPDIR ?? '/tmp', 'inquestry-blobs')
    : path.join(path.dirname(dbFile), 'blobs');
}
