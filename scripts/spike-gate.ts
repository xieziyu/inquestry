/**
 * Spike Gate —— 验②档闸门的四条判决真的落到了库里（ui.md §4 / §8.2）。
 *
 * 不起真会话：要验的是 harness 侧的记账，而这部分最容易错的地方与模型无关——
 *
 *   1. **PreToolUse 与 canUseTool 谁先到不保证。** 闸门先落定时调用行还不存在，
 *      UPDATE 会静默命中 0 行，判决就此消失
 *   2. **被拒的调用不会有 PostToolUse。** 不补一次收尾它就永远挂在 `pending` 上
 *   3. 改写要连参数一起换掉，且 `input_rewritten` 得立起来——报告里要标得出"这条人改过"
 *   4. 超时按预设放行，判决记 `timeout` 而不是 `allow`：节点上要写得出"自动放行"
 *
 * 跑：npm run rebuild:node && npm run spike:gate
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readBlobText } from '../src/backend/db/blobs.js';
import { blobDir, openDatabase } from '../src/backend/db/database.js';
import { rebuildProjections } from '../src/backend/db/projector.js';
import { setCaseStatus, type GateOutcome } from '../src/backend/store/sqlite-store.js';
import { applyTakeover, CaseRunner } from '../src/main/case-runner.js';

/** 闸门那几个方法是 CaseRunner 的私有面：这里要验的正是它们，只好从旁边够进去。 */
type Probe = {
  openSession(): unknown;
  gate(
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; agentID?: string; signal: AbortSignal; title?: string },
  ): Promise<GateOutcome>;
  onToolStart(input: unknown, toolUseID: string): unknown;
  /** 落库那一步。验"留痕失败也要收口"时把它换成会抛的。 */
  applyGate: (callId: string, outcome: GateOutcome) => void;
  onToolFailed(input: unknown, toolUseID: string): void;
  onPermissionDenied(input: unknown, toolUseID: string): void;
  gates: Map<
    string,
    { ask: { deadline?: number }; finish: (o: GateOutcome) => void; abandon: (why: string) => void }
  >;
  /** 接管模式要同时切 backend 那侧，验它得有个假查询接住 `setPermissionMode`。 */
  q: unknown;
  /** 建会话与运行时切换共用的那一个读数。 */
  readonly permissionMode: string;
};

type Row = {
  input_json: string;
  input_rewritten: number;
  gate_decision: string | null;
  status: string;
  output_sha256: string | null;
};

const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push([name, ok, detail]);

