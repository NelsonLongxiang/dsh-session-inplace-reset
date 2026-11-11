import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { executeReset, executeRecovery } from '../lib/reset.js';
import { recoveryStatus, ResetJournal } from '../lib/reset-journal.ts';

function fixture({ failCreate = false, activity = [], wrongPreset = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reset-isolated-'));
  const id = 'session-11111111-1111-1111-1111-111111111111';
  const forkId = 'session-22222222-2222-2222-2222-222222222222';
  const file = (sid) => join(home, 'sessions', 'bucket', sid, 'session.json');
  const original = { header: { id, cwd: home, agentPreset: 'standard' }, events: [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'first task' }] } },
    { type: 'turn/end', seq: 2, data: { turn: 1 } },
    { type: 'turn/start', seq: 3, data: { turn: 2 } },
    { type: 'turn/end', seq: 4, data: { turn: 2 } },
    { type: 'session/title', seq: 5, data: { title: 'original title', messageSeqs: [] } },
  ] };
  const save = (sid, value) => { mkdirSync(join(file(sid), '..'), { recursive: true }); writeFileSync(file(sid), JSON.stringify(value)); };
  save(id, original);
  const bytes = readFileSync(file(id));
  const agents = new Map();
  let locked = false;
  let released = false;
  let forkCalls = 0;
  const lifecycle = {
    async run(sid, operation) {
      if (sid === id) { assert.equal(locked, false); locked = true; }
      try { return await operation({ release: async () => { released = true; agents.delete(sid); } }); }
      finally { if (sid === id) locked = false; }
    },
    async releaseCurrent(sid) { agents.delete(sid); },
  };
  const persistence = {
    async flush() {},
    async stat(sid) { return existsSync(file(sid)) ? { sizeBytes: readFileSync(file(sid)).length } : undefined; },
    async open(sid) { return { header: JSON.parse(readFileSync(file(sid), 'utf8')).header, read: async () => ({ events: JSON.parse(readFileSync(file(sid), 'utf8')).events }), close: async () => {} }; },
  };
  const controller = {
    async fork() {
      assert.ok(released, 'writer must close before the backup is observed');
      forkCalls++;
      const source = JSON.parse(readFileSync(file(id), 'utf8'));
      save(forkId, { header: { ...source.header, id: forkId }, events: source.events });
      return { sessionId: forkId };
    },
    async create(request) {
      const fresh = { header: { id, cwd: home, agentPreset: wrongPreset ? 'standard' : request.agentPreset }, events: [] };
      save(id, fresh);
      if (failCreate) throw new Error('injected create failure');
      agents.set(id, { status: 'idle', runMaintenance: (operation) => operation(), session: {
        append(type, data, options) {
          if (type === 'user/message') assert.equal(options?.surfaceOp, 'append', 'surface messages require the host surface marker');
          fresh.events.push({ type, data, seq: fresh.events.length, ...(options ?? {}) }); save(id, fresh);
        },
      } });
      return { sessionId: id };
    },
    async rename({ sessionId, title }) { agents.get(sessionId).session.append('session/title', { title, messageSeqs: [] }); },
    agents: { async resolveAgent(sid) { return { agent: { id: sid } }; } },
  };
  const presets = { async resolve(id = 'standard') {
    if (!['standard', 'minimal', 'broken'].includes(id)) throw new Error('Unknown agent preset');
    return { id, ...(id === 'broken' ? { broken: 'injected activation error' } : {}) };
  } };
  const services = { agentPresets: presets, agents: { get: (sid) => agents.get(sid) }, sessionPersistence: persistence, sessionController: controller, workspaceRegistry: { archiveSession: async () => {} } };
  const ctx = {
    get: (name) => services[name],
    waterfall: async () => activity,
    sessionQuery: { async observeSession(sid) { return { ...JSON.parse(readFileSync(file(sid), 'utf8')), [Symbol.dispose]() {} }; } },
  };
  const rows = [];
  const ledger = { append(record) { const row = { at: rows.length + 1, ...record }; rows.push(row); return row; } };
  const run = (options = {}, request = {}) => executeReset(ctx, ledger, lifecycle, home, { sessionId: id, confirmShortId: id.slice(8, 16), ...request }, { defaultK: 12, handoffHardCapKB: 512, buildHandoff: () => ({ k: 12, recent_messages: [{ role: 'user', text: 'task history' }] }), ...options });
  return { home, file, id, run, bytes, rows, ctx, ledger, lifecycle, services, released: () => released, forkCalls: () => forkCalls };
}

