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
import type { GateOutcome } from '../src/backend/store/sqlite-store.js';
import { CaseRunner } from '../src/main/case-runner.js';

/** 闸门那几个方法是 CaseRunner 的私有面：这里要验的正是它们，只好从旁边够进去。 */
type Probe = {
  openSession(): unknown;
  gate(
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; agentID?: string; signal: AbortSignal; title?: string },
  ): Promise<GateOutcome>;
  onToolStart(input: unknown, toolUseID: string): void;
  onToolFailed(input: unknown, toolUseID: string): void;
  onPermissionDenied(input: unknown, toolUseID: string): void;
  gates: Map<string, { finish: (o: GateOutcome) => void; abandon: (why: string) => void }>;
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
