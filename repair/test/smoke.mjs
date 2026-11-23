// 自检：合成最小会话，跑修复工具的 check/fix 全链（不依赖 DSH_FORMAT_LIB）。
// 运行：npm test（或 node test/smoke.mjs）。全部断言过 → SMOKE-PASS。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openSession, writeSession, replaySurface } from '../lib/v4-file.mjs';

const BIN = join(import.meta.dirname, '..', 'bin');
const run = (tool, ...args) => execFileSync('node', [join(BIN, tool), ...args], { encoding: 'utf8' });
const hdr = { type: 'session', version: 4, sessionId: 'smoke', workspace: '/tmp/x' };
let seq = -1;
const ev = (type, data, extra = {}) => ({ type, seq: ++seq, time: 1700000000000, ...extra, ...(data === undefined ? {} : { data }) });
const dir = mkdtempSync(join(tmpdir(), 'dshsr-'));

// ── 用例 1：turn 回退修复 ──
{
  seq = -1;
  const rows = [hdr,
    ev('turn/start', { turn: 1 }), ev('step/start', { turn: 1, step: 1 }), ev('step/end', { turn: 1, step: 1 }), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', { turn: 2 }), ev('step/start', { turn: 2, step: 1 }), ev('step/end', { turn: 2, step: 1 }), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    // 回退：turn 1 重开，后缀整体少 1
    ev('turn/start', { turn: 1 }), ev('step/start', { turn: 1, step: 1 }), ev('step/end', { turn: 1, step: 1 }), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', { turn: 2 }), ev('step/start', { turn: 2, step: 1 }), ev('step/end', { turn: 2, step: 1 }), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ];
  const f = join(dir, 'rewind.zstd');
  writeSession(f, rows);
  let rc = 0, out = '';
  try { run('fix-turn-rewind.mjs', 'check', f); } catch (e) { rc = e.status; out = (e.stderr || '') + (e.stdout || ''); }
  assert.equal(rc, 2, 'check must flag rewind');
  assert.match(out, /CORRUPT: turn\/start seq=\d+ got=1 expect=3/);
  const fixed = join(dir, 'rewind.fixed.zstd');
  run('fix-turn-rewind.mjs', 'fix', f, '-o', fixed);
  const ok = run('fix-turn-rewind.mjs', 'check', fixed);
  assert.match(ok, /turns=\[1,2,3,4\]/, 'turns renumbered 1..4');
}

// ── 用例 2：sourceEventSeqs 区间对展开 ──
{
  seq = -1;
  const rows = [hdr,
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u1' }),
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u2' }),
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u3' }),
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u4' }),
    ev('assistant/message', undefined, { surfaceOp: { startSeq: 0, endSeq: 3 }, sourceEventSeqs: [0, [1, 3]], id: 'a1' }),
  ];
  const f = join(dir, 'ranges.zstd');
  writeSession(f, rows);
  const chk = run('fix-surface-ranges.mjs', 'check', f);
  assert.match(chk, /RANGES: /);
  const fixed = join(dir, 'ranges.fixed.zstd');
  run('fix-surface-ranges.mjs', 'fix', f, '-o', fixed);
  assert.match(run('fix-surface-ranges.mjs', 'check', fixed), /OK: no nested ranges/);
  assert.deepEqual(openSession(fixed).rows.at(-1).sourceEventSeqs, [0, 1, 2, 3]);
}

// ── 用例 3：prune-events 重排＋引用平移＋悬挂守卫 ──
{
  seq = -1;
  const rows = [hdr,
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u0' }),
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u1' }),
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u2' }),
    ev('user/message', undefined, { surfaceOp: 'append', id: 'u3' }),
    ev('assistant/message', undefined, { surfaceOp: { startSeq: 0, endSeq: 3 }, sourceEventSeqs: [0, 1, 3], headerSeq: 1, id: 'a1' }),
  ];
  const f = join(dir, 'prune.zstd');
  writeSession(f, rows);
  const fixed = join(dir, 'prune.fixed.zstd');
  run('prune-events.mjs', f, fixed, '2');
  const got = openSession(fixed).rows.slice(1);
  assert.deepEqual(got.map(e => e.seq), [0, 1, 2, 3], 'seqs renumbered dense');
  assert.deepEqual(got.at(-1).surfaceOp, { startSeq: 0, endSeq: 2 }, 'replace span shifted');
  assert.deepEqual(got.at(-1).sourceEventSeqs, [0, 1, 2], 'sourceEventSeqs shifted');
  // 悬挂：引用指向被删 seq → 拒修 rc=2
  {
    seq = -1;
    const rows2 = [hdr,
      ev('user/message', undefined, { surfaceOp: 'append', id: 'u0' }),
      ev('user/message', undefined, { surfaceOp: 'append', id: 'u1' }),
      ev('assistant/message', undefined, { surfaceOp: { startSeq: 0, endSeq: 1 }, sourceEventSeqs: [0, 1], id: 'a1' }),
    ];
    const f2 = join(dir, 'prune2.zstd');
    writeSession(f2, rows2);
    let rc = 0;
    try { run('prune-events.mjs', f2, join(dir, 'x.zstd'), '1'); } catch (e) { rc = e.status; }
    assert.equal(rc, 2, 'dangling ref must abort');
  }
}

// ── 用例 4：replaySurface fold（append/replace）──
{
  seq = -1;
  const events = [
    ev('user/message', undefined, { surfaceOp: 'append' }),
    ev('user/message', undefined, { surfaceOp: 'append' }),
    ev('user/message', undefined, { surfaceOp: 'append' }),
    ev('assistant/message', undefined, { surfaceOp: { startSeq: 0, endSeq: 1 } }),
    ev('user/message', undefined, { surfaceOp: 'append' }),
  ];
  const r = replaySurface(events, 99);
  assert.deepEqual(r.surface, [3, 2, 4], 'replace splices in place');
}

// ── 用例 5：sweep 全量分诊＋triage 红字分诊 ──
{
  const root = join(dir, 'root');
  const wsA = join(root, 'ws-a', 'session-aaaaaaaa-0000-0000-0000-000000000000');
  const wsB = join(root, 'ws-b', 'session-bbbbbbbb-0000-0000-0000-000000000000');
  mkdirSync(wsA, { recursive: true });
  mkdirSync(wsB, { recursive: true });
  seq = -1;
  writeSession(join(wsA, 'session.v4.jsonl.zstd'), [hdr,
    ev('turn/start', { turn: 1 }), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  seq = -1;
  writeSession(join(wsB, 'session.v4.jsonl.zstd'), [hdr,
    ev('turn/start', { turn: 1 }), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', { turn: 1 }), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]);
  let rc = 0, out = '';
  try { run('sweep.mjs', '--root', root); } catch (e) { rc = e.status; out = (e.stdout || '') + (e.stderr || ''); }
  assert.equal(rc, 2, 'sweep must exit 2 when a session is sick');
  assert.match(out, /aaaaaaaa\s+HEALTHY/);
  assert.match(out, /bbbbbbbb\s+SICK\s+turn-rewind/);
  assert.match(out, /有病 1/);
  const t1 = run('triage.mjs', 'is corrupt: SessionFormatError: turn/start does not open the expected turn');
  assert.match(t1, /判定：turn 回退/);
  assert.match(t1, /fix-turn-rewind/);
  const t2 = run('triage.mjs', 'image/offload: image index 0 does not exist');
  assert.match(t2, /prune-events/);
  let rc3 = 0;
  try { run('triage.mjs', 'something totally unknown'); } catch (e) { rc3 = e.status; }
  assert.equal(rc3, 1, 'unknown error must exit 1');
}

rmSync(dir, { recursive: true, force: true });
console.log('SMOKE-PASS (5 cases)');
