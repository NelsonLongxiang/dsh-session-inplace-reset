// 七层病种脱敏合成语料回归：一个文件叠多病（防「修好 A 坏 B」）。
// 层谱（对照 repair/README.md 病征速查）：
//   L1 区间对混入、L2 seq 跳号、L3 无三明治头、L4 system 字段损坏、
//   L5 turn 回退、L6 compaction 跨度（需 DSH_FORMAT_LIB，无则跳）、L7 孤儿 offload 摘除。
// 运行：node test/onion.mjs（不依赖 DSH_FORMAT_LIB；有则加跑 L6）。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openSession, writeSession } from '../lib/v4-file.mjs';

const BIN = join(import.meta.dirname, '..', 'bin');
const run = (tool, ...args) => execFileSync('node', [join(BIN, tool), ...args], { encoding: 'utf8' });
const tryRun = (tool, ...args) => { try { return { rc: 0, out: run(tool, ...args) }; } catch (e) { return { rc: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; } };
const hdr = { type: 'session', version: 4, sessionId: 'onion', workspace: '/tmp/onion' };
let seq = -1;
const ev = (type, data, extra = {}) => ({ type, seq: ++seq, time: 1700000000000, ...extra, ...(data === undefined ? {} : { data }) });
const dir = mkdtempSync(join(tmpdir(), 'onion-'));

// ── 洋葱件：L1+L2+L3+L4+L5 叠加 ──
// L3 无头：首个 surface 前没有 system/message；L2 seq 跳号（2→4）；L1 区间对；L5 turn 回退；L4 中段坏 system。
let rows;
{
  seq = 3; // 从 4 开始制造 L2 跳号（0..2 之后直接 4）
  rows = [hdr,
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u0' }),        // seq4
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u1' }),        // seq5
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u2' }),        // seq6
    ev('turn/start', { turn: 1 }),                                            // seq7
    ev('step/start', { turn: 1, step: 1 }),                                   // seq8
    ev('system/message', { turn: 1, step: 0, message: { role: 'system', content: [] } }), // seq9  L4：step<1 且缺 message.id/source
    ev('step/end', { turn: 1, step: 1 }),                                     // seq10
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),               // seq11
    ev('assistant/message', undefined, { surfaceOp: { startSeq: 4, endSeq: 6 }, sourceEventSeqs: [4, [5, 6]], headerSeq: 5, id: 'a1' }), // seq12 L1 区间对
    ev('turn/start', { turn: 1 }),                                            // seq13 L5 turn 回退（重开 1）
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),               // seq14
  ];
  // 前三行补 0..2 的合法序（跳号制造点在其后）
  const pre = [ev('user/message', undefined, { surfaceOp: 'append', id: 'up' }), ev('user/message', undefined, { surfaceOp: 'append', id: 'uq' }), ev('user/message', undefined, { surfaceOp: 'append', id: 'ur' })];
  rows = [hdr, ...pre, ...rows.slice(1)];
}
const onion = join(dir, 'onion.zstd');
writeSession(onion, rows);

// 修前分诊：sweep 必须判 SICK 且命中多病种
const sweep0 = tryRun('sweep.mjs', onion);
assert.equal(sweep0.rc, 2, 'onion must sweep SICK');
assert.match(sweep0.out, /turn-rewind|nested-ranges|seq-gap/, '叠病件必须被判 SICK 且命中已种病种');

// 修复顺序（README 换件纪律）：区间对 → 主管线（fold turn 重编＋字段修＋补头＋seq 安全网）
const step1 = join(dir, 's1.zstd');
run('fix-surface-ranges.mjs', 'fix', onion, '-o', step1);
assert.match(run('fix-surface-ranges.mjs', 'check', step1), /OK: no nested ranges/, 'L1 修后不得复发');
const step2 = join(dir, 's2.zstd');
const fixOut = run('repair-v4-session.mjs', 'fix', step1, '-o', step2);
assert.match(fixOut, /fix done/);

