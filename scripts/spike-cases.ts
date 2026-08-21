/**
 * Spike Cases —— 验并发多个调查这一带（D28 / ui.md §8.3）。
 *
 * 不起真会话：要验的都是 harness 侧的记账与投影，与模型无关，而这几处的错法都是**静默**的——
 *
 *   1. **排查时间线按 case 取而非按 session 取。** 按 session 取时重开旧调查主区是空的，
 *      查了三轮的东西一条不剩，看起来像数据丢了而不像查错了表
 *   2. **重开是新起一个 session，不是往已收尾的那个里接着写。** 不换 sessionId 的话，
 *      库里会出现「会话结束之后还在产生的步骤」
 *   3. **`cases.updated_at` 得有人前移。** 新建调查之后没有别的地方会动它，
 *      不前移的话切换栏的「最近活动」永远是新建调查先后
 *   4. **降级不能挑挂着待办的那个。** 它会把等着人回答的 pending 就地作废，
 *      等于替人做了「这条不查了」的决定
 *
 * 跑：npm run rebuild:node && npm run spike:cases
 */

import DatabaseCtor from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readBlobHead, storeBlob } from '../src/backend/db/blobs.js';
import {
  blobDir,
  DatabaseTooNewError,
  MIGRATIONS,
  MIN_READER_VERSION,
  minReaderOf,
  openDatabase,
  planUpgrade,
  SCHEMA_VERSION,
  type Db,
} from '../src/backend/db/database.js';
import { checkEventShapes, rebuildProjections } from '../src/backend/db/projector.js';
import {
  caseList,
  casePage,
  MAX_HITS,
  reportSections,
  searchCases,
  searchNarrative,
} from '../src/backend/db/queries.js';
import {
  deleteCase,
  emptyBlobTrash,
  readIntake,
  renameCase,
  setCaseTimebase,
  type InvestigationSession,
} from '../src/backend/store/sqlite-store.js';
import {
  EMPTY_SNAPSHOT,
  type CaseBrief,
  type CaseHit,
  type CaseListRow,
  type DeleteOutcome,
} from '../src/shared/ipc.js';
import { cacheBlob, cacheHit } from '../src/backend/agent/capabilities.js';
import { DEFAULT_UI_SETTINGS, LIMIT_BOUNDS, normalizeSettings } from '../src/shared/settings.js';
import { CaseRegistry } from '../src/main/case-registry.js';
import { CaseRunner } from '../src/main/case-runner.js';
import { draftKey, freshenHits, pruneDrafts, stateFillable, type CardDrafts } from '../src/renderer/drafts.js';
import { caseNode, caseSnip, caseState, rootParent } from '../src/renderer/caseline.js';
import { stateOf } from '../src/renderer/RunBar.js';
import type { ShapeSuggestion, Snapshot } from '../src/shared/ipc.js';

/** 会话准备与运行时读数是 CaseRunner 的私有面：要验的正是它们，只好从旁边够进去。 */
type Probe = {
  beginSession(): InvestigationSession;
  pushChat(role: 'user' | 'assistant' | 'system', text: string): void;
  askOperator(args: {
    engine: string;
    statement: string;
    why: string;
    expect: string;
  }): Promise<unknown>;
  status: Snapshot['sessionStatus'];
};

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

let db: Db;
let blobs: string;

function makeRunner(caseId: string, title?: string): CaseRunner {
  return new CaseRunner({
    db,
    blobDir: blobs,
    promptText: '',
    caseId,
    intake: readIntake(db, caseId) ?? {
      title: title ?? caseId,
      question: `${title ?? caseId} 的问题`,
      projectRoot: null,
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    },
    agent: { backend: 'claude', model: null, effort: null },
    onChange: () => {},
  });
}

/**
 * 注册处的工厂，对齐 main 里的 `loadCase`：**库里没有就返回 null**。
 * 这里若像 `makeRunner` 那样兜底造一份建单信息，切换一个不存在的 id 会凭空立出个调查来。
 */
const loadRunner = (caseId: string) => (readIntake(db, caseId) ? makeRunner(caseId) : null);

/** 跑一步完整的调查：开 step → 一次工具调用 → 带证据定稿。 */
async function work(runner: CaseRunner, direction: string, callId: string, occurredAt: string) {
  const session = (runner as unknown as Probe).beginSession();
  const { stepId } = await session.store.openStep({ direction });
  session.recordToolStart({ callId, toolName: 'mcp__datasource__query_logs', input: { q: 'lag' } });
  session.recordToolEnd({ callId, output: `命中 1 条\n${occurredAt} replica lag 812ms\n(end)` });
  await session.store.closeStep({
    stepId,
    status: 'confirmed',
    verdict: '主从延迟成立',
    confidence: 0.8,
    // 迁移那一段要验"新列的值靠重放补得回来"，得有一步真的填过它。
    // **每加一级迁移就要在这儿补上那一级的新列**，否则那条检查会当场 FAIL 提醒你
    // （整列都等于 DEFAULT 时，一个默认值就能把它蒙对，检查是空的）
    remediation: '把从库读改成读主库，或给这条链路加一次 read-your-writes 校验',
    roster: {
      label: '读到旧值的请求',
      idKind: 'requestId',
      complete: false,
      basis: '只覆盖抽样到的那批',
      items: [{ id: 'req_1' }, { id: 'req_2', note: '重试那次' }],
    },
    metrics: [{ label: '延迟峰值', value: '812ms', bound: 'exact', basis: '单次采样' }],
    evidence: [
      {
        callRef: '#1',
        anchor: '2',
        claim: `${occurredAt} 观察到复制延迟`,
        occurredAt,
        actor: 'db-replica',
      },
    ],
  });
  return stepId;
}

/**
 * 把一份库假装成上一版：**两个戳都得调**。
 * 只调 `user_version` 的话 `planUpgrade` 认 `meta` 里那份真实版本，当场判成 fresh，
 * 于是整段迁移自检根本没走迁移——而它看着与"迁移成功"一模一样。
 */
function demote(d: DatabaseCtor.Database, to: number): void {
  d.prepare(`UPDATE meta SET value=? WHERE key='schema_version'`).run(String(to));
  d.pragma(`user_version = ${to}`);
}

