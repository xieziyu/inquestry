/**
 * Spike Cases —— 验并发多个案子这一带（D28 / ui.md §8.3）。
 *
 * 不起真会话：要验的都是 harness 侧的记账与投影，与模型无关，而这几处的错法都是**静默**的——
 *
 *   1. **排查时间线按 case 取而非按 session 取。** 按 session 取时重开旧案主区是空的，
 *      查了三轮的东西一条不剩，看起来像数据丢了而不像查错了表
 *   2. **重开是新起一个 session，不是往已收尾的那个里接着写。** 不换 sessionId 的话，
 *      库里会出现「会话结束之后还在产生的步骤」
 *   3. **`cases.updated_at` 得有人前移。** 立案之后没有别的地方会动它，
 *      不前移的话切换栏的「最近活动」永远是立案先后
 *   4. **降级不能挑挂着待办的那个。** 它会把等着人回答的 pending 就地作废，
 *      等于替人做了「这条不查了」的决定
 *
 * 跑：npm run rebuild:node && npm run spike:cases
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readBlobHead, storeBlob } from '../src/backend/db/blobs.js';
import { blobDir, openDatabase, type Db } from '../src/backend/db/database.js';
import { rebuildProjections } from '../src/backend/db/projector.js';
import { caseList, reportSections } from '../src/backend/db/queries.js';
import { readIntake, type InvestigationSession } from '../src/backend/store/sqlite-store.js';
import { CaseRegistry } from '../src/main/case-registry.js';
import { CaseRunner } from '../src/main/case-runner.js';
import { draftKey, pruneDrafts, type CardDrafts } from '../src/renderer/drafts.js';
import type { Snapshot } from '../src/shared/ipc.js';

/** 会话准备与运行时读数是 CaseRunner 的私有面：要验的正是它们，只好从旁边够进去。 */
type Probe = {
  beginSession(): InvestigationSession;
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
 * 这里若像 `makeRunner` 那样兜底造一份立案单，切换一个不存在的 id 会凭空立出个案子来。
 */
const loadRunner = (caseId: string) => (readIntake(db, caseId) ? makeRunner(caseId) : null);

/** 跑一步完整的排查：开 step → 一次工具调用 → 带证据结案。 */
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

async function main() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-cases-')), 'inquestry.db');
  db = openDatabase(file);
  blobs = blobDir(file);

  // ── ① 一个案子跨两次会话 ──────────────────────────────────────────────
  const first = makeRunner('case_x', '订单查不到');
  await work(first, '主从延迟导致读不到刚写入的记录', 'call_x1', '12:41:07');
  const createdAt = (db.prepare(`SELECT created_at c FROM cases WHERE id='case_x'`).get() as { c: number }).c;
  first.close();

  // 关掉再打开 = 同一个案子的第二次会话（重启 app 走的也是这条路）
  const second = makeRunner('case_x');
  await work(second, '重试逻辑把失败吞了', 'call_x2', '12:43:20');
  const snapX = second.snapshot();

  check(
    '排查时间线按 case 取：重开旧案看得见上一次会话的步骤',
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
    '事故时间线仍是全案汇总，两次会话的证据排在一条线上',
    snapX.incident.length === 2 && snapX.incident[0]!.occurredAtRaw === '12:41:07',
    snapX.incident.map((r) => r.occurredAtRaw).join(' → '),
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
    'cases.updated_at 随活动前移，不停在立案那一刻',
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

  // ── ③ 全局待办汇总：别的案子在等人，当前案子的快照里也数得出来 ──────────
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
  check(
    '切换到别的案子不中断它：运行时还在，待办也还挂着',
    zBrief.loaded && zBrief.todos === 1 && !zBrief.current,
    `case_z loaded=${zBrief.loaded} todos=${zBrief.todos} current=${zBrief.current}`,
  );
  check(
    '当前案子的快照里带着别处的待办数（D28）',
    registry.current!.snapshot(briefs).cases.reduce((n, c) => n + c.todos, 0) === 1,
    briefs.map((c) => `${c.id}:${c.todos}`).join(' '),
  );
  check(
    '库里没有的 case 切不过去，当前案子不受影响',
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
    '挂着待办的案子不会被降级——降级等于替人作废掉那条回填',
    after.get('case_z')!.loaded && after.get('case_z')!.todos === 1,
    `case_z loaded=${after.get('case_z')!.loaded} todos=${after.get('case_z')!.todos}`,
  );
  check(
    '当前案子不会被降级',
    after.get('case_y')!.loaded && after.get('case_y')!.current,
    `case_y loaded=${after.get('case_y')!.loaded} current=${after.get('case_y')!.current}`,
  );

  // 限流不能只在切换时查一次：切过去的时候案子还没开跑（没有进程），
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

  // 被降级的案子重新点开：必须是个全新的运行时，不是那个已收尾的
  small.switchTo('case_x');
  check(
    '降级过的案子点回去是新运行时，不接着往已收尾的 session 里写',
    small.current!.sessionStatus === 'idle' && small.briefs().find((c) => c.id === 'case_x')!.loaded,
    `status=${small.current!.sessionStatus}`,
  );

  // ── ⑤ updated_at 是投影，重放后必须逐字一致 ─────────────────────────────
  //
  // ⚠️ 只比 id 与 updated_at，**不比 status**：结案状态目前还没有对应的领域事件
  //（要等「三种收尾」那一步），上面那句直接改库的 UPDATE 重放后必然被抹掉。
  // 这正是收尾三档必须走事件而不是直接 UPDATE 的理由——记在这儿免得到时候忘了。
  //
  // 这一条必须排在下面两节**之前**：它们为了造场景直接改了库，那些改动重放留不下来。
  const activity = () => JSON.stringify(caseList(db).map((c) => [c.id, c.updated_at]).sort());
  const beforeReplay = activity();
  rebuildProjections(db, { blobDir: blobs });
  check(
    '清空投影后重放，各案子的最近活动时间逐字一致',
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

  // ── ⑦ 载入着的案子不会被切换栏的条数上限截掉 ────────────────────────────
  //
  // 待办只活在运行时里：被截掉的话，那个案子连同它的「等你 N」一起从切换栏和
  // 全局汇总里消失，人看不见也切不回去——D28 要保的正是这个
  const flood = new CaseRegistry<CaseRunner>({ db, create: loadRunner, maxLive: 2 });
  flood.adopt('case_z', idle); // 挂着一条待办
  for (let i = 0; i < 25; i++) {
    const id = `case_bulk${i}`;
    makeRunner(id, `批量案子 ${i}`).close();
    // 让它们的最近活动都比 case_z 新，把 case_z 挤出前 20
    db.prepare(`UPDATE cases SET updated_at=? WHERE id=?`).run(Date.parse('2027-01-01') + i, id);
  }
  const flooded = flood.briefs();
  check(
    '载入着的案子不会被切换栏的条数上限截掉，待办跟着还在',
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

  // ── ⑬ 立案面板模式：没有当前案子，但切换栏与全局待办照常 ──────────────────
  //
  // 点「＋ 新案件」的那一刻 currentId 就是 null，而 renderer 要等下一次快照才换屏。
  // main 侧那些依赖当前案子的 IPC 因此必须判空——用 `!` 的话这中间旧界面发一次消息
  // 就是个 TypeError，用户那侧只看到输入框被清空、内容没了。
  // 同时「别处还有几条待办」在立案页上也得数得出来，否则新立一个案子就把它们看丢了
  const intakeReg = new CaseRegistry<CaseRunner>({ db, create: loadRunner });
  intakeReg.adopt('case_z', idle);
  intakeReg.toIntake();
  const intakeBriefs = intakeReg.briefs();
  check(
    '进立案面板后没有当前案子，但切换栏与别处的待办还在',
    intakeReg.current === null &&
      intakeReg.currentCaseId === null &&
      intakeBriefs.every((c) => !c.current) &&
      intakeBriefs.find((c) => c.id === 'case_z')?.todos === 1,
    `current=${intakeReg.current} 共 ${intakeBriefs.length} 行 case_z 待办=${intakeBriefs.find((c) => c.id === 'case_z')?.todos}`,
  );

  // ── ⑭ 切过去之后，旧界面那一下不能落到新案子头上 ──────────────────────────
  //
  // 光判空不够：切换是同步生效的，所以 `current` 这时已经是**新**案子了。
  // renderer 在 A 案里按下的发送带的还是 A 的 id，不核对就正正好写进 B 的会话，
  // 而且还会回一个「送到了」把 A 的草稿清掉
  const stale = new CaseRegistry<CaseRunner>({ db, create: loadRunner });
  stale.switchTo('case_x');
  stale.switchTo('case_w'); // 人点了 B 案；旧界面还没换屏
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

  // ── ⑯ 只是点开看过的老案子，不该靠「载入着」把自己钉进切换栏 ────────────────
  //
  // 上面那 25 个 bulk 案子都比 case_x 新，所以 case_x 早就在 20 名开外了。
  // 把它点开看一眼——若「载入着就钉住」，它会重新冒到切换栏上，条数上限就此形同虚设
  // （载入数有上限，所以不会无限长，但仍会稳定地多出一截）
  const pinReg = new CaseRegistry<CaseRunner>({ db, create: loadRunner });
  pinReg.switchTo('case_x');
  pinReg.switchTo('case_bulk24');
  const pinRows = pinReg.briefs();
  check(
    '只点开看过的老案子不会把自己钉进切换栏',
    pinRows.length <= 20 && !pinRows.some((c) => c.id === 'case_x'),
    `共 ${pinRows.length} 行，case_x ${pinRows.some((c) => c.id === 'case_x') ? '还在里面' : '没在'}`,
  );

  // ── ⑰ 待办处置要有回执，不能静默丢掉 ────────────────────────────────────
  //
  // 这两个手势按 id 查表，切了案子之后查的是**新**案子的表，随机 id 当然对不上——
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
    '处置一条不在本案子手里的待办，回 false 而不是静默丢掉',
    disp.answerOperator({ id: 'ask_nope', statement: 'x', answer: 'y' }) === false &&
      disp.decideGate({ id: 'call_nope', action: 'deny', message: '不行' }) === false,
    `回填=${disp.answerOperator({ id: 'ask_nope', statement: 'x', answer: 'y' })} 闸门=${disp.decideGate({ id: 'call_nope', action: 'deny', message: '不行' })}`,
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
    disp.answerOperator({ id: askId, statement: 'SELECT 1', answer: '只有一条' }) === true &&
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
    [draftKey('case_b', 'ask_elsewhere')]: { answer: '另一个案子上写到一半的' },
  };
  const pruned = pruneDrafts(drafts, 'case_a', ['gate_live']);
  check(
    '本案子里已经消失的条目，草稿跟着清掉',
    !(draftKey('case_a', 'ask_gone') in pruned) && draftKey('case_a', 'gate_live') in pruned,
    `剩下 ${Object.keys(pruned).join(' ')}`,
  );
  check(
    '别的案子的草稿一条都不动——它们的待办这会儿根本不在快照里',
    pruned[draftKey('case_b', 'ask_elsewhere')]?.answer === '另一个案子上写到一半的',
    `case_b 的草稿${draftKey('case_b', 'ask_elsewhere') in pruned ? '还在' : '被误删了'}`,
  );
  check(
    '没得清就原样返回，不白白多触发一次渲染',
    pruneDrafts(pruned, 'case_a', ['gate_live']) === pruned,
    '返回的是同一个对象',
  );

  console.log('\n===== Spike Cases 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }
  console.log(`\n临时库：${file}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

void main();