// ── 层间互害断言（修好 A 不许坏 B）──
{
  const { rows: fixed } = openSession(step2);
  const events = fixed.slice(1);
  // L2：seq 致密 0..n
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i), 'seq must be dense');
  // L3：首个 surface 前有合法三明治头
  const firstSurface = events.findIndex((e) => ['user/message', 'assistant/message', 'system/message'].includes(e.type));
  const head = events[firstSurface];
  assert.equal(head.type, 'system/message', 'sandwich head must lead the surface');
  // L4：全部 system 字段合法
  for (const e of events) if (e.type === 'system/message') {
    assert.ok(Number(e.data.step) >= 1, 'system step must be >=1');
    assert.ok(typeof e.data.message?.id === 'string' && e.data.message.id.length > 0, 'system message.id must exist');
    assert.ok(e.data.message.source?.kind && e.data.message.source.kind !== 'plugin', 'system source.kind must be valid');
  }
  // L5：turn 单调且成对
  const turns = [];
  let open = null;
  for (const e of events) {
    if (e.type === 'turn/start') { assert.equal(open, null, 'no nested turn/start'); open = e.data.turn; turns.push(e.data.turn); }
    if (e.type === 'turn/end') { assert.equal(open, e.data.turn, 'turn/end must match open turn'); open = null; }
  }
  assert.equal(open, null, 'no trailing open turn in the fixed file');
  assert.deepEqual(turns, [...turns].sort((a, b) => a - b), 'turns must be monotonic');
  // L1 修后引用全部平移正确：sourceEventSeqs 扁平且早于自身
  for (const e of events) {
    const seqs = e.sourceEventSeqs;
    if (!seqs) continue;
    for (const s of seqs) assert.ok(Number.isInteger(s) && s >= 0 && s < e.seq, `sourceEventSeqs must be flat earlier ints: ${JSON.stringify(seqs)} at seq=${e.seq}`);
  }
  // 双快检绿
  assert.match(run('fix-turn-rewind.mjs', 'check', step2), /OK: /, 'L5 修后 turn 机绿');
  assert.match(run('fix-surface-ranges.mjs', 'check', step2), /OK: no nested ranges/, 'L1 修后区间绿');
  // sweep 快检判 HEALTHY
  const sweep1 = tryRun('sweep.mjs', step2);
  assert.equal(sweep1.rc, 0, 'fixed onion must sweep HEALTHY');
  assert.match(sweep1.out, /HEALTHY/);
}

// ── L6 compaction 跨度（需 DSH_FORMAT_LIB）──
if (process.env.DSH_FORMAT_LIB) {
  seq = -1;
  const msg = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const rows6 = [hdr,
    ev('turn/start', { turn: 1 }),
    ev('user/message', msg('c0', 'first'), { surfaceOp: 'append' }),
    ev('user/message', msg('c1', 'second'), { surfaceOp: 'append' }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('compaction/start', { turn: 1, compactionId: 'cp1', sourceCommandId: 'cmd1' }),
    ev('compaction/prune', { turn: 1, compactionId: 'cp1', sourceCommandId: 'cmd1', shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1] }), // 跨度缺口：应重算为 [1,2]
    ev('compaction/end', { turn: 1, compactionId: 'cp1', sourceCommandId: 'cmd1', error: { name: 'Interrupted', code: 'INTERRUPTED' } }),
    ev('step/end', { turn: 1, step: 1 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  const f6 = join(dir, 'comp.zstd');
  writeSession(f6, rows6);
  const out6 = join(dir, 'comp.fixed.zstd');
  run('fix-compaction-span.mjs', f6, out6);
  const fixed6 = openSession(out6).rows;
  const prune6 = fixed6.find((e) => e.type === 'compaction/prune');
  assert.deepEqual(prune6.data.shadowedSeqs, [1, 2], 'L6 span recomputed');
} else console.log('L6 skipped（未设 DSH_FORMAT_LIB）');

// ── L7 孤儿 offload 摘除 ──
{
  seq = -1;
  const rows7 = [hdr,
    ev('user/message', undefined, { surfaceOp: 'append', id: 'o0' }),
    ev('user/message', undefined, { surfaceOp: 'append', id: 'o1' }),
    ev('assistant/message', undefined, { surfaceOp: { startSeq: 0, endSeq: 1 }, sourceEventSeqs: [0, 1], headerSeq: 1, id: 'a7' }),
    ev('image/offload', { imageIndex: 0, targets: [{ seq: 1 }] }), // 孤儿：图不存在，且无人引用本行
  ];
  const f7 = join(dir, 'offload.zstd');
  writeSession(f7, rows7);
  const out7 = join(dir, 'offload.fixed.zstd');
  run('prune-events.mjs', f7, out7, '3');
  const fixed7 = openSession(out7).rows.slice(1);
  assert.ok(fixed7.every((e) => e.type !== 'image/offload'), 'L7 orphan offload removed');
  assert.deepEqual(fixed7.map((e) => e.seq), [0, 1, 2], 'L7 seq renumbered');
  assert.deepEqual(fixed7.at(-1).surfaceOp, { startSeq: 0, endSeq: 1 }, 'L7 replace span untouched（offload 不在面内）');
  assert.deepEqual(fixed7.at(-1).sourceEventSeqs, [0, 1], 'L7 sourceEventSeqs untouched');
}

// ── 台账：洋葱修复动作留痕 ──
{
  const ledger = join(dir, 'onion-ledger.jsonl');
  execFileSync('node', [join(BIN, 'fix-surface-ranges.mjs'), 'fix', onion, '-o', join(dir, 'again.zstd')], { encoding: 'utf8', env: { ...process.env, DSH_REPAIR_LEDGER: ledger } });
  assert.ok(existsSync(ledger), 'repair actions must ledger');
}

rmSync(dir, { recursive: true, force: true });
console.log('ONION-PASS (7 layers, cross-layer invariants hold)');