test('reset completes only after a new one-turn handoff is durably read back', async () => {
  const f = fixture();
  const value = await f.run();
  assert.equal(value.phase, 'DONE');
  assert.equal(value.verified, true);
  assert.equal(value.before.totalTurns, 2);
  assert.equal(value.after.totalTurns, 1);
  assert.equal(JSON.parse(readFileSync(f.file(f.id), 'utf8')).events.find((event) => event.type === 'session/title').data.title, 'original title');
  assert.ok(existsSync(join(value.quarantine, 'original', 'sessions', 'bucket', f.id, 'session.json')));
  assert.deepEqual(readFileSync(join(value.quarantine, 'original', 'sessions', 'bucket', f.id, 'session.json')), f.bytes);
  assert.equal(f.rows.at(-1).state, 'DONE');
});

test('rebirth defaults to the original preset and can explicitly choose another on the same ID', async () => {
  const original = fixture();
  const preserved = await original.run();
  assert.equal(preserved.before.agentPreset, 'standard');
  assert.equal(preserved.after.agentPreset, 'standard');
  const changed = fixture();
  const selected = await changed.run({}, { agentPreset: 'minimal' });
  assert.equal(selected.sessionId, changed.id);
  assert.equal(selected.before.agentPreset, 'standard');
  assert.equal(selected.after.agentPreset, 'minimal');
  assert.equal(JSON.parse(readFileSync(changed.file(changed.id), 'utf8')).header.agentPreset, 'minimal');
  assert.deepEqual(readFileSync(join(selected.quarantine, 'original', 'sessions/bucket', changed.id, 'session.json')), changed.bytes);
});

test('invalid, unavailable or broken preset choices fail before release, fork and storage changes', async () => {
  for (const agentPreset of ['', null, 42, ' minimal ', 'missing', 'broken']) {
    const f = fixture();
    await assert.rejects(f.run({}, { agentPreset }));
    assert.equal(f.released(), false);
    assert.equal(f.forkCalls(), 0);
    assert.deepEqual(readFileSync(f.file(f.id)), f.bytes);
  }
});

test('a preset that disappears during backup cannot quarantine the original', async () => {
  const f = fixture();
  await assert.rejects(f.run({ buildHandoff: () => { f.services.agentPresets.resolve = async () => { throw new Error('preset removed'); }; return { recent_messages: [] }; } }, { agentPreset: 'minimal' }), /preset removed/);
  assert.deepEqual(readFileSync(f.file(f.id)), f.bytes);
  assert.equal(recoveryStatus(f.home, f.id).operations.length, 0);
});

test('a wrong rebuilt preset is rejected and restores the original preset and exact bytes', async () => {
  const f = fixture({ wrongPreset: true });
  await assert.rejects(f.run({}, { agentPreset: 'minimal' }), /Agent预设与选择不一致/);
  assert.deepEqual(readFileSync(f.file(f.id)), f.bytes);
  assert.equal(f.rows.at(-1).state, 'ROLLED_BACK');
});

