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
  gates: Map<string, { finish: (o: GateOutcome) => void }>;
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

  const [ra, rb, rc, rd] = ['call_a', 'call_b', 'call_c', 'call_d'].map(row);
  const denyText = rb?.output_sha256 ? (readBlobText(blobs, rb.output_sha256) ?? '') : '';

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