async function main() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-cases-')), 'inquestry.db');
  db = openDatabase(file);
  blobs = blobDir(file);

  // ── ① 一次调查跨两次会话 ──────────────────────────────────────────────
  const first = makeRunner('case_x', '订单查不到');
  await work(first, '主从延迟导致读不到刚写入的记录', 'call_x1', '12:41:07');
  // 人在第一次会话里说的话。**趁这个会话还开着写**——收尾之后再 beginSession 会另起一个，
  // 那就不是"跨会话看得见"而是"多了一次会话"（这一条正是写检查时自己踩到的）
  // **走 runner 自己的 pushChat**，不直接调 store：要验的正是"运行时决定把它落库还是留内存"，
  // 直接调 store 的话，把 pushChat 改回只存内存也照样全绿
  (first as unknown as Probe).pushChat('user', '别查网关了，先看从库');
  const createdAt = (db.prepare(`SELECT created_at c FROM cases WHERE id='case_x'`).get() as { c: number }).c;
  // 确认一次基准日期：下面那条迁移检查要靠「确认过的还是确认过的」才验得到重放，
  // 光看列在不在的话，DEFAULT 'intake' 会让忘了写投影分支也照样绿
  setCaseTimebase(db, { caseId: 'case_x', blobDir: blobs, now: () => Date.now() }, '2026-08-08', 'agent');
  first.close();

  // 关掉再打开 = 同一次调查的第二次会话（重启 app 走的也是这条路）
  const second = makeRunner('case_x');
  await work(second, '重试逻辑把失败吞了', 'call_x2', '12:43:20');
  const snapX = second.snapshot();

  check(
    '排查时间线按 case 取：重开旧调查看得见上一次会话的步骤',
    snapX.steps.length === 2,
    `steps=${snapX.steps.length}（按 session 取只会有 1 条）`,
  );
  check(
    '会话断点标得出来：ordinal 各自从 1 重来，sessionIndex 递增',
    snapX.steps.map((s) => `${s.sessionIndex}/${s.ordinal}`).join(' ') === '1/1 2/1',
    snapX.steps.map((s) => `第${s.sessionIndex}次会话 #${s.ordinal}`).join(' · '),
  );
  check(
    '两次会话的调用与证据都跟着各自的步骤走',
    snapX.steps.every((s) => s.calls.length === 1 && s.evidence.length === 1),
    snapX.steps.map((s) => `${s.calls.length}调用/${s.evidence.length}证据`).join(' '),
  );
  check(
    '系统时间线仍是全案汇总，两次会话的证据排在一条线上',
    snapX.incident.length === 2 && snapX.incident[0]!.occurredAtRaw === '12:41:07',
    snapX.incident.map((r) => r.occurredAtRaw).join(' → '),
  );

  // ── 对话带：**唯一重建不出来的东西**（步骤、证据、结论都投影得出来） ──────────
  //
  // 只存内存的话，关掉 app 就只剩 agent 的结论，看不到人当时那句"别查网关了，先看从库"。
  // 所以它按 case 取、跨会话留——按会话取的话重开旧调查只能看到空的。
  (second as unknown as Probe).pushChat('assistant', '好，我去看复制延迟');
  const chat = second.snapshot().chat;
  check(
    '对话带落库并按 case 取：重开旧调查还看得见上一次会话里人说过的话',
    chat.length === 2 && !!chat[0]?.text.includes('别查网关') && chat[1]?.role === 'assistant',
    chat.map((c) => `${c.role}:${c.text.slice(0, 10)}`).join(' | ') || '（空的）',
  );
  check(
    '对话带按时间排，不按会话分段（读的人要的是一条连续的带）',
    chat.length === 2 && chat[0]!.at <= chat[1]!.at,
    chat.map((c) => c.at).join(' → ') || '（空的）',
  );

  // ── 标题：**它会被改两次**，所以不能跟建单信息一起冻在 `case.opened` 里 ──────
  //
  // 建单那一刻先落一句由问题首行截出的兜底，agent 读完问题后改成一句短的，人还能再改。
  // 直接 `UPDATE cases` 的错法是静默的：库里改成了，一重放就被 `case.opened` 抹回兜底那句。
  const beforeTitle = readIntake(db, 'case_x')!.title;
  const renamed = renameCase(db, { caseId: 'case_x', blobDir: blobs, now: () => Date.now() }, '订单重复写入', 'agent');
  check(
    '改标题落库，快照上跟着变',
    renamed && readIntake(db, 'case_x')?.title === '订单重复写入' && beforeTitle !== '订单重复写入',
    `${beforeTitle} → ${readIntake(db, 'case_x')?.title}`,
  );
  const renameEvents = () =>
    (db.prepare(`SELECT COUNT(*) c FROM events WHERE type='case.renamed'`).get() as { c: number }).c;
  const once = renameEvents();
  const sameAgain = renameCase(db, { caseId: 'case_x', blobDir: blobs, now: () => Date.now() }, '订单重复写入', 'operator');
  check(
    '同一句话再落一次是空操作，不发第二条事件',
    !sameAgain && renameEvents() === once,
    `事件数 ${once} → ${renameEvents()} —— 每次快照都发一条的话，事件表会被"标题没变"刷满`,
  );

  // ── 重放前的载荷体检：迁移这条路的地基（data-model.md §2） ────────────────
  //
  // `better-sqlite3` 把 `undefined` 绑成 NULL，所以一条形状变过的老事件重放时
  // **不报错，只静静落一批 NULL**——看起来像迁移成功，其实是一批半残的调查。
  // 曾经就是这么"跑通"过一次的，所以这道闸自己必须有一条会红的检查。
  //
  // ⚠️ 验它必须在**真事件**上：`spike:db` 那份夹具用的是它自己的事件词汇
  // （`step.opened` 里是 `id` 不是 `stepId`），拿它当场地只会验出夹具与生产不同源
  const eventCount = (db.prepare(`SELECT COUNT(*) c FROM events`).get() as { c: number }).c;
  let healthy = '';
  try {
    checkEventShapes(db);
  } catch (e) {
    healthy = (e as Error).message;
  }
  check(
    '载荷体检：真跑出来的事件全部通过（形状没变过）',
    !healthy && eventCount > 0,
    healthy || `${eventCount} 条事件全部通过`,
  );

  // 造一条缺字段的老事件（模拟"载荷形状变过"）。**不能只验它抛错**——抛错的原因可能是别的，
  // 要认那句话里缺的是哪几个键，否则把"没见过的事件类型"也当成通过了
  db.prepare(`INSERT INTO events (case_id,session_id,type,payload,created_at) VALUES (?,?,?,?,?)`).run(
    'case_x',
    null,
    'step.closed',
    JSON.stringify({ stepId: 'st_old', status: 'confirmed', at: 1 }),
    1,
  );
  let caught = '';
  try {
    checkEventShapes(db);
  } catch (e) {
    caught = (e as Error).message;
  }
  check(
    '载荷缺字段时体检当场拦下，并说清缺的是哪几个键',
    caught.includes('verdict') && caught.includes('confidence') && caught.includes('step.closed'),
    caught || '（没抛错——那意味着形状变过的老库会静默落一批 NULL）',
  );

  // **必填集要覆盖投影真正要用的每一个键，不是手挑一个子集。**
  // `anchorKind` 落进一个 NOT NULL 列，而它一度不在名单里：体检判健康 → 重放才因约束失败
  // 抛出来 → 正好绕过"退回挪库"那条兜底，app 直接起不来。现在这张表由编译器盯着
  // （映射类型，漏一个键就编译不过），这条检查守的是"它确实盖住了投影用得着的字段"
  // 上一条坏事件已经验完了，让开——**体检遇到第一个问题就停**，
  // 不让开的话这条检查看到的是它，而 anchorKind 那一条压根没被检到（第一版就是这么绿的）
  db.prepare(`DELETE FROM events WHERE json_extract(payload,'$.stepId')='st_old'`).run();
  db.prepare(`INSERT INTO events (case_id,session_id,type,payload,created_at) VALUES (?,?,?,?,?)`).run(
    'case_x',
    null,
    'evidence.attached',
    JSON.stringify({ evidenceId: 'ev_old', stepId: 'st_old', callId: 'tc_old', claim: 'x', observedAt: 1 }),
    1,
  );
  let anchorCaught = '';
  try {
    checkEventShapes(db);
  } catch (e) {
    anchorCaught = (e as Error).message;
  }
  check(
    '缺 anchorKind 这种"投影要用、名单里易漏"的键也拦得下',
    anchorCaught.includes('anchorKind'),
    anchorCaught || '（放过去了——重放会撞 NOT NULL 约束，而那时兜底已经来不及）',
  );

  // **重放这条路自己也得体检**：只验裸函数的话，把 `rebuildProjections` 里那一行删掉
  // 照样全绿——而真正会被调用的是它，不是那个函数
  let refused = '';
  try {
    rebuildProjections(db, { blobDir: blobs });
  } catch (e) {
    refused = (e as Error).message;
  }
  check(
    '重放本身拒绝形状变过的库（体检是它的第一步，不是调用方的自觉）',
    refused.includes('载荷形状变过了'),
    refused || '（重放照跑了——静默落 NULL 的老路又通了）',
  );

  // 那条造出来的坏事件到此为止：**下面要复制这个库**，留着它迁移那一段会被体检拦下
  db.prepare(`DELETE FROM events WHERE json_extract(payload,'$.evidenceId')='ev_old'`).run();

  // ── 迁移这条路本身：**要在真库真数据上走一遍** ──────────────────────────
  //
  // 体检只是那道闸，路在 `openDatabase` 里。启动路径不分岔的话，
  // 哪怕只加一个 nullable 列，现有调查照样会从 app 里消失（文件留成 .bak，界面上没了）。
  //
  // 手法：把这份**真跑出来的库**调低一格假装它是旧的，再给一级假步骤。
  // 不能靠改 SCHEMA_VERSION——那是个常量，而且改了整套自检都会跟着漂
  const migrated = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-migrate-')), 'inquestry.db');
  db.prepare(`VACUUM INTO ?`).run(migrated);
  const oldDb = new DatabaseCtor(migrated);
  demote(oldDb, SCHEMA_VERSION - 1);
  oldDb.close();

  const casesBefore = (db.prepare(`SELECT COUNT(*) c FROM cases`).get() as { c: number }).c;
  const stepsBefore = (db.prepare(`SELECT COUNT(*) c FROM steps`).get() as { c: number }).c;
  const upgraded = openDatabase(migrated, {
    steps: [
      {
        to: SCHEMA_VERSION,
        compat: 'additive',
        apply: (d) => {
          d.exec(`ALTER TABLE cases ADD COLUMN probe_col TEXT`);
          // **顺序探针**：这张表由幂等 `SCHEMA_SQL` 建。步骤跑在它之前的话，
          // 这里删掉之后它会被重新建出来；反过来（schema 先跑）它就永远没了。
          // 顺序反了的真实后果是"加列 + 给它建索引"那类升级当场炸在 SCHEMA_SQL 上，
          // 而那个场景没法用固定的 SCHEMA_SQL 造出来——这条是它的替身
          d.exec(`DROP TABLE IF EXISTS ui_settings`);
        },
      },
    ],
  });
  const schemaAfterSteps = !!(
    upgraded.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ui_settings'`).get()
  );
  const post = {
    cases: (upgraded.prepare(`SELECT COUNT(*) c FROM cases`).get() as { c: number }).c,
    steps: (upgraded.prepare(`SELECT COUNT(*) c FROM steps`).get() as { c: number }).c,
    version: Number(upgraded.pragma('user_version', { simple: true })),
    hasCol: (upgraded.prepare(`PRAGMA table_info(cases)`).all() as { name: string }[]).some(
      (c) => c.name === 'probe_col',
    ),
  };
  upgraded.close();
  check(
    '每一级 DDL 跑在幂等 schema 之前（否则依赖新列的索引会先炸在 SCHEMA_SQL 上）',
    schemaAfterSteps,
    schemaAfterSteps ? '步骤删掉的表被 SCHEMA_SQL 重新建了出来' : '步骤删掉的表没回来，说明 schema 先跑了',
  );
  check(
    '可重放的升级真的走迁移：调查留在原地，新列补上，版本跟着提',
    post.cases === casesBefore && post.cases > 0 && post.steps === stepsBefore && post.hasCol && post.version === SCHEMA_VERSION,
    `调查 ${casesBefore} → ${post.cases}，步骤 ${stepsBefore} → ${post.steps}，新列=${post.hasCol}，版本=${post.version}`,
  );
  check(
    // 挪库那条路会留下 .bak；走迁移就**不该**留——留了说明它其实走的是老路，
    // 而"调查还在"只是因为这一轮恰好又造了一份
    '走迁移不留 .bak（留了就说明它其实挪了库，只是看起来像迁移）',
    !existsSync(`${migrated}.v${SCHEMA_VERSION - 1}`) &&
      readdirSync(path.dirname(migrated)).every((f) => !f.includes('.bak')),
    readdirSync(path.dirname(migrated)).join(' '),
  );
  // ── 内置阶梯本身也要走一遍，不能只验一级假步骤 ─────────────────────────
  //
  // 上面那一段验的是**这条路**（DDL 与 schema 的先后、调查留不留在原地），用的是替身步骤。
  // 而 `MIGRATIONS` 里真正那一级写没写对是另一回事：写歪了（列名拼错、忘了加进阶梯）
  // 的表现是**开发库被挪走**——app 起得来、界面干净、调查全没了。
  //
  // 造一份"真的是上一版"的库：把当前库复制一份，删掉最后一级加的那些列，再把版本调回去。
  // 光改 user_version 不删列的话，`ALTER TABLE ADD COLUMN` 会撞上重复列，
  // 验到的就成了"迁移会失败"而不是"迁移能成"。
  //
  // **删哪些列问阶梯自己要**（`MigrationStep.adds`），不在这儿写死一句 `DROP COLUMN`：
  // 写死的那句与阶梯是同一件事的两处描述，加下一级时忘了改这儿的表现是
  // "去删一列不存在的东西"，报出来的成了「迁移会失败」而不是「自检过期了」
  const top = MIGRATIONS[MIGRATIONS.length - 1];
  const topCols = top?.adds ?? [];
  const real = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-realmig-')), 'inquestry.db');
  db.prepare(`VACUUM INTO ?`).run(real);
  const realOld = new DatabaseCtor(real);
  for (const c of topCols) realOld.exec(`ALTER TABLE ${c.table} DROP COLUMN ${c.column}`);
  demote(realOld, SCHEMA_VERSION - 1);
  realOld.close();

  /**
   * 新列的值是**由重放补回来的**还是**被 DEFAULT 顶上的**，这两件事长得一模一样：
   * 只数"列非空的行数"的话，投影器压根没接那条新事件也照样对得上。
   *
   * 所以逐行比对整列的值，并且要求夹具里**至少有一行的值是 DEFAULT 蒙不到的**。
   * 那个 DEFAULT 不写死在这儿，问库自己要（`PRAGMA table_info`）——写死的话它就成了
   * 第三处描述同一件事的地方。整列都等于 DEFAULT 时这条检查是空的，当场 FAIL：
   * 加下一级迁移时，那意味着夹具还缺一条能证明重放的数据
   */
  const columnValues = (d: Db, c: { table: string; column: string }) =>
    (d.prepare(`SELECT ${c.column} v FROM ${c.table} ORDER BY id`).all() as { v: unknown }[]).map(
      (r) => (r.v === null ? null : String(r.v)),
    );
  const columnDefault = (d: Db, c: { table: string; column: string }) => {
    const info = d.prepare(`PRAGMA table_info(${c.table})`).all() as {
      name: string;
      dflt_value: string | null;
    }[];
    const raw = info.find((i) => i.name === c.column)?.dflt_value ?? null;
    // PRAGMA 给回来的是 SQL 字面量（`'intake'`），要的是它的值
    return raw === null ? null : raw.replace(/^'([\s\S]*)'$/, '$1');
  };
  const valuesBefore = topCols.map((c) => columnValues(db, c));
  const defaults = topCols.map((c) => columnDefault(db, c));
  // **不传 steps**：走的就是代码里那条内置阶梯
  const realUp = openDatabase(real);
  const valuesAfter = topCols.map((c) => columnValues(realUp, c));
  const realPost = {
    cases: (realUp.prepare(`SELECT COUNT(*) c FROM cases`).get() as { c: number }).c,
    version: Number(realUp.pragma('user_version', { simple: true })),
  };
  realUp.close();
  const valuesKept = topCols.every(
    (_, i) => JSON.stringify(valuesBefore[i]) === JSON.stringify(valuesAfter[i]),
  );
  // 「DEFAULT 蒙不到」= 至少有一行的值与它不同（没有 DEFAULT 时，任何非 NULL 都算）
  const provable =
    topCols.length > 0 && valuesBefore.every((vals, i) => vals.some((v) => v !== defaults[i]));
  check(
    `内置阶梯把 v${SCHEMA_VERSION - 1} 迁到 v${SCHEMA_VERSION}：调查留在原地，新列的值由重放补回来（不是 DEFAULT 顶上的）`,
    realPost.cases === casesBefore &&
      realPost.cases > 0 &&
      provable &&
      valuesKept &&
      realPost.version === SCHEMA_VERSION &&
      readdirSync(path.dirname(real)).every((f) => !f.includes('.bak')),
    `调查 ${casesBefore} → ${realPost.cases}，版本=${realPost.version}，目录=${readdirSync(path.dirname(real)).join(' ')}\n` +
      `      最后一级新增列 ${topCols.map((c, i) => `${c.table}.${c.column}（DEFAULT ${defaults[i] ?? 'NULL'}，${new Set(valuesBefore[i]).size} 种取值）`).join('、') || '（无）'}，值原样回来=${valuesKept}` +
      (provable
        ? ''
        : ' ← 夹具里这一列每一行都等于 DEFAULT，一个默认值就能把它蒙对，这条检查是空的；' +
          '加了一级迁移就要给夹具补一条能证明重放的数据'),
  );

  // 🔴 **`case_ui_state` 不是投影，却会被投影的清空**：它对 `cases(id)` 带 ON DELETE CASCADE，
  // `DELETE FROM cases` 一跑就整表带走。里面装的正是**重建不出来**的两样——新建调查时选的 agent
  // （会话还没开，别处没有第二份）与接管开关。丢了不报错、调查还在，表现是"升级完模型悄悄
  // 换回默认、接管自己关掉了"，与迁移失败长得完全不一样
  const uiCase = caseList(db, { limit: 1 })[0]!.id;
  db.prepare(
    `INSERT INTO case_ui_state (case_id,value) VALUES (?,?)
     ON CONFLICT(case_id) DO UPDATE SET value=excluded.value`,
  ).run(uiCase, JSON.stringify({ takeover: true, agent: { backend: 'claude', model: 'probe-model' } }));
  rebuildProjections(db, { blobDir: blobs });
  const keptUi = db.prepare(`SELECT value FROM case_ui_state WHERE case_id=?`).get(uiCase) as
    | { value: string }
    | undefined;
  check(
    '重放不该把 case_ui_state 一起冲掉（它对 cases 有级联删除，而里面装的重建不出来）',
    keptUi?.value.includes('probe-model') === true && keptUi.value.includes('"takeover":true'),
    `重放后=${keptUi?.value ?? '(没了)'}`,
  );

  // 标题是 `case.opened` 之后才改的，重放次序一乱（或改标题不走事件）它就被抹回兜底那句
  check(
    '重放之后标题还是改过的那一个，不被 case.opened 抹回去',
    readIntake(db, 'case_x')?.title === '订单重复写入',
    `重放后=${readIntake(db, 'case_x')?.title} —— 直接 UPDATE cases 的话这里会变回问题首行`,
  );

  // 缺一级就整条走不通：跳过那一级等于把它那几列悄悄留空
  const staleFile = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-stale-')), 'inquestry.db');
  db.prepare(`VACUUM INTO ?`).run(staleFile);
  const staleDb = new DatabaseCtor(staleFile);
  demote(staleDb, SCHEMA_VERSION - 1);
  staleDb.close();
  // 有人把一级"其实改了载荷形状"的升级声明成可重放时该怎么办：**退回挪库**。
  // 硬迁的话会落出一批半残的调查，而它与一次成功的迁移长得一模一样；
  // 直接抛错则是让 app 起不来——声明错的代价不该是"今天用不了这个工具"
  const broken = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-broken-')), 'inquestry.db');
  db.prepare(`VACUUM INTO ?`).run(broken);
  const brokenDb = new DatabaseCtor(broken);
  brokenDb
    .prepare(`INSERT INTO events (case_id,session_id,type,payload,created_at) VALUES (?,?,?,?,?)`)
    .run('case_x', null, 'step.closed', JSON.stringify({ stepId: 'st_old', status: 'confirmed', at: 1 }), 1);
  demote(brokenDb, SCHEMA_VERSION - 1);
  brokenDb.close();
  // ⚠️ **这里必须接住异常**：抛出去的话整个脚本当场死，一条检查都跑不到，
  // 而退出码看着与"抓住了"一模一样（今天第三次踩这个形状）。"没抛错"本身就是要验的一半
  let salvagedCases = -1;
  let threw = '';
  try {
    const salvaged = openDatabase(broken, {
      steps: [
        { to: SCHEMA_VERSION, compat: 'additive', apply: (d) => d.exec(`ALTER TABLE cases ADD COLUMN probe_col TEXT`) },
      ],
    });
    salvagedCases = (salvaged.prepare(`SELECT COUNT(*) c FROM cases`).get() as { c: number }).c;
    salvaged.close();
  } catch (e) {
    threw = (e as Error).message;
  }
  check(
    '载荷形状变过却被声明成可重放时，退回挪库（不硬迁一半，也不让 app 起不来）',
    !threw && salvagedCases === 0 && readdirSync(path.dirname(broken)).some((f) => f.includes('.bak')),
    threw
      ? `抛了：${threw.slice(0, 60)}（app 会起不来）`
      : `新库里 ${salvagedCases} 个调查，目录里 ${readdirSync(path.dirname(broken)).join(' ')}`,
  );

  check(
    '阶梯缺一级时退回挪库，不硬着头皮迁一半',
    planUpgrade(staleFile, []).kind === 'archive' &&
      planUpgrade(staleFile, [{ to: SCHEMA_VERSION, compat: 'additive', apply: () => {} }]).kind === 'replay',
    `空阶梯=${planUpgrade(staleFile, []).kind} / 补齐后=${planUpgrade(staleFile, [{ to: SCHEMA_VERSION, compat: 'additive', apply: () => {} }]).kind}`,
  );

  /** 造一份"比本版新"的库：真实版本写进 meta，最低读者写进 user_version。 */
  const newerLib = (tag: string, version: number, minReader: number) => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), `inquestry-${tag}-`)), 'inquestry.db');
    db.prepare(`VACUUM INTO ?`).run(f);
    const d = new DatabaseCtor(f);
    d.prepare(`INSERT INTO meta (key,value) VALUES ('schema_version',?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(version));
    d.pragma(`user_version = ${minReader}`);
    d.close();
    return f;
  };
  /** 打开它，回来的是"抛了什么"与"库被动过没有"。 */
  const openAndInspect = (f: string) => {
    let threw = '没抛错';
    let cases = -1;
    try {
      const d = openDatabase(f);
      cases = (d.prepare(`SELECT COUNT(*) c FROM cases`).get() as { c: number }).c;
      d.close();
    } catch (e) {
      threw = e instanceof DatabaseTooNewError ? 'DatabaseTooNewError' : `另一种错：${(e as Error).message}`;
    }
    const probe = new DatabaseCtor(f, { readonly: true });
    const kept = {
      minReader: Number(probe.pragma('user_version', { simple: true })),
      version: Number((probe.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string }).value),
    };
    probe.close();
    return { threw, cases, ...kept, dir: readdirSync(path.dirname(f)).join(' ') };
  };

  // 🔴 **降级的正路**：additive 的新库不抬 min_reader，老版本照旧打得开。
  // 这一条成立，「开发时用了高版本 schema，回头启动旧的正式包」才不会出事——
  // 而它必须由**库自己**声明得出来，不能靠新版本里加判断：旧代码已经在磁盘上了
  const compat = openAndInspect(newerLib('compat', SCHEMA_VERSION + 1, SCHEMA_VERSION));
  check(
    'additive 的新库老版本照常打开，两个戳一个都不改写',
    compat.threw === '没抛错' &&
      compat.cases > 0 &&
      compat.version === SCHEMA_VERSION + 1 &&
      compat.minReader === SCHEMA_VERSION,
    `${compat.threw}，读到 ${compat.cases} 个调查，库还是 v${compat.version}/最低读者 v${compat.minReader}` +
      ` —— 把 meta 写回本版的话，真实版本就丢了，下次用新版打开会当成没迁过`,
  );

  // breaking 的那一级才停下来：**这一档也不挪库**。挪走之后随自动更新装上的新版
  // 会拿着那个空库当一切正常，再不会去找 .bak——用户看到的是"升级完数据没了"
  //（0.2.0 挪走 v9 库那次就是这么丢的）
  const blocked = openAndInspect(newerLib('newer', SCHEMA_VERSION + 2, SCHEMA_VERSION + 1));
  check(
    'breaking 的新库停下来等更新，不挪库（挪了的话新版起来会拿着空库当一切正常）',
    blocked.threw === 'DatabaseTooNewError' &&
      blocked.version === SCHEMA_VERSION + 2 &&
      blocked.minReader === SCHEMA_VERSION + 1 &&
      !blocked.dir.includes('.bak'),
    `${blocked.threw}，库还是 v${blocked.version}/最低读者 v${blocked.minReader}，目录=${blocked.dir}`,
  );

  // 🔴 **已经发出去的 0.3.0 认的是"user_version == 9 就照常打开"**，它不看 meta。
  // 这个数一旦被抬到 9 以上，线上那一版会把库判成降级挪走——而那份代码改不动了。
  // 所以往后每加一级都要先答一句：这级是 additive 吗？是就别抬
  const shipped = new DatabaseCtor(file, { readonly: true });
  const stamps = {
    minReader: Number(shipped.pragma('user_version', { simple: true })),
    version: Number((shipped.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string }).value),
  };
  shipped.close();
  check(
    '新代码写出来的库，user_version 仍是已发出去那版认得的 9（抬了它，线上 0.3.0 会把库挪走）',
    stamps.minReader === 9 && stamps.version === SCHEMA_VERSION && MIN_READER_VERSION === 9,
    `最低读者 v${stamps.minReader}（MIN_READER_VERSION=${MIN_READER_VERSION}）/ 真实版本 v${stamps.version}`,
  );

  // min_reader 由阶梯自己算：additive 不抬、breaking 抬到那一级。
  // 反过来验一句，否则上一条只证明"今天恰好是 9"，证明不了这条规则还在
  const ladderAdditive = minReaderOf([{ to: 99, compat: 'additive' }]);
  const ladderBreaking = minReaderOf([{ to: 99, compat: 'additive' }, { to: 100, compat: 'breaking' }]);
  check(
    'min_reader 只被 breaking 的那一级抬起来，additive 的加多少级都不动',
    ladderAdditive === MIN_READER_VERSION && ladderBreaking === 100,
    `全 additive=${ladderAdditive}（该等于 ${MIN_READER_VERSION}）/ 末级 breaking=${ladderBreaking}（该等于 100）`,
  );

  const sessions = db
    .prepare(`SELECT id,status FROM sessions WHERE case_id='case_x' ORDER BY started_at`)
    .all() as { id: string; status: string }[];
  check(
    '换个运行时重开，是新起一个 session，上一个留在 ended',
    sessions.length === 2 && sessions[0]!.status === 'ended' && sessions[0]!.id !== sessions[1]!.id,
    sessions.map((s) => `${s.id.slice(0, 8)}:${s.status}`).join(' '),
  );

  // 同一个运行时接着跑（会话自己跑完 / 崩了之后再点「接着查」，运行时并没有换）：
  // 这条走的是另一条路——`beginSession` 不换 sessionId 的话，新步骤会落进那个已 ended 的会话
  const again = makeRunner('case_w', '缓存击穿');
  await work(again, '热点 key 同时过期', 'call_w1', '03:15:00');
  again.close();
  await work(again, '回源没有并发保护', 'call_w2', '03:15:04');
  const wSessions = db
    .prepare(`SELECT id,status FROM sessions WHERE case_id='case_w' ORDER BY started_at`)
    .all() as { id: string; status: string }[];
  const wOrphan = db
    .prepare(
      `SELECT COUNT(*) c FROM steps s JOIN sessions se ON se.id=s.session_id
       WHERE se.case_id='case_w' AND se.status='ended' AND s.t_start > se.ended_at`,
    )
    .get() as { c: number };
  check(
    '同一个运行时接着跑也换 session，不往已收尾的那个里补步骤',
    wSessions.length === 2 && wSessions[0]!.status === 'ended' && wOrphan.c === 0,
    `sessions=${wSessions.map((s) => s.status).join(',')} 落在已结束会话之后的步骤=${wOrphan.c}`,
  );

  // ── ② updated_at 与切换栏排序 ────────────────────────────────────────
  const updatedAt = (db.prepare(`SELECT updated_at u FROM cases WHERE id='case_x'`).get() as { u: number }).u;
  check(
    'cases.updated_at 随活动前移，不停在新建调查那一刻',
    updatedAt > createdAt,
    `created=${createdAt} updated=${updatedAt}（差 ${updatedAt - createdAt}ms）`,
  );

  const other = makeRunner('case_y', '推送重复发送');
  await work(other, '消费者没有幂等键', 'call_y1', '09:02:11');
  db.prepare(`UPDATE cases SET status='closed' WHERE id='case_y'`).run();
  const idle = makeRunner('case_z', '登录偶发 502');

  check(
    '切换栏排序：进行中的排在前面',
    caseList(db).map((c) => c.id)[caseList(db).length - 1] === 'case_y',
    caseList(db)
      .map((c) => `${c.id}(${c.status})`)
      .join(' '),
  );

  // ── ③ 全局待办汇总：别的调查在等人，当前调查的快照里也数得出来 ──────────
  const registry = new CaseRegistry<CaseRunner>({ db, create: loadRunner });
  registry.adopt('case_z', idle);
  void (idle as unknown as Probe).askOperator({
    engine: 'mysql',
    statement: 'SELECT * FROM sessions WHERE uid=42',
    why: '看看这个用户的会话有没有过期',
    expect: '预期只有一条未过期记录',
  });
  registry.switchTo('case_x');

  const briefs = registry.briefs();
  const zBrief = briefs.find((c) => c.id === 'case_z')!;

  // ── 列表那句状态与工作区底部那句必须说同一件事 ──────────────────────────
  //
  // 🔴 **这是实际踩到过的一条**：列表原先按 `loaded`（main 还持有它的运行时）分档，
  // 于是一次点开看过、一轮都没跑的调查在首页写「已停止」，点进去底部写「待开始」。
  // 两处都不报错，人只能猜哪个是真的。所以两处共用 `runState`，而这条检查验的是
  // **同一个事实喂给两处会得到同一个词**——只验其中一处的映射表证明不了这件事。
  const sameWord = (
    name: string,
    brief: Pick<CaseBrief, 'status' | 'running' | 'started'>,
    snapPart: Pick<Snapshot, 'sessionStatus' | 'busy'> & { steps: number },
  ) => {
    const list = caseState({ ...brief, id: 'x', title: 'x', updatedAt: 0, current: false, todos: 0, loaded: false }).label;
    const bar = stateOf({
      ...EMPTY_SNAPSHOT,
      case: { ...EMPTY_SNAPSHOT.case!, status: brief.status } as never,
      busy: snapPart.busy,
      sessionStatus: snapPart.sessionStatus,
      steps: Array.from({ length: snapPart.steps }, () => ({}) as never),
    });
    check(`列表与状态栏用同一个词：${name}`, list === bar, `列表「${list}」/ 状态栏「${bar}」`);
  };
  sameWord('一轮都没跑过', { status: 'open', running: false, started: false }, { sessionStatus: 'idle', busy: false, steps: 0 });
  // 从历史里重新点开：运行时是新建的（idle），但这次调查确实跑过——就是那条踩到的
  sameWord('跑过、从历史重新点开', { status: 'open', running: false, started: true }, { sessionStatus: 'idle', busy: false, steps: 3 });
  sameWord('跑过、这一轮已收', { status: 'open', running: false, started: true }, { sessionStatus: 'ended', busy: false, steps: 3 });
  sameWord('正在跑', { status: 'open', running: true, started: true }, { sessionStatus: 'live', busy: true, steps: 3 });
  sameWord('已定稿', { status: 'closed', running: false, started: true }, { sessionStatus: 'ended', busy: false, steps: 3 });
  sameWord('已归档', { status: 'aborted', running: false, started: true }, { sessionStatus: 'ended', busy: false, steps: 3 });

  // ⚠️ 上面那六条只验"两处说的是同一个词"，而两处如今共用 `runState`——**改坏那个函数，
  // 它们照样一致**，检查全绿。所以另有这一条把词钉在事实上：少了它，那六条是空的。
  const word = (status: CaseBrief['status'], running: boolean, started: boolean) =>
    caseState({ id: 'x', title: 'x', updatedAt: 0, current: false, todos: 0, loaded: false, status, running, started }).label;
  check(
    '四个词各自钉在哪个事实上',
    word('open', false, false) === '待开始' &&
      word('open', false, true) === '已停止' &&
      word('open', true, true) === '运行中' &&
      word('closed', false, true) === '已定稿' &&
      word('aborted', false, true) === '已归档',
    `没跑过=${word('open', false, false)} 跑过停了=${word('open', false, true)} 在跑=${word('open', true, true)} 定稿=${word('closed', false, true)} 归档=${word('aborted', false, true)}`,
  );

  // ── 状态节点的分档次序 ────────────────────────────────────────────────
  //
  // 首页轨道与历史列表如今共用 `caseNode`，所以"两页长得一样"由那一个函数保证，不必再验。
  // 要验的是**它自己那两条压制关系**，它们各有理由且都不会报错：
  //   · 等你 压过 运行中——暖色是「有事找你」的全局唯一信号（ui.md §4）。反过来的话，
  //     一条边跑边等人的调查在两个列表里都显示成"在跑"，那条支线就此静静挂死（D28）。
  //   · 终态 压过 等你——历史页那一行的边线与节点同吃这一个返回值，各算各的话，
  //     一条已定稿却还挂着待办的调查会是"暖色的边配一颗蓝色空心节点"。
  const nodeOf = (status: CaseBrief['status'], running: boolean, todos: number) =>
    caseNode({ id: 'x', title: 'x', updatedAt: 0, current: false, loaded: false, started: true, status, running, todos });
  check(
    '节点分档：等你压过运行中，终态压过等你',
    nodeOf('open', true, 1) === 'wait' &&
      nodeOf('open', true, 0) === 'live' &&
      nodeOf('open', false, 1) === 'wait' &&
      nodeOf('open', false, 0) === '' &&
      nodeOf('closed', false, 1) === 'seal' &&
      nodeOf('aborted', true, 2) === 'shut',
    `边跑边等你=${nodeOf('open', true, 1)} 只在跑=${nodeOf('open', true, 0)} 只等你=${nodeOf('open', false, 1)} ` +
      `都没有=「${nodeOf('open', false, 0)}」 定稿还挂着待办=${nodeOf('closed', false, 1)} 归档=${nodeOf('aborted', true, 2)}`,
  );

  check(
    '「跑过没有」按库里有没有会话算，不按 main 手上有没有运行时',
    // case_z 刚 adopt、一轮没跑：运行时在手上（loaded），但没开过会话
    zBrief.loaded && !zBrief.started && briefs.find((c) => c.id === 'case_x')!.started,
    `case_z loaded=${zBrief.loaded} started=${zBrief.started} / case_x started=${briefs.find((c) => c.id === 'case_x')!.started}`,
  );
  check(
    '切换到别的调查不中断它：运行时还在，待办也还挂着',
    zBrief.loaded && zBrief.todos === 1 && !zBrief.current,
    `case_z loaded=${zBrief.loaded} todos=${zBrief.todos} current=${zBrief.current}`,
  );
  check(
    '当前调查的快照里带着别处的待办数（D28）',
    registry.current!.snapshot(briefs).cases.reduce((n, c) => n + c.todos, 0) === 1,
    briefs.map((c) => `${c.id}:${c.todos}`).join(' '),
  );
  check(
    '库里没有的 case 切不过去，当前调查不受影响',
    registry.switchTo('case_nope') === false && registry.currentCaseId === 'case_x',
    `current=${registry.currentCaseId}`,
  );

  // ── ④ 活跃会话限流：降级最久未交互的，但绝不动挂着待办的 ────────────────
  const small = new CaseRegistry<CaseRunner>({ db, create: loadRunner, maxLive: 2 });
  const live = (r: CaseRunner) => {
    (r as unknown as Probe).beginSession();
    (r as unknown as Probe).status = 'live';
    return r;
  };
  // case_z 最久未交互，但它挂着一条待办；case_x 次之且干净——该走的是 case_x
  small.adopt('case_z', live(idle));
  small.adopt('case_x', live(makeRunner('case_x')));
  small.adopt('case_y', live(makeRunner('case_y')));

  const after = new Map(small.briefs().map((c) => [c.id, c]));
  check(
    '超上限时降级最久未交互的那个',
    after.get('case_x')!.loaded === false,
    small
      .briefs()
      .map((c) => `${c.id}:${c.loaded ? '在' : '已降级'}`)
      .join(' '),
  );
  check(
    '挂着待办的调查不会被降级——降级等于替人作废掉那条回填',
    after.get('case_z')!.loaded && after.get('case_z')!.todos === 1,
    `case_z loaded=${after.get('case_z')!.loaded} todos=${after.get('case_z')!.todos}`,
  );
  check(
    '当前调查不会被降级',
    after.get('case_y')!.loaded && after.get('case_y')!.current,
    `case_y loaded=${after.get('case_y')!.loaded} current=${after.get('case_y')!.current}`,
  );

  // 限流不能只在切换时查一次：切过去的时候调查还没开跑（没有进程），
  // 是点了「开始排查」之后才超的上限。此刻 live 的是 case_z（挂着待办）与 case_y
  small.switchTo('case_w');
  live(small.current!);
  small.enforceLimit();
  const later = new Map(small.briefs().map((c) => [c.id, c]));
  check(
    '开跑之后才超的上限也拦得住，不是只在切换时查一次',
    later.get('case_w')!.loaded && later.get('case_z')!.loaded && !later.get('case_y')!.loaded,
    small
      .briefs()
      .map((c) => `${c.id}:${c.loaded ? '在' : '已降级'}`)
      .join(' '),
  );

  // 被降级的调查重新点开：必须是个全新的运行时，不是那个已收尾的
  small.switchTo('case_x');
  check(
    '降级过的调查点回去是新运行时，不接着往已收尾的 session 里写',
    small.current!.sessionStatus === 'idle' && small.briefs().find((c) => c.id === 'case_x')!.loaded,
    `status=${small.current!.sessionStatus}`,
  );

  // ── ⑤ updated_at 是投影，重放后必须逐字一致 ─────────────────────────────
  //
  // ⚠️ 只比 id 与 updated_at，**不比 status**：定稿状态目前还没有对应的领域事件
  //（要等「三种收尾」那一步），上面那句直接改库的 UPDATE 重放后必然被抹掉。
  // 这正是收尾三档必须走事件而不是直接 UPDATE 的理由——记在这儿免得到时候忘了。
  //
  // 这一条必须排在下面两节**之前**：它们为了造场景直接改了库，那些改动重放留不下来。
  const activity = () => JSON.stringify(caseList(db).map((c) => [c.id, c.updated_at]).sort());
  const beforeReplay = activity();
  rebuildProjections(db, { blobDir: blobs });
  check(
    '清空投影后重放，各调查的最近活动时间逐字一致',
    beforeReplay === activity(),
    beforeReplay === activity() ? '一致' : `重放前=${beforeReplay}\n      重放后=${activity()}`,
  );

  // ── ⑥ 报告章节要按会话先后取「最新」，不能只看会话内的 ordinal ───────────
  //
  // case_x 有两次会话。第一次会话里排一个 ordinal 很大的影响面，第二次会话里排一个
  // ordinal 很小的——只按 ordinal 排的话，报告会拿旧那条当最新的。
  const xs = db
    .prepare(`SELECT id FROM sessions WHERE case_id='case_x' ORDER BY started_at`)
    .all() as { id: string }[];
  const impact = (sessionId: string, ordinal: number, text: string) =>
    db
      .prepare(
        `INSERT INTO steps (id,session_id,ordinal,kind,verdict_text,status,t_start)
         VALUES (?,?,?,'impact',?,'confirmed',0)`,
      )
      .run(`st_imp_${ordinal}`, sessionId, ordinal, text);
  impact(xs[0]!.id, 90, '旧会话给的影响面：3 个用户');
  impact(xs[1]!.id, 2, '新会话给的影响面：37 个用户');
  check(
    '报告的「最新」按会话先后算，旧会话的大 ordinal 压不过新会话',
    reportSections(db, 'case_x').impact?.verdict_text === '新会话给的影响面：37 个用户',
    `取到的是「${reportSections(db, 'case_x').impact?.verdict_text}」`,
  );

  // ── ⑥.5 历史页那一行：「开始了没有」按 started 说，不按步数 ────────────────
  //
  // 开局必有一段"还说不出假设，先摸一眼"：CLI 延迟加载 MCP 工具，agent 想调 open_step
  // 得先 ToolSearch 一次，而那本身就是一次要记账的调用——`ensureStep()` 就地开一个兜底步
  // 把它接住。那种步没有 direction，历史页的 `steps` 不数它（数了就比人在工作区里
  // 数得出的方向多），于是"已启动 / 0 方向"这一档只有 `started` 说得出。
  const fb = makeRunner('case_fb', '还没声明方向就先查了两下');
  const fbs = (fb as unknown as Probe).beginSession();
  fbs.recordToolStart({ callId: 'call_fb1', toolName: 'ToolSearch', input: { query: 'select:open_step' } });
  fbs.recordToolEnd({ callId: 'call_fb1', output: 'ok' });
  fb.close();
  const fbRow = casePage(db, {}).rows.find((r) => r.id === 'case_fb')!;
  const fbSteps = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM steps s JOIN sessions se ON se.id=s.session_id
         WHERE se.case_id='case_fb' AND s.direction IS NULL`,
      )
      .get() as { c: number }
  ).c;
  check(
    '只跑过兜底调用、一次 open_step 都没有的调查：started 为真而 steps 为 0',
    fbSteps === 1 && !!fbRow.started && fbRow.steps === 0 && fbRow.headline === null,
    `库里兜底步 ${fbSteps} 个 · started=${fbRow.started} · steps=${fbRow.steps} —— ` +
      '兜底步个数必须非 0，否则"steps 数全部步"那种写法在这份夹具上也算得对，这条就是空的',
  );
  /** 库里那一行接成历史页那一行（`started` 在 SQLite 里是 0/1）。运行时那一半这儿用不到。 */
  const asListRow = (over: Partial<CaseListRow> = {}): CaseListRow => ({
    id: fbRow.id,
    title: fbRow.title,
    status: fbRow.status,
    updatedAt: fbRow.updated_at,
    current: false,
    todos: 0,
    running: false,
    started: !!fbRow.started,
    loaded: false,
    projectRoot: fbRow.project_root,
    incidentDate: fbRow.incident_date,
    verdictShape: null,
    steps: fbRow.steps,
    headline: fbRow.headline,
    ...over,
  });
  check(
    '这一行写的是「已开始」，不是「还没开始查」',
    caseSnip(asListRow()) === '已开始，还没有明确方向' &&
      caseSnip(asListRow({ started: false })) === '还没开始查' &&
      caseSnip(asListRow({ steps: 3 })) === '3 步，还没有结论' &&
      caseSnip(asListRow({ headline: '就是它' })) === '就是它',
    '四档都验：按步数分档的话，这次调查在历史页写着「还没开始查」，' +
      '而它的工作区信息卡上正列着那几次调用',
  );

  // ── ⑦ 载入着的调查不会被切换栏的条数上限截掉 ────────────────────────────
  //
  // 待办只活在运行时里：被截掉的话，那次调查连同它的「等你 N」一起从切换栏和
  // 全局汇总里消失，人看不见也切不回去——D28 要保的正是这个
  const flood = new CaseRegistry<CaseRunner>({ db, create: loadRunner, maxLive: 2 });
  flood.adopt('case_z', idle); // 挂着一条待办
  for (let i = 0; i < 25; i++) {
    const id = `case_bulk${i}`;
    makeRunner(id, `批量调查 ${i}`).close();
    // 让它们的最近活动都比 case_z 新，把 case_z 挤出前 20
    db.prepare(`UPDATE cases SET updated_at=? WHERE id=?`).run(Date.parse('2027-01-01') + i, id);
  }
  const flooded = flood.briefs();
  check(
    '载入着的调查不会被切换栏的条数上限截掉，待办跟着还在',
    flooded.some((c) => c.id === 'case_z' && c.todos === 1),
    `共 ${flooded.length} 行，case_z ${flooded.some((c) => c.id === 'case_z') ? '在' : '被截掉了'}`,
  );

  // ── ⑧ 会话收尾后要能再开一轮 ────────────────────────────────────────────
  //
  // `start()` 见 `this.q` 还在就退化成 `send()`。会话跑完 / 崩了之后不把它清掉的话，
  // 消息会塞进一个已经没人消费的 inbox：界面永久停在「进行中」，agent 那侧什么都没收到，
  // 「同一个运行时接着查」这条路从 UI 根本走不通
  const ending = makeRunner('case_v', '会话收尾');
  const ep = ending as unknown as Probe & {
    q: unknown;
    inbox: unknown;
    consume(q: unknown): Promise<void>;
  };
  ep.beginSession();
  ep.status = 'live';
  const inboxBefore = ep.inbox;
  // 假的查询：迭代完就结束，等同于 agent 那轮自己收了尾
  ep.q = { async *[Symbol.asyncIterator]() {}, close() {} };
  await ep.consume(ep.q);
  check(
    '会话收尾后 query 与输入流都换掉，下一轮 start() 才不会退化成往死队列里发',
    ep.q === null && ep.inbox !== inboxBefore && ending.sessionStatus === 'ended',
    `q=${ep.q} inbox 换过=${ep.inbox !== inboxBefore} status=${ending.sessionStatus}`,
  );

  // ── ⑨ 一轮失败但会话没结束（凭据过期实测到的形态）─────────────────────────
  //
  // 消息流一直开着，`consume` 不返回，状态永远停在 live——界面显示「会话中」却什么都不动。
  // ⚠️ 只有 `is_error` 可信：实测那条 result 的 `subtype` 仍是 "success"
  const failing = makeRunner('case_u', '凭据过期');
  const fp = failing as unknown as Probe & { q: unknown; consume(q: unknown): Promise<void> };
  fp.beginSession();
  fp.status = 'live';
  fp.q = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result',
        is_error: true,
        subtype: 'success',
        result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      };
      // 真实形态：给完这条就一直挂着，不结束。这里用一个永不落地的 await 模拟
      await new Promise(() => {});
    },
    close() {},
  };
  void fp.consume(fp.q);
  await new Promise((r) => setTimeout(r, 20));
  const failedSnap = failing.snapshot();
  check(
    '一轮失败但会话没结束时，失败原因进快照（UI 才有重开的入口）',
    failedSnap.lastError?.includes('OAuth') === true && failedSnap.sessionStatus === 'live',
    `lastError=${failedSnap.lastError?.slice(0, 40)} status=${failedSnap.sessionStatus}`,
  );

  // ── ⑩ 显式重开：旧 consume 醒来时不能拆掉新会话 ─────────────────────────
  //
  // `restart()` 先 close() 再 start()，而旧查询的 consume 要晚一拍才醒。它若不认自己那一次
  // 查询，就会拿**新** session 去 endOnce（刚开的会话当场标成结束，后续步骤还继续往里写）、
  // 把新 q 置空、再换掉新查询正在消费的 inbox——重开原地作废，且没有任何报错
  const restarting = makeRunner('case_t', '重开竞态');
  const rp = restarting as unknown as Probe & {
    q: unknown;
    inbox: unknown;
    session: unknown;
    consume(q: unknown): Promise<void>;
  };
  rp.beginSession();
  rp.status = 'live';
  // 旧查询：close() 之后才结束，模拟「关掉了但 consume 还没醒」
  let releaseOld: () => void = () => {};
  const oldQ = {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((r) => (releaseOld = r));
    },
    close() {},
  };
  rp.q = oldQ;
  const oldConsume = rp.consume(oldQ);

  // 人点了「重开一轮会话」：close() 收掉旧的，start() 起新的（这里只走到建新 session 为止）
  restarting.close();
  rp.beginSession();
  rp.status = 'live';
  const freshSession = rp.session;
  const freshInbox = rp.inbox;
  const newQ = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, close() {} };
  rp.q = newQ;
  void rp.consume(newQ);

  // 旧 consume 这时才醒
  releaseOld();
  await oldConsume;
  await new Promise((r) => setTimeout(r, 20));

  const tSessions = db
    .prepare(`SELECT status FROM sessions WHERE case_id='case_t' ORDER BY started_at`)
    .all() as { status: string }[];
  check(
    '旧 consume 醒来不会拆掉刚重开的会话',
    rp.q === newQ &&
      rp.inbox === freshInbox &&
      rp.session === freshSession &&
      restarting.sessionStatus === 'live' &&
      tSessions.map((s) => s.status).join(',') === 'ended,live',
    `q 还是新的=${rp.q === newQ} inbox 没被换=${rp.inbox === freshInbox} status=${restarting.sessionStatus} sessions=${tSessions.map((s) => s.status).join(',')}`,
  );

  // ── ⑪ 重试成功之后错误横幅要消失 ────────────────────────────────────────
  const recovering = makeRunner('case_s', '失败后恢复');
  const sp = recovering as unknown as Probe & { q: unknown; consume(q: unknown): Promise<void> };
  sp.beginSession();
  sp.status = 'live';
  const recoverQ = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', is_error: true, result: '这一轮炸了' };
      yield { type: 'result', is_error: false, result: '好了' };
      await new Promise(() => {});
    },
    close() {},
  };
  sp.q = recoverQ;
  void sp.consume(recoverQ);
  await new Promise((r) => setTimeout(r, 20));
  check(
    '同一会话里重试成功后，错误横幅跟着消失',
    recovering.snapshot().lastError === null,
    `lastError=${recovering.snapshot().lastError}`,
  );

  // ── ⑫ preview 不整份读大 blob ───────────────────────────────────────────
  const big = ['第一行 head', '第二行 head', ...Array.from({ length: 200_000 }, (_, i) => `噪声行 ${i}`)].join('\n');
  const stored = storeBlob(blobs, big);
  const head = readBlobHead(blobs, stored.sha256, 4096);
  check(
    'preview 只读开头：拿得到前几行，且没有把整份 blob 读进来',
    head !== null &&
      head.startsWith('第一行 head\n第二行 head') &&
      Buffer.byteLength(head) <= 4096 &&
      Buffer.byteLength(big) > 1_000_000,
    `读回 ${Buffer.byteLength(head ?? '')} 字节 / 全量 ${Buffer.byteLength(big)} 字节`,
  );

  // ── ⑬ 新建调查面板模式：没有当前调查，但切换栏与全局待办照常 ──────────────────
  //
  // 点「＋ 新调查」的那一刻 currentId 就是 null，而 renderer 要等下一次快照才换屏。
  // main 侧那些依赖当前调查的 IPC 因此必须判空——用 `!` 的话这中间旧界面发一次消息
  // 就是个 TypeError，用户那侧只看到输入框被清空、内容没了。
  // 同时「别处还有几条待办」在新建调查页上也得数得出来，否则新立一次调查就把它们看丢了
  const intakeReg = new CaseRegistry<CaseRunner>({ db, create: loadRunner });
  intakeReg.adopt('case_z', idle);
  intakeReg.toIntake();
  const intakeBriefs = intakeReg.briefs();
  check(
    '进新建调查面板后没有当前调查，但切换栏与别处的待办还在',
    intakeReg.current === null &&
      intakeReg.currentCaseId === null &&
      intakeBriefs.every((c) => !c.current) &&
      intakeBriefs.find((c) => c.id === 'case_z')?.todos === 1,
    `current=${intakeReg.current} 共 ${intakeBriefs.length} 行 case_z 待办=${intakeBriefs.find((c) => c.id === 'case_z')?.todos}`,
  );

  // ── ⑭ 切过去之后，旧界面那一下不能落到新调查头上 ──────────────────────────
  //
  // 光判空不够：切换是同步生效的，所以 `current` 这时已经是**新**调查了。
  // renderer 在调查 A 里按下的发送带的还是 A 的 id，不核对就正正好写进 B 的会话，
  // 而且还会回一个「送到了」把 A 的草稿清掉
  const stale = new CaseRegistry<CaseRunner>({ db, create: loadRunner });
  stale.switchTo('case_x');
  stale.switchTo('case_w'); // 人点了调查 B ；旧界面还没换屏
  check(
    '切过去之后，带着旧 caseId 的调用不再被投递',
    stale.currentIf('case_x') === null && stale.currentIf('case_w') === stale.current,
    `拿旧 id 要=${stale.currentIf('case_x')} 拿新 id 要=${stale.currentIf('case_w') ? '当前 runner' : 'null'}`,
  );

  // ── ⑮ 静止的运行时也有上限，且钉住的那几种不受影响 ────────────────────────
  //
  // 活跃会话那条限流只看 `live`，跑完的 / 只点开看过一眼的一个都不会被收——
  // 它们既占内存，又因为「载入着就钉住」把切换栏的条数上限彻底架空
  const many = new CaseRegistry<CaseRunner>({ db, create: loadRunner, maxLoaded: 4 });
  many.adopt('case_z', idle); // 挂着一条待办，不该被收
  for (let i = 0; i < 12; i++) many.switchTo(`case_bulk${i}`);
  const loadedIds = many.briefs().filter((c) => c.loaded).map((c) => c.id);
  check(
    '只点开看过的运行时会被收掉，载入数有上限',
    loadedIds.length <= 4,
    `还载入着 ${loadedIds.length} 个：${loadedIds.join(' ')}`,
  );
  check(
    '挂着待办的和当前那个不会被收',
    loadedIds.includes('case_z') && loadedIds.includes('case_bulk11'),
    `case_z ${loadedIds.includes('case_z') ? '在' : '被收了'} · 当前 case_bulk11 ${loadedIds.includes('case_bulk11') ? '在' : '被收了'}`,
  );

  // ── ⑯ 只是点开看过的老调查，不该靠「载入着」把自己钉进切换栏 ────────────────
  //
  // 上面那 25 个 bulk 调查都比 case_x 新，所以 case_x 早就在 20 名开外了。
  // 把它点开看一眼——若「载入着就钉住」，它会重新冒到切换栏上，条数上限就此形同虚设
  // （载入数有上限，所以不会无限长，但仍会稳定地多出一截）
  const pinReg = new CaseRegistry<CaseRunner>({ db, create: loadRunner });
  pinReg.switchTo('case_x');
  pinReg.switchTo('case_bulk24');
  const pinRows = pinReg.briefs();
  check(
    '只点开看过的老调查不会把自己钉进切换栏',
    pinRows.length <= 20 && !pinRows.some((c) => c.id === 'case_x'),
    `共 ${pinRows.length} 行，case_x ${pinRows.some((c) => c.id === 'case_x') ? '还在里面' : '没在'}`,
  );

  // ── ⑯.5 跨 case 检索接上切换栏（ui.md §8.3 / data-model §5） ─────────────
  //
  // FTS5 那两张表建好很久了，一直没有人查。接上去之后这一带的错法都很安静：
  // 只列不搜时人还知道"搜不了"，搜出来的东西不对却看不出是漏了一整类索引
  // 还是那次调查真没提过——所以每一类命中来源都要有一条自己的检查。
  const fx = makeRunner('case_fts', '订单支付回调丢了');
  const fxs = (fx as unknown as Probe).beginSession();
  const fxStep = await fxs.store.openStep({ direction: '怀疑回调被幂等键挡掉了' });
  fxs.recordToolStart({ callId: 'call_fts1', toolName: 'mcp__datasource__query_logs', input: { q: 'x' } });
  fxs.recordToolEnd({ callId: 'call_fts1', output: '命中 1 条\n09:00:00 callback dropped\n(end)' });
  await fxs.store.closeStep({
    stepId: fxStep.stepId,
    status: 'confirmed',
    verdict: '幂等键把重复回调连同首次一起挡了',
    confidence: 0.9,
    evidence: [{ callRef: '#1', anchor: '2', claim: '回调在网关层就被丢弃', occurredAt: '09:00:00' }],
  });
  // 建完单没跑过的调查：**只有建单信息那一条索引救得了它**。不索引 `case.opened` 的话，
  // 它在检索里根本不存在，而"建完单先放着、过几天回来找"正是常态
  makeRunner('case_fts_new', '证书过期导致握手失败');

  const hitIds = (t: string) => searchCases(db, t).map((c) => c.id);
  check(
    '检索按调查归并：一次调查多条命中只出一行，条数照实报',
    (() => {
      const r = searchCases(db, '幂等');
      const fts = r.find((c) => c.id === 'case_fts');
      return new Set(r.map((c) => c.id)).size === r.length && fts?.hits === 2;
    })(),
    JSON.stringify(searchCases(db, '幂等')),
  );
  check(
    '建完单还没跑过的调查也搜得到（建单信息进了索引）',
    hitIds('证书过期').includes('case_fts_new'),
    `命中=${JSON.stringify(searchCases(db, '证书过期'))}`,
  );
  check(
    '中文 2 字回退 LIKE，照样命中（trigram 的 MATCH 在 <3 字时不成立）',
    hitIds('回调').includes('case_fts') && searchNarrative(db, '回调').length > 0,
    `"回调"→${hitIds('回调').join(',')}（走 MATCH 的话这里是 0 条，而人只会以为这个词搜不到）`,
  );
  // 走 MATCH 还是 LIKE 按 **code point** 数分：`String.length` 数的是 UTF-16 单元，
  // 而 emoji / CJK 扩展区一个字占两个——按它判的话两个这样的字会被当成够 3 字送进 MATCH，
  // trigram 那侧只数出 2 个字符，于是原文明明在库里也回零条
  check(
    '补充平面字符按字符数判长度，不按 UTF-16 单元数（两个 emoji 仍走得到 LIKE）',
    (() => {
      db.prepare(`INSERT INTO narrative_fts (ref_id,ref_kind,case_id,text) VALUES (?,?,?,?)`).run(
        'probe_astral',
        'verdict',
        'case_fts',
        '灰度批次 \u{1F525}\u{1F525} 全量回滚',
      );
      const n = searchNarrative(db, '\u{1F525}\u{1F525}').length;
      db.prepare(`DELETE FROM narrative_fts WHERE ref_id='probe_astral'`).run();
      return n > 0;
    })(),
    '按 String.length 判的话这里是 0 条（"🔥🔥".length === 4 却只有 2 个字符）',
  );
  check(
    'LIKE 那条路上的通配符要转义：搜一个 % 不该把全部调查翻出来',
    searchCases(db, '%').length === 0,
    `"%"→${searchCases(db, '%').length} 个调查（不转义的话它匹配一切）`,
  );
  check(
    '空串回空数组，不回"全部"',
    searchCases(db, '').length === 0 && searchCases(db, '   ').length === 0,
    `""→${searchCases(db, '').length} · "   "→${searchCases(db, '   ').length}`,
  );
  // 排序与最近列表同一条规则。按命中条数排的话，同一次调查在两份列表里的位置会对不上，
  // 而两份列表长得一模一样——人会以为搜到的是另一次调查
  check(
    '检索结果的排序与最近列表同一条规则（进行中在前、同档按最近活动倒序）',
    (() => {
      // **拿 `caseList` 的实际顺序对，不在这儿把规则再写一遍**：
      // 重写一遍的话，这条检查验的是"我这次抄对了没有"，而不是"两处是不是同一条规则"
      const rank = new Map(caseList(db, { limit: 9999 }).map((c, i) => [c.id, i]));
      const got = searchCases(db, '的问题').map((c) => c.id);
      return (
        got.length > 1 &&
        got.every((id, i) => i === 0 || rank.get(got[i - 1]!)! < rank.get(id)!)
      );
    })(),
    `顺序=${searchCases(db, '的问题').map((c) => c.id).slice(0, 6).join(',')}`,
  );
  // 摘要要围着命中处取：从头截 60 字的话，命中在后半段的那条看着像根本没命中
  check(
    '摘要围着命中处取，不是从头截一段',
    (() => {
      const long = `${'铺垫'.repeat(60)}关键词在很后面`;
      db.prepare(`INSERT INTO narrative_fts (ref_id,ref_kind,case_id,text) VALUES (?,?,?,?)`).run(
        'probe_long',
        'verdict',
        'case_fts',
        long,
      );
      const snip = searchCases(db, '关键词在很后面')[0]?.snippet ?? '';
      db.prepare(`DELETE FROM narrative_fts WHERE ref_id='probe_long'`).run();
      return snip.includes('关键词在很后面') && snip.startsWith('…');
    })(),
    '命中处落在第 120 字上：从头截的话摘要里一个匹配的字都看不到',
  );
  // 命中出处的优先级：人记得的是自己写的问题，其次才是结论；对话带最长最杂，排最后
  check(
    '同一调查里多类命中时，摘要挑优先级最高的那一类',
    (() => {
      db.prepare(`INSERT INTO narrative_fts (ref_id,ref_kind,case_id,text) VALUES (?,?,?,?)`).run(
        'probe_chat',
        'chat:user',
        'case_fts',
        '幂等这事我早就说过了',
      );
      const where = searchCases(db, '幂等')[0]?.where;
      db.prepare(`DELETE FROM narrative_fts WHERE ref_id='probe_chat'`).run();
      return where === 'verdict';
    })(),
    '按到达顺序取的话，摘要会变成对话带里那句"好的我这就查"',
  );
  // 指不到 cases 的命中是脏索引：拿它渲染出的 chip 点下去会切到一个不存在的调查，
  // 而 `switchTo` 只是回个 false——界面一动不动，看起来像按钮坏了
  check(
    '指不到调查的命中直接丢掉，不渲染成一个点不动的 chip',
    (() => {
      db.prepare(`INSERT INTO narrative_fts (ref_id,ref_kind,case_id,text) VALUES (?,?,?,?)`).run(
        'probe_orphan',
        'verdict',
        'case_ghost',
        '孤儿索引里的独特词',
      );
      const r = searchCases(db, '孤儿索引里的独特词');
      db.prepare(`DELETE FROM narrative_fts WHERE ref_id='probe_orphan'`).run();
      return r.length === 0;
    })(),
    'INNER JOIN cases 是这条的唯一保障',
  );
  // 🔴 **`ESCAPE` 子句会把 trigram 的 LIKE 优化整个关掉**（实测 `INDEX 0:L3` → `INDEX 0:`，
  // 罕见词 0.1ms → 5.1ms，且随表增长）。所以只在查询串真的含通配符时才带它。
  // 验的是**真正被 prepare 出去的那条 SQL**，不在这儿照抄一份——照抄的话验的是我抄对没有
  const prepared: string[] = [];
  const spy = new Proxy(db, {
    get(t, k, r) {
      if (k !== 'prepare') return Reflect.get(t, k, r);
      return (sql: string) => (prepared.push(sql), t.prepare(sql));
    },
  }) as typeof db;
  searchNarrative(spy, '回调');
  const plainSql = prepared.at(-1)!;
  // 通配符那条只在 **<3 字**（LIKE 那条路）上有意义：≥3 字走的是 MATCH 的引号短语，
  // `%` `_` 在那儿本来就不是通配符。拿一个 3 字的串验会走进 MATCH，检查就成了空的
  searchNarrative(spy, 'a_');
  const wildSql = prepared.at(-1)!;
  const planOf = (sql: string, ...a: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[])
      .map((r) => r.detail)
      .join(' / ');
  check(
    '不含通配符的查询串不带 ESCAPE，因而用得上 trigram 的 LIKE 索引',
    !plainSql.includes('ESCAPE') &&
      planOf(plainSql, '%回调%', MAX_HITS).includes('L3') &&
      wildSql.includes('ESCAPE'),
    `普通=${planOf(plainSql, '%回调%', MAX_HITS)} · 带通配符那条${wildSql.includes('ESCAPE') ? '有' : '没有'} ESCAPE（一律带 ESCAPE 的话这里是 INDEX 0: 而不是 L3）`,
  );
  // 主导成本不是扫描，是把命中全搬回来——而这条查询人每打一个字就跑一次
  const bulkFts = db.prepare(`INSERT INTO narrative_fts (ref_id,ref_kind,case_id,text) VALUES (?,?,?,?)`);
  db.transaction(() => {
    for (let i = 0; i < MAX_HITS + 500; i++) bulkFts.run(`probe_flood_${i}`, 'verdict', 'case_fts', `洪水词条目 ${i}`);
  })();
  const cappedHits = searchNarrative(db, '洪水词').length;
  const floodedCases = searchCases(db, '洪水词').length;
  db.prepare(`DELETE FROM narrative_fts WHERE ref_id LIKE 'probe_flood_%'`).run();
  check(
    '一次检索最多搬回 MAX_HITS 条命中，代价与库的大小脱钩',
    cappedHits === MAX_HITS && floodedCases > 0,
    `${MAX_HITS + 500} 条可命中 → 搬回 ${cappedHits} 条 / ${floodedCases} 个调查（不截的话 5 万行的表上一个常见词就是 30ms 卡在 main 线程）`,
  );

  // 检索结果与最近列表是同一种 chip：少合运行时那一半，一个正等着人的调查
  // 会被搜出来显示成"已停"，而跨 case 汇总要保的正是别让那条支线静静挂死
  const fxReg = new CaseRegistry<CaseRunner>({ db, create: loadRunner });
  const fxLive = makeRunner('case_fts');
  fxReg.adopt('case_fts', fxLive);
  void (fxLive as unknown as Probe).askOperator({
    engine: 'mysql',
    statement: 'SELECT 1',
    why: '看一眼',
    expect: '一条',
  });
  fxReg.switchTo('case_x');
  check(
    '检索结果合上了运行时那一半（等你 N / 跑动中 / 载入着）',
    (() => {
      const hit = fxReg.search('幂等').find((c) => c.id === 'case_fts');
      return hit?.todos === 1 && hit.loaded === true && hit.current === false;
    })(),
    JSON.stringify(fxReg.search('幂等')),
  );
  // 命中是一次性查出来的，而运行时那一半每 60ms 会变。**渲染前要按最新快照兑一次**——
  // 不兑的话，人停在检索结果上的这段时间里新冒出来的待办一条都不显示，
  // 而跨 case 汇总存在的全部理由就是别让那条支线静静挂死
  const staleHits = fxReg.search('幂等');
  const withTodo = fxReg.briefs();
  check(
    '检索命中渲染前按最新快照兑运行时状态（等你 N / 跑动中 / 当前）',
    (() => {
      // 造一份"查出来时还没有待办"的命中，再拿带着待办的最新列表去兑
      const cold = staleHits.map((h) => ({ ...h, todos: 0, running: false, current: false }));
      const merged = freshenHits(cold, withTodo);
      return merged.find((c) => c.id === 'case_fts')?.todos === 1;
    })(),
    `兑之前 todos=0，兑之后 todos=${freshenHits(staleHits.map((h) => ({ ...h, todos: 0 })), withTodo).find((c) => c.id === 'case_fts')?.todos}`,
  );
  check(
    '不在最新列表里的命中按"静的"算，不保留查出来那一刻的旧值',
    (() => {
      // 切换栏把「当前的 / 还跑着的 / 挂着待办的」全部钉住，所以不在列表里 ⟺ 三样都不是。
      // 保留旧值的话，一条刚被处理掉的待办会在检索结果上一直挂着「等你 3」
      const ghost = freshenHits(
        staleHits.map((h): CaseHit => ({ ...h, id: 'case_gone', todos: 3, running: true, current: true })),
        withTodo,
      );
      return ghost[0]?.todos === 0 && ghost[0]?.running === false && ghost[0]?.current === false;
    })(),
    JSON.stringify(freshenHits(staleHits.map((h) => ({ ...h, id: 'case_gone', todos: 3 })), withTodo)[0]),
  );
  check(
    '兑的只是运行时那一半：命中的原因（hits / snippet / where）原样留着',
    (() => {
      const merged = freshenHits(staleHits, withTodo).find((c) => c.id === 'case_fts');
      const orig = staleHits.find((c) => c.id === 'case_fts');
      return !!orig && merged?.snippet === orig.snippet && merged.where === orig.where && merged.hits === orig.hits;
    })(),
    '把命中的原因也一起兑掉的话，chip 上那句"为什么它被搜出来"会随快照抖没',
  );
  fxReg.closeAll();

  // ── ⑰ 待办处置要有回执，不能静默丢掉 ────────────────────────────────────
  //
  // 这两个手势按 id 查表，切了调查之后查的是**新**调查的表，随机 id 当然对不上——
  // 于是静默什么也不做。①档那侧是人贴进去的查询结果凭空消失、回填继续挂到超时；
  // ②档那侧更重：人明明按了「拒绝」，这条却继续挂着，三分钟后按预设**自动放行**
  const disp = makeRunner('case_r', '处置回执');
  const dispProbe = disp as unknown as Probe & {
    gate(
      name: string,
      input: Record<string, unknown>,
      opts: { toolUseID: string; signal: AbortSignal },
    ): Promise<unknown>;
  };
  dispProbe.beginSession();

  check(
    '处置一条不在本次调查手里的待办，回 false 而不是静默丢掉',
    disp.answerOperator({ id: 'ask_nope', action: 'answer', answer: 'y' }) === false &&
      disp.decideGate({ id: 'call_nope', action: 'deny', message: '不行' }) === false,
    `回填=${disp.answerOperator({ id: 'ask_nope', action: 'answer', answer: 'y' })} 闸门=${disp.decideGate({ id: 'call_nope', action: 'deny', message: '不行' })}`,
  );

  void dispProbe.askOperator({
    engine: 'mysql',
    statement: 'SELECT 1',
    why: '看一眼',
    expect: '预期只有一条',
  });
  const askId = disp.snapshot().pending[0]!.id;
  void dispProbe.gate(
    'mcp__logs__query',
    { q: 'drop table' },
    { toolUseID: 'call_r1', signal: new AbortController().signal },
  );
  check(
    '真落地了的回 true，人的判决确实到账',
    disp.answerOperator({ id: askId, action: 'answer', answer: '只有一条' }) === true &&
      disp.decideGate({ id: 'call_r1', action: 'deny', message: '这条会写库，改用 ask_operator' }) === true,
    `回填=${askId.slice(0, 10)} 已处置 · 闸门 call_r1 已处置`,
  );

  // ── ⑱ 重开必须换掉输入流 ────────────────────────────────────────────────
  //
  // `createInbox` 是个 async generator，**只能有一个消费者**。收尾时不换掉的话，
  // `restart()` 随后 push 的开场白会被还挂在 `next()` 上的旧查询取走，或者旧迭代器
  // 一关新查询直接看到 done——库里已经有新 session、界面显示进行中，agent 什么都没收到。
  //
  // ⚠️ 这条要**真的去消费那个 generator**：只比较 inbox 引用是验不出来的。
  const handoff = makeRunner('case_q', '输入流交接');
  const hp = handoff as unknown as Probe & {
    inbox: { iterable: AsyncGenerator<{ message: { content: string } }>; push(t: string): void };
  };
  hp.beginSession();
  hp.status = 'live';
  const oldInbox = hp.inbox;
  // 旧查询正挂在 next() 上等下一条——`close()` 那一刻它就是这个样子
  const oldWaiting = oldInbox.iterable.next();
  handoff.close();

  const newInbox = hp.inbox;
  newInbox.push('开场白');
  const raced = await Promise.race([
    newInbox.iterable.next().then((m) => String(m.value?.message?.content ?? '(done)')),
    new Promise<string>((r) => setTimeout(() => r('(新查询没拿到)'), 80)),
  ]);
  const stolen = await Promise.race([
    oldWaiting.then((m) => String(m.value?.message?.content ?? '(done)')),
    new Promise<string>((r) => setTimeout(() => r('(没被旧的取走)'), 80)),
  ]);
  check(
    '收尾后换掉输入流：开场白进得了新查询，也不会被正在收尾的旧查询取走',
    newInbox !== oldInbox && raced === '开场白' && stolen === '(没被旧的取走)',
    `新查询拿到=${raced} · 旧查询=${stolen}`,
  );

  // ── ⑲ 卡片草稿要对账，不能只靠「处置成功」那一条路清 ──────────────────────
  //
  // 闸门到点自动放行、回填超时作废、停止/重开把待办整批散掉、后台 runner 被回收——
  // 这几条路上卡片都会从快照消失，却都不会回执处置成功。条目 id 每次都不同、App 长驻，
  // 不对账的话草稿只增不减，里面还可能躺着人粘进去的整段查询结果
  const drafts: CardDrafts = {
    [draftKey('case_a', 'ask_gone')]: { answer: '粘了很长一段的查询结果' },
    [draftKey('case_a', 'gate_live')]: { note: '这条不行' },
    [draftKey('case_b', 'ask_elsewhere')]: { answer: '另一次调查上写到一半的' },
  };
  const pruned = pruneDrafts(drafts, 'case_a', ['gate_live']);
  check(
    '本次调查里已经消失的条目，草稿跟着清掉',
    !(draftKey('case_a', 'ask_gone') in pruned) && draftKey('case_a', 'gate_live') in pruned,
    `剩下 ${Object.keys(pruned).join(' ')}`,
  );
  check(
    '别的调查的草稿一条都不动——它们的待办这会儿根本不在快照里',
    pruned[draftKey('case_b', 'ask_elsewhere')]?.answer === '另一次调查上写到一半的',
    `case_b 的草稿${draftKey('case_b', 'ask_elsewhere') in pruned ? '还在' : '被误删了'}`,
  );
  check(
    '没得清就原样返回，不白白多触发一次渲染',
    pruneDrafts(pruned, 'case_a', ['gate_live']) === pruned,
    '返回的是同一个对象',
  );

  // ── 工作区菜单右边那一列：上一级路径 ──────────────────────────────────────
  check(
    '砍掉末级目录名，留住上面几级',
    rootParent('/Users/ziyu/Projects/inquestry') === '/Users/ziyu/Projects',
    rootParent('/Users/ziyu/Projects/inquestry'),
  );
  check(
    '末尾的斜杠不算一级——不然砍出来的还是原路径',
    rootParent('/Users/ziyu/Projects/inquestry/') === '/Users/ziyu/Projects',
    rootParent('/Users/ziyu/Projects/inquestry/'),
  );
  check(
    '根下面那一级砍出来是 `/`，不是空串',
    rootParent('/srv') === '/',
    rootParent('/srv'),
  );

  // ── ⑳ 定稿确认条上「状态型填不填得出来」该信哪一份 ────────────────────────
  //
  // 确认条冻的是弹出那一刻 main 算出来的整份建议，而快照 60ms 换一次。两边都不能一律信：
  // 一律用冻住的，agent 补上那一对之后警告永远不消失；一律用实时的，根因**换了人**时
  // 两者指着不同的步——预选的是新根因声明的 state，却按旧根因判定成"填得出来"，
  // 一句提醒都没有，人当场确认就冻出一份空主体报告
  const frozenOn = (rootStepId: string | null, fill: boolean): ShapeSuggestion => ({
    shape: 'state',
    source: 'agent',
    rootStepId,
    stateFillable: fill,
  });
  check(
    '还是同一条根因：信实时的，agent 补上那一对之后警告自动消失',
    stateFillable(frozenOn('st_a', false), frozenOn('st_a', true)) === true,
    '冻住时填不出来 → 实时说填得出来 → 认实时',
  );
  check(
    '根因换了人：用冻住那份，不拿新根因的形态配旧根因的结论',
    stateFillable(frozenOn('st_b', false), frozenOn('st_a', true)) === false,
    '冻的是 st_b（填不出来），实时那份说的是 st_a —— 认实时的话这里一句提醒都没有',
  );
  check(
    '还没冻（归档那一档没有确认形态）就用实时的',
    stateFillable(undefined, frozenOn('st_a', true)) === true,
    '没有冻住的那一份',
  );

  // ── ㉑ 删掉一次调查：库里、事件里、索引里、磁盘上都要没有它 ─────────────────
  //
  // 这一整段验的都是**不报错的错法**：
  //
  //   1. 只删投影不删事件 —— 屏幕上当场没了，下一次 `rebuildProjections`（同 schema 内
  //      的正式迁移手段）把它连同证据原文一起建回来，于是「删了」自己撤销
  //   2. 忘了两张 FTS —— 虚拟表没有外键，留下的是指不到 `cases` 的脏索引。
  //      `searchCases` 靠 INNER JOIN 把它挡在结果外，所以从界面上**永远看不出来**，
  //      索引只是一直长
  //   3. 跟着 case 一起删 blob —— 它是内容寻址、跨调查共享的：另一次调查引用同一份原文时，
  //      那次调查的证据当场读不出来了，而它自己一点没被动过
  //   4. 只按 `tool_calls` 认 blob 的归属 —— `sweepZombies` 补记输出仍是两条事件两个事务，
  //      卡在中间时 blob 已经落了、`tool_calls.output_sha256` 还是空的。
  //      两个方向都错：自己那份漏删，别人那份误删
  //   5. 文件删不掉就此不管 —— 库里已经没有任何一行指得到它，谁也不知道该去删哪个文件。
  //      欠账记进 `blob_trash`，启动时接着删；而重删之前必须再问一次"现在还有没有人用它"，
  //      因为 blob 是内容寻址的，欠着的这段时间里它完全可能又活过来
  //
  // 换一份干净的库跑：这一段要删东西，与上面那些共用同一个库的话，后面的检查会跟着漂。
  {
    const keepDb = db;
    const keepBlobs = blobs;
    const wipeFile = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-wipe-')), 'inquestry.db');
    db = openDatabase(wipeFile);
    blobs = blobDir(wipeFile);

    const doomed = makeRunner('case_doom', '要删掉的那次');
    // 两次调查的这一步输出逐字相同 → 同一个 sha → **共享的那份 blob**
    await work(doomed, '删掉的这条', 'call_d1', '10:00:00');
    // 第二步换个时间串，输出就不一样了 → 只有它引用的那份 blob
    await work(doomed, '删掉的那条的第二步', 'call_d2', '10:30:00');
    // 下面两步造那个"两条事件之间"的窗口，落库之后手工把引用抹掉（见 nulled）
    await work(doomed, '删掉的那条落了原文但没记上引用', 'call_d3', '10:45:00');
    await work(doomed, '与留下那条共有、而对面没记上引用', 'call_d4', '11:00:00');
    (doomed as unknown as Probe).pushChat('user', '这次不查了');
    doomed.close();

    const keeper = makeRunner('case_keep', '要留下的那次');
    await work(keeper, '留下的这条', 'call_k1', '10:00:00');
    await work(keeper, '留下的这条落了原文但没记上引用', 'call_k2', '11:00:00');
    keeper.close();

    const shaOf = (callId: string) =>
      (db.prepare(`SELECT output_sha256 s FROM tool_calls WHERE id=?`).get(callId) as { s: string }).s;
    const shared = shaOf('call_d1');
    const soleOwn = shaOf('call_d2');
    const strayOwn = shaOf('call_d3');
    const strayShared = shaOf('call_d4');
    const countIn = (sql: string, ...args: unknown[]) =>
      (db.prepare(sql).get(...(args as [])) as { c: number }).c;

    check(
      '夹具立得住：共享那份 blob 真的被两次调查引用，独占那份只被一次',
      shared === shaOf('call_k1') && shared !== soleOwn && strayShared === shaOf('call_k2'),
      `共享 ${shared.slice(0, 8)} · 独占 ${soleOwn.slice(0, 8)} · 跨案那份 ${strayShared.slice(0, 8)}`,
    );

    /**
     * 造出「`blob.stored` 落了、`toolcall.completed` 还没落」那一刻的库状态。
     *
     * 直接抹掉引用而不是真去杀进程：**要验的是删除读的是哪一份归属**，而那一刻的库状态
     * 就是这个样子——`blobs` 行、`payload_fts` 行、磁盘文件都在，`output_sha256` 是空的。
     * `sweepZombies` 补记时两条事件仍各占一个事务（`emitTo`），所以这个窗口是真实存在的、不是想出来的。
     */
    db.prepare(`UPDATE tool_calls SET output_sha256=NULL WHERE id IN ('call_d3','call_k2')`).run();
    check(
      '夹具立得住：那两条的引用真的空了，而 blob 与 payload_fts 都还在',
      countIn(`SELECT COUNT(*) c FROM tool_calls WHERE output_sha256 IS NULL`) === 2 &&
        countIn(`SELECT COUNT(*) c FROM blobs WHERE sha256='${strayOwn}'`) === 1 &&
        countIn(`SELECT COUNT(*) c FROM payload_fts WHERE sha256='${strayShared}' AND case_id='case_keep'`) === 1,
      '抹的是引用不是 blob —— 造的正是"原文落了、引用还没落"那一刻',
    );

    const gone = deleteCase(db, 'case_doom', { blobDir: blobs }).ok;
    const after = {
      cases: countIn(`SELECT COUNT(*) c FROM cases WHERE id='case_doom'`),
      events: countIn(`SELECT COUNT(*) c FROM events WHERE case_id='case_doom'`),
      steps: countIn(
        `SELECT COUNT(*) c FROM steps WHERE session_id IN (SELECT id FROM sessions WHERE case_id='case_doom')`,
      ),
      sessions: countIn(`SELECT COUNT(*) c FROM sessions WHERE case_id='case_doom'`),
      chat: countIn(`SELECT COUNT(*) c FROM chat_lines WHERE case_id='case_doom'`),
      narrative: countIn(`SELECT COUNT(*) c FROM narrative_fts WHERE case_id='case_doom'`),
      payload: countIn(`SELECT COUNT(*) c FROM payload_fts WHERE case_id='case_doom'`),
    };
    check(
      '删掉之后投影层一行不剩（sessions / steps / 调用 / 证据 / 对话全靠外键级联）',
      gone && Object.values(after).every((n) => n === 0),
      `回执=${gone} · ${Object.entries(after).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    );

    // 留下的那次一条都不能少：级联与 `DELETE ... WHERE case_id` 都很容易写成整表
    const keptBefore = {
      events: countIn(`SELECT COUNT(*) c FROM events WHERE case_id='case_keep'`),
      steps: countIn(
        `SELECT COUNT(*) c FROM steps WHERE session_id IN (SELECT id FROM sessions WHERE case_id='case_keep')`,
      ),
      narrative: countIn(`SELECT COUNT(*) c FROM narrative_fts WHERE case_id='case_keep'`),
    };
    check(
      '另一次调查一条不动（事件、步骤、检索索引都还在）',
      keptBefore.events > 0 && keptBefore.steps === 2 && keptBefore.narrative > 0,
      `事件 ${keptBefore.events} · 步骤 ${keptBefore.steps} · 索引 ${keptBefore.narrative}`,
    );
    check(
      '🔴 共享的那份 blob 不跟着删：它是内容寻址的，另一次调查还指着它',
      countIn(`SELECT COUNT(*) c FROM blobs WHERE sha256='${shared}'`) === 1 &&
        existsSync(path.join(blobs, shared)),
      '跟着 case 一起删的话，留下的那次调查的证据当场读不出来，而它自己一点没被动过',
    );
    check(
      '只被它引用的那份 blob 连文件一起清掉',
      countIn(`SELECT COUNT(*) c FROM blobs WHERE sha256='${soleOwn}'`) === 0 &&
        !existsSync(path.join(blobs, soleOwn)),
      '留着的话，"删掉了"与"证据原文还躺在磁盘上"同时成立',
    );
    check(
      '🔴 它自己那份"落了原文、还没记上引用"的也清掉（漏删方向）',
      countIn(`SELECT COUNT(*) c FROM blobs WHERE sha256='${strayOwn}'`) === 0 &&
        !existsSync(path.join(blobs, strayOwn)),
      '只按 tool_calls 收候选的话，这一份谁都指不到它，界面却说删干净了 —— 它会永远留在库和磁盘上',
    );
    check(
      '🔴 别人那份"落了原文、还没记上引用"的不许删（误删方向）',
      countIn(`SELECT COUNT(*) c FROM blobs WHERE sha256='${strayShared}'`) === 1 &&
        existsSync(path.join(blobs, strayShared)),
      '只按 tool_calls 判"还有没有人引用"的话，这一份看起来没人要 —— 删掉的是另一次调查的证据原文',
    );

    // 🔴 整段里最要紧的一条：删的是**事件**，不是一条 `case.deleted` 事件。
    // 记事件的写法在这里会绿——投影确实没了——但重放会把它先建再删……前提是投影器认得那条事件；
    // 不认的话（现在就不认）重放直接抛"没见过的事件"，整条迁移路当场断
    rebuildProjections(db, { blobDir: blobs });
    check(
      '🔴 重放之后它没长回来（删的是事件本身，不是记一条"删过了"）',
      countIn(`SELECT COUNT(*) c FROM cases WHERE id='case_doom'`) === 0 &&
        countIn(`SELECT COUNT(*) c FROM cases WHERE id='case_keep'`) === 1,
      '只删投影的话这里会 FAIL：下一次迁移把它连同证据原文一起建回来，而删除那一下没有任何报错',
    );
    check(
      '重放不会把删掉那次的检索索引也建回来',
      countIn(`SELECT COUNT(*) c FROM narrative_fts WHERE case_id='case_doom'`) === 0,
      '脏索引查不出来（searchCases 是 INNER JOIN），所以只能在这儿盯',
    );
    check(
      '删一个不存在的 id 回 false，不抛也不动别人',
      deleteCase(db, 'case_nope', { blobDir: blobs }).ok === false &&
        countIn(`SELECT COUNT(*) c FROM cases`) === 1,
      '界面按回执说话：静默回 true 的话，那一行会从列表上消失而库里还在',
    );
    check(
      '正常删完 blob_trash 是空的：欠账表只装真删不掉的那些',
      countIn(`SELECT COUNT(*) c FROM blob_trash`) === 0,
      '删成了不划掉的话，这张表会越攒越长，而每次启动都要为已经不存在的文件重试一遍',
    );

    /**
     * 文件删不掉那一档：**记进欠账表、回执数出来、下次启动接着删**。
     *
     * 造法：把那份 blob 的文件换成一个同名目录——`rmSync(..., { force: true })` 碰上目录
     * 直接抛 EISDIR（`force` 只吞"不存在"）。真实成因是权限、占用、只读卷这些，
     * 但落到这段代码上是同一件事：rm 抛了，而库那一半已经落定、退不回去了。
     */
    const doomed2 = makeRunner('case_doom2', '删的时候文件删不掉的那次');
    await work(doomed2, '文件会删不掉的那条', 'call_x9', '12:34:56');
    doomed2.close();
    const stuck = shaOf('call_x9');
    rmSync(path.join(blobs, stuck));
    mkdirSync(path.join(blobs, stuck));
    const outcome = deleteCase(db, 'case_doom2', { blobDir: blobs });
    check(
      '🔴 库删干净了但文件没删掉：回执要数出来，不能报成"删干净了"',
      outcome.ok && outcome.pendingBlobs === 1,
      `ok=${outcome.ok} pendingBlobs=${outcome.pendingBlobs} —— 吞掉的话界面会说原文一并销毁了，` +
        '而它还躺在磁盘上',
    );
    check(
      '文件删不掉不影响库那一半：调查照旧删干净',
      countIn(`SELECT COUNT(*) c FROM cases WHERE id='case_doom2'`) === 0 &&
        countIn(`SELECT COUNT(*) c FROM events WHERE case_id='case_doom2'`) === 0,
      '两半要分开报：库没删掉是"再试一次"，文件没删掉是"这次没删成、下次接着删"，处置完全不同',
    );
    check(
      '🔴 欠的那一刀记下来了（不记的话，库里没有任何一行指得到那个文件）',
      countIn(`SELECT COUNT(*) c FROM blob_trash WHERE sha256='${stuck}'`) === 1,
      '不记就等于把它变成一个没人知道路径的孤儿文件——"下次再删"根本无从删起',
    );

    // 拦路的目录挪开 = 下一次启动时那个成因（占用 / 只读）已经过去了
    rmSync(path.join(blobs, stuck), { recursive: true });
    writeFileSync(path.join(blobs, stuck), '假装它还在磁盘上');
    const retried = emptyBlobTrash(db, { blobDir: blobs });
    check(
      '🔴 下次启动接着删：欠账表里那份真的从磁盘上没了，账也划掉了',
      retried.removed === 1 &&
        retried.pending === 0 &&
        !existsSync(path.join(blobs, stuck)) &&
        countIn(`SELECT COUNT(*) c FROM blob_trash`) === 0,
      `removed=${retried.removed} pending=${retried.pending} —— 只记账不重试的话，` +
        '这张表就只是个越攒越长的清单，磁盘上那几份一辈子都在',
    );

    /**
     * 🔴 重删之前必须再问一次"现在还有没有人引用它"。
     *
     * blob 是**内容寻址**的：欠着的这段时间里，一次新调查完全可能落下逐字相同的输出，
     * 于是这个 sha 又活了（文件还在所以 `storeBlob` 不重写，`blobs` 行由 INSERT OR IGNORE 补回来）。
     * 不问就删的话，删掉的是一份**正在用的**证据原文，而那次调查一点没被动过——
     * 表现是报告里那条证据点开是空的，且没有任何报错。
     */
    const reborn = makeRunner('case_reborn', '欠着账的那份原文又被用上了');
    await work(reborn, '与欠账那份逐字相同的输出', 'call_r1', '12:34:56');
    reborn.close();
    check(
      '夹具立得住：新调查落下的正是欠账表里那个 sha',
      shaOf('call_r1') === stuck && existsSync(path.join(blobs, stuck)),
      `${stuck.slice(0, 8)} —— 内容一样，sha 就一样，这是内容寻址的定义`,
    );
    // 手工把欠账补回去：模拟"上一次删的时候没删成，这一次启动前它又被用上了"
    db.prepare(`INSERT OR REPLACE INTO blob_trash (sha256,at) VALUES (?,0)`).run(stuck);
    const spared = emptyBlobTrash(db, { blobDir: blobs });
    check(
      '🔴 又被用上的那份不许删，账要划掉',
      spared.removed === 0 &&
        existsSync(path.join(blobs, stuck)) &&
        countIn(`SELECT COUNT(*) c FROM blob_trash`) === 0,
      '照着账单闷头删的话，删的是另一次调查正在用的证据原文；账不划掉的话它每次启动都来一遍',
    );

    /**
     * 回执里那个数**只算这一次删除欠下的**，不是整张表。
     *
     * 混起来的话，一份历史上一直删不掉的原文会让之后每一次删除都回一个非零——
     * 而界面那句话写的是"这次调查的原文没删掉"，于是旧欠账被安到一次完全干净的删除头上。
     */
    db.prepare(`INSERT OR REPLACE INTO blob_trash (sha256,at) VALUES ('deadbeef_旧欠账',0)`).run();
    mkdirSync(path.join(blobs, 'deadbeef_旧欠账'));
    const clean = makeRunner('case_clean', '这一次删得干干净净');
    await work(clean, '一份自己的原文', 'call_c1', '13:00:00');
    clean.close();
    const cleanOut = deleteCase(db, 'case_clean', { blobDir: blobs });
    check(
      '🔴 回执只数这一次欠下的：库里压着别人的旧欠账，也不该算到这次头上',
      cleanOut.ok &&
        cleanOut.pendingBlobs === 0 &&
        countIn(`SELECT COUNT(*) c FROM blob_trash`) === 1,
      `pendingBlobs=${cleanOut.pendingBlobs}，而表里还压着 1 笔删不掉的旧账 —— ` +
        '直接回整张表的 pending 的话这里是 1，界面会说"这次调查有 1 份原文没删掉"',
    );

    /**
     * 🔴 事务提交之后**一句都不许抛**。
     *
     * 抛出去的后果不是少报几个数，而是**回执说反了**：main 收到"删失败"就不收运行时，
     * 于是那个 runner 还活着、还会往一个已经不存在的 case 上写事件，界面上那一行也还在，
     * 而库里那一半早就删干净了。
     *
     * 造法：给 `blob_trash` 挂一个 BEFORE DELETE 触发器。`emptyBlobTrash` 走到那笔
     * "又被用上了、该划掉"的账时，那句 `settle.run` **不在按文件兜的那个 try 里**，
     * 于是整个函数抛出来——正是这条要防的形状。
     */
    // 让表里压着一笔"已经又被人用上"的账：走到它就会去划账，而划账这一下会被触发器打回
    db.prepare(`INSERT OR REPLACE INTO blob_trash (sha256,at) VALUES (?,0)`).run(stuck);
    // 这一次调查的原文与留下那次逐字相同，所以它自己一笔新账都不欠
    const doomed3 = makeRunner('case_doom3', '清理会抛的那次');
    await work(doomed3, '与留下那次共享原文', 'call_b1', '10:00:00');
    doomed3.close();
    // 触发器要等工具调用落完再挂：`recordToolEnd` 提交时也会划自己那笔账（先记欠账再写文件）
    db.exec(
      `CREATE TRIGGER trash_boom BEFORE DELETE ON blob_trash BEGIN SELECT RAISE(ABORT,'boom'); END`,
    );
    let threw = false;
    let boomOut: DeleteOutcome = { ok: false, pendingBlobs: -1 };
    try {
      boomOut = deleteCase(db, 'case_doom3', { blobDir: blobs });
    } catch {
      threw = true;
    }
    db.exec(`DROP TRIGGER trash_boom`);
    check(
      '🔴 提交之后清理抛了也不许把回执说成"没删掉"',
      !threw && boomOut.ok && boomOut.pendingBlobs === 0,
      threw
        ? '抛出去了 —— main 会据此不收运行时，那个 runner 接着往一个已经不存在的 case 上写事件'
        : `ok=${boomOut.ok} pendingBlobs=${boomOut.pendingBlobs}`,
    );
    check(
      '清理抛了，库那一半照旧是删干净的（回执与事实要对得上）',
      countIn(`SELECT COUNT(*) c FROM cases WHERE id='case_doom3'`) === 0 &&
        countIn(`SELECT COUNT(*) c FROM events WHERE case_id='case_doom3'`) === 0,
      '这一条与上一条是一对：回执说 ok，库里就必须真的没有它了',
    );

    db.close();
    db = keepDb;
    blobs = keepBlobs;
  }

  // ── 应用级设置的夹逼（shared/settings.ts）──
  // 这几个值原先写死在源码里，搬进设置屏之后**每一个填过头都不会报错，只会安静地不工作**：
  // 闸门 0 秒 = 每次调用当场自动放行；在跑上限 0 = 一个调查也跑不起来。
  {
    const d = DEFAULT_UI_SETTINGS;
    check(
      '空对象归一成默认值，不是一堆 0 / undefined',
      JSON.stringify(normalizeSettings({})) === JSON.stringify(d),
      '库里没存过设置时走的就是这条；给出 0 的话闸门当场放行、调查一个也跑不起来',
    );
    check(
      '闸门超时夹在上下界内',
      normalizeSettings({ limits: { gateTimeoutMs: 0 } }).limits.gateTimeoutMs ===
        LIMIT_BOUNDS.gateTimeoutMs.min &&
        normalizeSettings({ limits: { gateTimeoutMs: 999 * 60_000 } }).limits.gateTimeoutMs ===
          LIMIT_BOUNDS.gateTimeoutMs.max,
      '下界挡的是"0 秒 = 每次调用当场自动放行"，上界挡的是"等一天"——那是①档的语义，不该由②档模仿出来',
    );
    check(
      '在跑上限夹在 1..8',
      normalizeSettings({ limits: { maxLiveCases: 0 } }).limits.maxLiveCases === 1 &&
        normalizeSettings({ limits: { maxLiveCases: 99 } }).limits.maxLiveCases === 8,
      '填 0 的表现是点了「开始排查」什么都不发生，而那个数字看着完全合法',
    );
    check(
      '🔴 载入上限不会小于在跑上限（跨字段，单独夹逼每一个夹不出来）',
      normalizeSettings({ limits: { maxLiveCases: 8, maxLoadedCases: 1 } }).limits.maxLoadedCases === 8,
      '两个数各自都在自己的合法区间里，合起来却会让刚 spawn 起来的调查被当场降级掉——' +
        '表现同样是"点了开始排查什么都不发生"。逐字段夹逼的写法在这条上会给出 1',
    );
    check(
      '非数字 / NaN 退回默认值，不落成 0',
      normalizeSettings({ limits: { maxLiveCases: 'abc' as unknown as number } }).limits.maxLiveCases ===
        d.limits.maxLiveCases &&
        normalizeSettings({ limits: { gateTimeoutMs: NaN } }).limits.gateTimeoutMs ===
          d.limits.gateTimeoutMs,
      '`Number(undefined)` 是 NaN，而 `Math.min/max` 碰上 NaN 一路传染成 NaN —— setTimeout(NaN) 会当场触发',
    );
    check(
      '认不得的 backend 归到 claude，不原样留着',
      normalizeSettings({ intake: { agent: { backend: 'gpt' } } } as unknown).intake.agent.backend ===
        'claude',
      '原样留着的话，新建调查会拿一个 backend 抽象不认识的值去建会话',
    );
    check(
      'takeover 只认 true，别的一律 false',
      normalizeSettings({ intake: { takeover: 'yes' } } as unknown).intake.takeover === false &&
        normalizeSettings({ intake: { takeover: true } } as unknown).intake.takeover === true,
      '`Boolean("false")` 是 true —— 用真值判断的写法会把任何存歪的字符串读成"全程接管"',
    );
  }

  // ── 模型列表缓存的形状版本（backend/agent/capabilities.ts）──
  // 缓存一命中就直接当答案返回，且回的 `probed` 是 true。所以给 `ModelOption` 加了字段之后，
  // **老库上会安静地顶着旧形状最多 24 小时**：代码对了、新装的机器也对，只有老库不对，
  // 而界面上没有任何地方看得出来。加 `resolvedModel`（模型版本号）那次就是这么栽的。
  {
    const now = Date.parse('2026-08-14T10:00:00+08:00');
    const withVersion = cacheBlob([{ value: 'sonnet', label: 'Sonnet', resolvedModel: 'claude-sonnet-5', description: '', efforts: [] }], now);
    // 加 resolvedModel 之前那版写下的那种：字段少一个，版本戳压根没有
    const oldShape = JSON.stringify({
      at: now,
      models: [{ value: 'sonnet', label: 'Sonnet', description: '', efforts: [] }],
    });

    check(
      '当前形状 + 没过期 = 直接命中，不重探',
      cacheHit(withVersion, now + 60_000)?.[0]?.resolvedModel === 'claude-sonnet-5',
      '探测要 spawn 一次 CLI，命中这条路必须真的走得通，否则每开一次面板都付一次那个代价',
    );
    check(
      '🔴 旧形状的缓存不算命中，哪怕它一点没过期',
      cacheHit(oldShape, now + 60_000) === null,
      '只判 TTL 的写法在这条上会命中：那份缓存里的模型没有 resolvedModel，' +
        '于是下拉一整天只显示系列名、看不出版本号——而这与"探测失败退回兜底"长得完全一样，' +
        '面板还照旧说自己是探测出来的',
    );
    check(
      '过期的也不算命中',
      cacheHit(withVersion, now + 25 * 60 * 60 * 1000) === null,
      '版本对上之后不能就把 TTL 忘了：模型列表本身会变（新模型上线、账号档位变化）',
    );
    check(
      '写进去的那一份自己读得回来（版本戳只在 cacheBlob 里打）',
      cacheHit(cacheBlob([{ value: 'x', label: 'X', description: '', efforts: [] }], now), now) !== null,
      '写侧漏打版本戳的话每次开面板都要重探一遍——不会给错答案，但那 20 秒超时会天天付',
    );
    check(
      '存歪的 JSON 与空缓存都当没缓存过，不抛',
      cacheHit('{{{', now) === null && cacheHit(null, now) === null,
      '这份东西存在 ui_settings 里，手改过一次就可能不是合法 JSON；抛出去的表现是新建调查面板整个白掉',
    );
  }

  console.log('\n===== Spike Cases 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }
  console.log(`\n临时库：${file}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

void main();