test('the chosen asynchronous model seed is saved exactly and its provenance is committed', async () => {
  const f = fixture();
  const seed = { kind: 'handoff-seed', version: 2, sourceSessionId: f.id, capturedThroughSeq: 5, historicalOnly: true, selected_messages: [{ role: 'user', text: 'first task', seq: 1 }] };
  const modelReportId = '33333333-3333-3333-3333-333333333333';
  const value = await f.run({ modelReportId, modelSourceHash: 'a'.repeat(64), buildHandoff: async (_events, _options, source) => { assert.equal(source.header.id, f.id); await Promise.resolve(); return seed; } }, { agentPreset: 'minimal' });
  assert.equal(value.after.agentPreset, 'minimal');
  assert.equal(value.handoffMode, 'model');
  assert.equal(value.modelReportId, modelReportId);
  const saved = JSON.parse(readFileSync(f.file(f.id), 'utf8')).events.find((event) => event.type === 'user/message').data.content[0].text;
  assert.ok(saved.endsWith(JSON.stringify(seed)));
  assert.equal(ResetJournal.load(f.home, value.operationId).events().at(-1).detail.modelReportId, modelReportId);
});

test('a rejected candidate cannot fork or replace storage and never falls back to recent sampling', async () => {
  const f = fixture();
  await assert.rejects(f.run({ buildHandoff: async () => { throw new Error('candidate expired'); } }), /candidate expired/);
  assert.equal(f.forkCalls(), 0);
  assert.deepEqual(readFileSync(f.file(f.id)), f.bytes);
  assert.equal(f.rows.at(-1).state, 'FAILED_UNCHANGED');
});

test('creation failure preserves the failed generation and restores exact original bytes', async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(f.run(), /已恢复原日志/);
  assert.deepEqual(readFileSync(f.file(f.id)), f.bytes);
  assert.equal(f.rows.at(-1).state, 'ROLLED_BACK');
  assert.equal(f.rows.some((row) => row.state === 'DONE'), false);
});

test('a verified committed reset is not rolled back when the optional history append fails', async () => {
  const f = fixture();
  const append = f.ledger.append;
  f.ledger.append = (row) => { if (row.state === 'DONE') throw new Error('injected history failure'); return append(row); };
  const value = await f.run();
  assert.equal(value.phase, 'DONE');
  assert.ok(value.auditWarning);
  assert.equal(ResetJournal.load(f.home, value.operationId).phase(), 'committed');
  assert.equal(JSON.parse(readFileSync(f.file(f.id), 'utf8')).events.filter((event) => event.type === 'turn/start').length, 1);
});

test('failed automatic recovery is HALTED, blocks another reset, and can be explicitly resumed', async (t) => {
  const f = fixture({ failCreate: true });
  const rename = fs.renameSync;
  let rejectRestore = true;
  const patched = t.mock.method(fs, 'renameSync', (from, to) => {
    if (rejectRestore && String(from).includes('original') && String(from).endsWith(f.id)) throw new Error('injected restore denial');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { patched.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(f.run(), /请恢复原日志/);
  assert.equal(f.rows.at(-1).state, 'HALTED');
  const pending = recoveryStatus(f.home, f.id);
  assert.equal(pending.operations.length, 1);
  const count = f.forkCalls();
  await assert.rejects(f.run(), /未完成/);
  assert.equal(f.forkCalls(), count);
  rejectRestore = false;
  const value = await executeRecovery(f.ctx, f.ledger, f.lifecycle, f.home, { sessionId: f.id, operationId: pending.operations[0].operationId, confirmShortId: f.id.slice(8, 16) });
  assert.equal(value.phase, 'RECOVERED');
  assert.equal(value.verified, true);
  assert.deepEqual(readFileSync(f.file(f.id)), f.bytes);
  assert.equal(recoveryStatus(f.home, f.id).operations.length, 0);
});

test('background activity refuses before creating any backup or changing source data', async () => {
  const f = fixture({ activity: [{ kind: 'job' }] });
  await assert.rejects(f.run(), /后台活动/);
  assert.equal(f.forkCalls(), 0);
  assert.deepEqual(readFileSync(f.file(f.id)), f.bytes);
  assert.equal(f.rows.length, 0);
});