async function main() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'inquestry-gate-')), 'inquestry.db');
  const db = openDatabase(file);
  const blobs = blobDir(file);

  const runner = new CaseRunner({
    db,
    blobDir: blobs,
    promptText: '',
    caseId: 'case_gate',
    intake: {
      title: '闸门自检',
      question: '闸门自检',
      projectRoot: null,
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    },
    agent: { backend: 'claude', model: null, effort: null },
    onChange: () => {},
  });
  const probe = runner as unknown as Probe;
  probe.openSession();

  const row = (id: string) =>
    db
      .prepare(
        `SELECT input_json,input_rewritten,gate_decision,status,output_sha256 FROM tool_calls WHERE id=?`,
      )
      .get(id) as Row | undefined;

  const ask = (id: string, q: string) =>
    probe.gate('mcp__logs__query', { q }, { toolUseID: id, signal: new AbortController().signal });
  const started = (id: string, q: string) =>
    probe.onToolStart({ tool_name: 'mcp__logs__query', tool_input: { q } }, id);

  // ① 常规序：PreToolUse 先落调用行，闸门随后改写参数放行
  const a = ask('call_a', 'select *');
  started('call_a', 'select *');
  runner.decideGate({ id: 'call_a', action: 'rewrite', input: JSON.stringify({ q: 'select 1' }) });
  const outA = await a;

  // ② 反序：闸门赶在 PreToolUse 之前落定，判决必须等得到调用行
  const b = ask('call_b', 'drop table');
  runner.decideGate({ id: 'call_b', action: 'deny', message: '这条会写库，改用 ask_operator。' });
  const outB = await b;
  started('call_b', 'drop table');

  // ③ 放行与超时是两种判决，节点上要分得出
  const c = ask('call_c', 'select 2');
  started('call_c', 'select 2');
  runner.decideGate({ id: 'call_c', action: 'allow' });
  await c;

  const d = ask('call_d', 'select 3');
  started('call_d', 'select 3');
  // 倒计时归零：不真等三分钟，直接把闸门当成到点了处置
  probe.gates.get('call_d')?.finish({ decision: 'timeout' });
  await d;

  // ④ 放行之后工具自己报错：成功与失败是两个 hook，失败那条不接就永远停在 pending
  const e = ask('call_e', 'select 4');
  started('call_e', 'select 4');
  runner.decideGate({ id: 'call_e', action: 'allow' });
  await e;
  probe.onToolFailed({ tool_name: 'mcp__logs__query', error: 'ECONNREFUSED 10.0.0.7:5432' }, 'call_e');

  // 被拒的调用 backend 照样会当成一次失败发过来，不能让它把 denied 覆盖成 failed
  probe.onToolFailed({ tool_name: 'mcp__logs__query', error: 'permission denied' }, 'call_b');
  // 闸门拒过的也会走一趟 PermissionDenied：留话已经落过，别被规则给的理由顶掉
  probe.onPermissionDenied({ tool_name: 'mcp__logs__query', reason: 'blocked by rule' }, 'call_b');

  // ⑤ 项目 settings 的 deny 规则：不经过本地闸门，两个 hook 谁先到都得记成 denied
  const readF = { tool_name: 'Read', tool_input: { file_path: '/x/.env' }, error: 'permission denied' };
  started('call_f', 'noop');
  probe.onPermissionDenied({ ...readF, reason: '项目规则禁止读取 .env' }, 'call_f');
  probe.onToolFailed(readF, 'call_f');

  // 反序：失败先到，规则拒绝后到——`failed` 要被纠正回 `denied`
  started('call_g', 'noop');
  probe.onToolFailed(readF, 'call_g');
  probe.onPermissionDenied({ ...readF, reason: '项目规则禁止读取 .env' }, 'call_g');

  // ⑥ 人按了停止：闸门上等着的那条记「已放弃」，不能记成有人拦下了它。
  // 散闸门时照样要回一个 deny 给 agent，所以 PermissionDenied 一定会追着来一趟——
  // 这条后到的不能把 abandoned 改写成 denied
  const h = ask('call_h', 'select 5');
  started('call_h', 'select 5');
  await runner.interrupt();
  await h;
  probe.onPermissionDenied({ tool_name: 'mcp__logs__query', reason: '这一轮已被中断。' }, 'call_h');

  const [ra, rb, rc, rd, re, rf, rg, rh] = [
    'call_a',
    'call_b',
    'call_c',
    'call_d',
    'call_e',
    'call_f',
    'call_g',
    'call_h',
  ].map(row);
  const blob = (r?: Row) => (r?.output_sha256 ? (readBlobText(blobs, r.output_sha256) ?? '') : '');
  const denyText = blob(rb);
  const errText = blob(re);

  check(
    '改写：参数被换掉且留痕',
    ra?.gate_decision === 'rewrite' && ra.input_rewritten === 1 && ra.input_json === '{"q":"select 1"}',
    `gate=${ra?.gate_decision} rewritten=${ra?.input_rewritten} input=${ra?.input_json}`,
  );
  check('改写：改后的参数回传给 agent', outA.input === '{"q":"select 1"}', `updatedInput=${outA.input}`);
  check(
    '反序：闸门先落定也记得住判决',
    rb?.gate_decision === 'deny',
    `gate=${rb?.gate_decision}（调用行是闸门之后才建的）`,
  );
  check('拒绝：调用收尾成 denied，不再挂 pending', rb?.status === 'denied', `status=${rb?.status}`);
  check('拒绝：留话进了节点', denyText.includes('ask_operator'), `blob 内容=${denyText.slice(0, 40)}`);
  check(
    '拒绝：留话原样回给 agent',
    outB.decision === 'deny' && !!outB.message,
    `message=${outB.message}`,
  );
  check(
    '放行与超时是两种判决',
    rc?.gate_decision === 'allow' && rd?.gate_decision === 'timeout',
    `放行=${rc?.gate_decision} 超时=${rd?.gate_decision}`,
  );
  check(
    '放行不收尾调用：结果还得等 PostToolUse',
    rc?.status === 'pending' && rd?.status === 'pending',
    `放行=${rc?.status} 超时=${rd?.status}`,
  );
  check('闸门散尽后待办栏是空的', probe.gates.size === 0, `还挂着 ${probe.gates.size} 条`);
  check(
    '放行后报错的调用收尾成 failed，错误进 blob',
    re?.status === 'failed' && errText.includes('ECONNREFUSED'),
    `status=${re?.status} blob 内容=${errText.slice(0, 40)}`,
  );
  check(
    '被拒的调用不会被后到的失败覆盖成 failed',
    rb?.status === 'denied' && denyText.includes('ask_operator'),
    `status=${rb?.status} blob 内容=${denyText.slice(0, 24)}`,
  );
  check(
    '规则层拒绝记成 denied 不是 failed，理由留得住',
    rf?.status === 'denied' && (blob(rf) ?? '').includes('禁止读取 .env'),
    `status=${rf?.status} blob 内容=${blob(rf)?.slice(0, 30)}`,
  );
  check(
    // 人现在压根不参与判定（分类器按后果判，ui.md §8.1），**两种拒必须在库里分得开**：
    // 都记 `deny` 的话，读轨道的人会把分类器拒的当成自己当时拦下的
    '两种拒分得开：人按的是 deny，backend 那侧（分类器/规则）拒的是 auto_deny',
    rb?.gate_decision === 'deny' && rf?.gate_decision === 'auto_deny',
    `人拒=${rb?.gate_decision} / 规则与分类器拒=${rf?.gate_decision}`,
  );
  check(
    // 只认 `deny` 的话，分类器拒掉的那些永远挂在 pending 上——而它现在是常态路径
    'auto_deny 照样把调用收尾（不是只有人拒才收）',
    rf?.status === 'denied' && rg?.status === 'denied',
    `call_f=${rf?.status} call_g=${rg?.status}`,
  );
  check(
    '反序：失败先到也要被纠正回 denied',
    rg?.status === 'denied',
    `status=${rg?.status} blob 内容=${blob(rg)?.slice(0, 30)}`,
  );
  check(
    '停止散掉的闸门记 abandoned，不是被拒',
    rh?.status === 'abandoned' && rh.gate_decision === 'auto',
    `status=${rh?.status} gate=${rh?.gate_decision} blob 内容=${blob(rh)?.slice(0, 24)}`,
  );

  // ── ⑦ 接管模式：闸门唯一的入口（overview §3.5 / ui.md §4 的 ②′） ────────
  //
  // 分类器按后果判之后，②档卡片在默认路上不再出现——闸门那套机器还在，却没有任何
  // 界面动作触发得了它。这一段验的就是那个开关：**两侧一起切，缺一不可**。
  // 只改我们自己的 PreToolUse 而不切 backend 的 permissionMode，失败方式是
  // "开关翻过去了、调用照旧不到闸门上来"，屏幕上什么都看不出。
  const modes: string[] = [];
  probe.q = { setPermissionMode: (m: string) => (modes.push(m), Promise.resolve()) };

  check(
    '默认不接管：PreToolUse 对普通工具不表态（回空，不是 allow）',
    JSON.stringify(probe.onToolStart({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 'call_t0')) === '{}' &&
      probe.permissionMode === 'auto',
    `返回=${JSON.stringify(probe.onToolStart({ tool_name: 'Bash', tool_input: {} }, 'call_t0b'))} · mode=${probe.permissionMode}`,
  );

  const on = await runner.setTakeover(true);
  const askDecision = (out: unknown) =>
    (out as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput
      ?.permissionDecision;
  check(
    '接管开着：非放行档的调用被推到 canUseTool 上（PreToolUse 回 ask）',
    on && askDecision(probe.onToolStart({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, 'call_t1')) === 'ask',
    `回执=${on} · decision=${askDecision(probe.onToolStart({ tool_name: 'Bash', tool_input: {} }, 'call_t1b'))}`,
  );
  check(
    '两侧一起切：backend 的 permissionMode 也从 auto 回到 default',
    modes.at(-1) === 'default' && probe.permissionMode === 'default',
    `切过的模式=${modes.join(',')} · 当前=${probe.permissionMode}（只切我们这侧的话，分类器仍在判，多数调用压根到不了闸门）`,
  );
  check(
    '放行档照旧不表态：记事本与工具检索不该变成卡片',
    ['TodoWrite', 'ToolSearch'].every(
      (t) => JSON.stringify(probe.onToolStart({ tool_name: t, tool_input: {} }, `call_t_${t}`)) === '{}',
    ),
    '接管要的是"敏感动作过人"，不是把每一次调用都堆成待办',
  );
  // 只读三件套只在**真项目**下才在放行档里（演示模式挂的是玩具数据源），
  // 所以这条得另起一个带项目起点的 runner——拿演示模式那个验，验到的是"它本来就没给 Read"
  const realRunner = new CaseRunner({
    db,
    blobDir: blobs,
    promptText: '',
    caseId: 'case_gate_real',
    intake: {
      title: '真项目下的接管',
      question: '真项目下的接管',
      projectRoot: '/tmp',
      incidentDate: '2026-08-09',
      tzOffset: '+08:00',
      clues: null,
    },
    agent: { backend: 'claude', model: null, effort: null },
    onChange: () => {},
  });
  const realProbe = realRunner as unknown as Probe;
  realProbe.openSession();
  await realRunner.setTakeover(true);
  check(
    '真项目下接管时，只读三件套照旧直接放行',
    ['Read', 'Grep', 'Glob'].every(
      (t) => JSON.stringify(realProbe.onToolStart({ tool_name: t, tool_input: {} }, `call_r_${t}`)) === '{}',
    ) &&
      askDecision(realProbe.onToolStart({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, 'call_r_bash')) ===
        'ask',
    '读代码是调查的地基：把它也堆成卡片的话，接管模式一开就没法用了',
  );
  realRunner.close();

  // 接管那一档**没有超时兜底**（ui.md §4 的 ②′）：
  // 人刚说了每一条自己判，三分钟后替他放行等于把这句话作废，而那时挂着的多半是敏感写
  const t1 = ask('call_t2', 'drop table');
  started('call_t2', 'drop table');
  check(
    '接管模式挂上来的闸门没有 deadline（不会自己过去）',
    probe.gates.get('call_t2')?.ask.deadline === undefined && probe.gates.get('call_d') === undefined,
    `deadline=${probe.gates.get('call_t2')?.ask.deadline}`,
  );
  // 中途关掉开关，不该让一条正等着人的调用突然长出一个倒计时，也不该把它就地放行——
  // 关接管不等于"刚才那条就放行吧"，人正要按拒绝的那条不能因为切了个开关自己过去
  await runner.setTakeover(false);
  check(
    '关掉接管：已经挂着的那条既不放行也不长出倒计时',
    probe.gates.has('call_t2') && probe.gates.get('call_t2')?.ask.deadline === undefined,
    `还挂着=${probe.gates.has('call_t2')} · deadline=${probe.gates.get('call_t2')?.ask.deadline}`,
  );
  check(
    '关掉之后 backend 那侧也切回 auto',
    modes.at(-1) === 'auto' && probe.permissionMode === 'auto',
    `切过的模式=${modes.join(',')}`,
  );
  runner.decideGate({ id: 'call_t2', action: 'deny', message: '这条会写库。' });
  await t1;
  check(
    '关掉接管之后，人对那条挂着的处置照旧落得下去',
    row('call_t2')?.gate_decision === 'deny' && row('call_t2')?.status === 'denied',
    `gate=${row('call_t2')?.gate_decision} status=${row('call_t2')?.status}`,
  );
  // 非接管模式挂上来的那一档照旧有 deadline——这两档的分别全在"不处理会怎样"
  const t3 = ask('call_t3', 'select 9');
  started('call_t3', 'select 9');
  check(
    '不接管时闸门照旧有 deadline（到点按预设放行）',
    typeof probe.gates.get('call_t3')?.ask.deadline === 'number',
    `deadline=${probe.gates.get('call_t3')?.ask.deadline}`,
  );
  probe.gates.get('call_t3')?.finish({ decision: 'timeout' });
  await t3;
  /**
   * 🔴 **留痕失败不能拖着 agent 的 Promise 一起死。**
   *
   * `settle` 先清超时兜底、把闸门从 `gates` 上摘掉，之后才落库。落库抛错时若不接住，
   * `resolve` 就跑不到——agent 那侧永远等下去，而屏幕上闸门卡正常消失、人重试只拿到 false、
   * 停止也再找不到它。表现是整场调查静默挂住，日志里一个字都没有。
   * 记不上的那次调用退回由 PostToolUse 收尾，错一个状态远好过挂死。
   *
   * ①档的 `answerOperator` 早就这么写了，这条是补②档漏掉的那一半。
   */
  const applyGate = probe.applyGate;
  probe.applyGate = () => {
    throw new Error('磁盘满了，这条留痕落不下去');
  };
  const noRecord = ask('call_boom', 'select 10');
  started('call_boom', 'select 10');
  try {
    runner.decideGate({ id: 'call_boom', action: 'allow' });
  } catch {
    // 不接住的话这条 spike 整个崩掉，打出 0 PASS / 0 FAIL —— 看着像全过。
    // 接住之后旧写法会干净地落到下面那条 FAIL 上（agent 拿到"挂死了"）
  }
  const boomOut = await Promise.race([
    noRecord.then((o) => o.decision),
    new Promise<string>((r) => setTimeout(() => r('挂死了'), 1500)),
  ]);
  probe.applyGate = applyGate;
  check(
    '留痕落不下去时闸门照样收口：agent 等到判决，闸门也不再挂着',
    boomOut === 'allow' && !probe.gates.has('call_boom'),
    `agent 拿到=${boomOut} · 闸门还挂着=${probe.gates.has('call_boom')}（"挂死了"就是整场调查静默卡住的那一幕）`,
  );

  const snapBefore = runner.snapshot().takeover;
  await runner.setTakeover(true);
  check(
    '接管状态进快照：它把每次调用都挂到闸门上，界面必须一眼看得见',
    snapBefore === false && runner.snapshot().takeover === true,
    `切之前=${snapBefore} 切之后=${runner.snapshot().takeover}`,
  );
  // 🔴 **切不动就不该报成功。** fire-and-forget 出去、当场把开关翻过去的话，
  // 屏幕上写着「已接管」而分类器仍在判——这个开关唯一要防的就是这种"说了谎的状态"
  probe.q = { setPermissionMode: () => Promise.reject(new Error('控制请求失败')) };
  const failed = await runner.setTakeover(false);
  check(
    'backend 那侧切不动时回 failed，且自己这边的状态一动不动',
    failed === 'failed' && runner.snapshot().takeover === true,
    `回执=${failed} · takeover=${runner.snapshot().takeover}（报成功的话，界面会显示一个从没生效过的开关）`,
  );
  // 🔴 **两种没切成要分得开。** 都回同一个值的话，界面只能说一句"调查可能切走了"——
  // 而 backend 切不动时调查明明还在手上，人照着那句切回来再按一次，
  // 然后在没有接管的情况下继续查下去
  setCaseStatus(db, { caseId: 'case_gate_real', blobDir: blobs, now: () => Date.now() }, 'closed');
  const gone = await realRunner.setTakeover(true);
  check(
    '状态冲突（调查已收尾）与 backend 切不动是两种回执，不是同一个 false',
    gone === 'gone' && failed === 'failed',
    `已收尾=${gone} · 切不动=${failed}（同一个值的话，界面对后者只说得出"再点一次"）`,
  );
  // 两次快速点击并发发出去时，控制请求的回执顺序不保证：后发的先回，最终生效的会是先按的那一下
  const order: string[] = [];
  probe.q = {
    setPermissionMode: (m: string) => {
      order.push(`start:${m}`);
      return new Promise<void>((res) =>
        setTimeout(() => {
          order.push(`done:${m}`);
          res();
        }, m === 'auto' ? 30 : 5),
      );
    },
  };
  const [r1, r2] = await Promise.all([runner.setTakeover(false), runner.setTakeover(true)]);
  check(
    '连续切换串行化：后一次等前一次落定，最终状态与最后按下的那一次一致',
    order.join(',') === 'start:auto,done:auto,start:default,done:default' &&
      r1 === 'ok' &&
      r2 === 'ok' &&
      runner.snapshot().takeover === true,
    `顺序=${order.join(',')} · 回执=${r1}/${r2} · takeover=${runner.snapshot().takeover}`,
  );
  // 落库那一步失败：SDK 与 runner 已经在新模式上，而 case_ui_state 还是旧值。
  // 🔴 不回滚的话屏幕上写着「已接管」、这一轮确实过闸门，重开 app 它自己就没了——
  // 比切不动更隐蔽，因为切不动当场就说了
  probe.q = { setPermissionMode: () => Promise.resolve() };
  const boom = () => {
    throw new Error('database or disk is full');
  };
  const rolledBack = await applyTakeover(runner, 'case_gate', true, boom);
  check(
    '落库失败且回滚成功：当作没切成，会话切回旧模式',
    rolledBack === 'failed' && runner.snapshot().takeover === false,
    `回执=${rolledBack} · takeover=${runner.snapshot().takeover}（不回滚的话，这是一个重开 app 就消失的「已接管」）`,
  );
  // 回滚也失败：会话确实在新模式上，只是活不过重启。说成 failed 的话人会再按一次，
  // 而那一次正好把已经生效的这一档切回去
  let calls = 0;
  probe.q = {
    setPermissionMode: () => (++calls === 1 ? Promise.resolve() : Promise.reject(new Error('控制请求失败'))),
  };
  const unsaved = await applyTakeover(runner, 'case_gate', true, boom);
  check(
    '落库失败且回滚也失败：回 unsaved，不冒充没切成',
    unsaved === 'unsaved' && runner.snapshot().takeover === true,
    `回执=${unsaved} · takeover=${runner.snapshot().takeover}（说成 failed 的话，人再按一次正好把生效了的这一档关掉）`,
  );
  // 落得下库时照旧回 ok，且只切一次——回滚那条路不该在正常路径上跑
  calls = 0;
  probe.q = { setPermissionMode: () => (++calls, Promise.resolve()) };
  let persisted = 0;
  const okr = await applyTakeover(runner, 'case_gate', false, () => void persisted++);
  check(
    '落得下库时回 ok，落库只做一次、不多切一次模式',
    okr === 'ok' && persisted === 1 && calls === 1 && runner.snapshot().takeover === false,
    `回执=${okr} · 落库=${persisted} 次 · 切模式=${calls} 次`,
  );

  probe.q = null;
  await runner.setTakeover(false);

  // 判决落在哪条事件上取决于到达顺序（反序那次是 started 直接带走的），
  // 所以不数 gated 的条数，只问重放后是不是同一批判决——events 是不是真相看这一条
  const before = JSON.stringify(['call_a', 'call_b', 'call_c', 'call_d'].map(row));
  rebuildProjections(db, { blobDir: blobs });
  const after = JSON.stringify(['call_a', 'call_b', 'call_c', 'call_d'].map(row));
  check('清空投影后重放，四条判决逐字一致', before === after, before === after ? '一致' : `重放后=${after}`);

  console.log('\n===== Spike Gate 结果 =====');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(`      ${detail}`);
  }
  console.log(`\n临时库：${file}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

void main();
