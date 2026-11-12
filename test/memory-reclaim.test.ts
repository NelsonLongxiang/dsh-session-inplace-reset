import assert from 'node:assert/strict';
import test from 'node:test';
import { evictResetReadCaches, reclaimResetMemory } from '../lib/memory-reclaim.ts';

const source = 'session-11111111-1111-1111-1111-111111111111';
const backup = 'session-22222222-2222-2222-2222-222222222222';
const other = 'session-33333333-3333-3333-3333-333333333333';
const symbols = { original: Symbol('original') };
function fixture() {
  const events = [{ seq: 0, type: 'user/message' }];
  const query = new Map([source, backup, other].map((id) => [id, { session: { header: { id } }, events, refs: 0 }]));
  const parsed = new Map([source, backup, other].map((id) => [id, { status: 'current', meta: { id }, events }]));
  const writer = { writes: 0 };
  const ctx = { get: (name: string) => name === 'sessionQuery' ? { [symbols.original]: { _observations: { cache: query } } } : { [symbols.original]: { coldLogMemo: parsed, tracker: { writer } } } };
  return { query, parsed, writer, ctx };
}

test('memory cleanup evicts only the verified source and fork read caches, leaving writers and other sessions intact', () => {
  const f = fixture();
  const result = evictResetReadCaches(f.ctx, [source, backup], symbols);
  assert.equal(result.queryEntries, 2); assert.equal(result.persistenceEntries, 2);
  assert.deepEqual([...f.query.keys()], [other]); assert.deepEqual([...f.parsed.keys()], [other]);
  assert.equal(f.writer.writes, 0); assert.deepEqual(result.warnings, []);
});

test('active observation leases and unknown or mismatched cache shapes are preserved with warnings', () => {
  const f = fixture();
  f.query.get(source)!.refs = 1;
  f.parsed.get(backup)!.meta.id = other;
  const result = evictResetReadCaches(f.ctx, [source, backup], symbols);
  assert.equal(f.query.has(source), true);
  assert.deepEqual(result.pinnedSessions, [source]);
  assert.equal(f.parsed.has(backup), true);
  assert.ok(result.warnings.length >= 2);
  const unavailable = evictResetReadCaches({ get: () => ({}) }, [source], symbols);
  assert.equal(unavailable.queryEntries, 0); assert.equal(unavailable.persistenceEntries, 0);
  assert.equal(unavailable.warnings.length, 2);
});

test('invalid identities refuse before touching any host cache', () => {
  const f = fixture();
  assert.throws(() => evictResetReadCaches(f.ctx, [source, '../foreign'], symbols));
  assert.equal(f.query.size, 3); assert.equal(f.parsed.size, 3);
});

test('post-transaction collection reports same-process observations without starting an inspector listener', async () => {
  const f = fixture();
  const pid = process.pid;
  const report = await reclaimResetMemory(f.ctx, [source, backup], symbols);
  assert.equal(report.pid, pid);
  assert.equal(report.gcCompleted, true);
  assert.ok(report.before.heapUsed > 0 && report.after.heapUsed > 0);
  assert.ok(report.durationMs >= 0);
  assert.equal(report.queryEntries, 2); assert.equal(report.persistenceEntries, 2);
  const { url } = await import('node:inspector');
  assert.equal(url(), undefined);
});
