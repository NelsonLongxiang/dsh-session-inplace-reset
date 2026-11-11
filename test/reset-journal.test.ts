import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { ResetJournal, recoveryStatus } from '../lib/reset-journal.ts';

const sessionId = 'session-11111111-1111-1111-1111-111111111111';
const backupId = 'session-22222222-2222-2222-2222-222222222222';
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'reset-journal-'));
  const originals = new Map([
    [`sessions/bucket/${sessionId}/log.bin`, Buffer.from([0, 1, 2, 255, 10])],
    [`storages/session_projcache/sessions/${sessionId}.json`, Buffer.from('{"original":true}')],
    [`rewind-snapshots/${sessionId}/record.bin`, Buffer.from('original rewind')],
  ]);
  for (const [path, content] of originals) { await mkdir(dirname(join(home, path)), { recursive: true }); await writeFile(join(home, path), content); }
  const journal = await ResetJournal.create(home, sessionId, randomUUID(), backupId);
  const verify = async () => { for (const [path, content] of originals) assert.deepEqual(await readFile(join(home, path)), content); };
  return { home, journal, verify, originals };
}

test('new generation is preserved and original entities are restored byte-for-byte', async () => {
  const f = await fixture();
  await f.journal.quarantineOriginal();
  await mkdir(join(f.home, 'sessions/bucket', sessionId), { recursive: true });
  await writeFile(join(f.home, 'sessions/bucket', sessionId, 'new.txt'), 'new generation');
  const result = await f.journal.restoreOriginal();
  await f.verify();
  assert.equal(await readFile(join(result.preservation, 'sessions/bucket', sessionId, 'new.txt'), 'utf8'), 'new generation');
  assert.equal(f.journal.phase(), 'recovered');
  await assert.rejects(f.journal.restoreOriginal(), /已经完成/);
  assert.equal(recoveryStatus(f.home, sessionId).operations.length, 0);
});

test('a verified quarantined original can be restored without hashing a changing new cache generation', async (t) => {
  const f = await fixture();
  await f.journal.quarantineOriginal();
  const cache = join(f.home, `storages/session_projcache/sessions/${sessionId}.json`);
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, 'new generation still settling');
  const originalStream = fs.createReadStream;
  const patched = t.mock.method(fs, 'createReadStream', (path: Parameters<typeof fs.createReadStream>[0], options?: Parameters<typeof fs.createReadStream>[1]) => {
    if (String(path) === cache && fs.readFileSync(cache, 'utf8').includes('new generation')) throw new Error('injected concurrent cache change');
    return originalStream(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { patched.mock.restore(); syncBuiltinESMExports(); });
  const restored = await f.journal.restoreOriginal();
  await f.verify();
  assert.equal(await readFile(join(restored.preservation, `storages/session_projcache/sessions/${sessionId}.json`), 'utf8'), 'new generation still settling');
});

test('filesystem placement recovers a rename whose event was never committed', async () => {
  const f = await fixture();
  const relative = f.journal.manifest.entries[0].path;
  const destination = join(f.journal.quarantine, 'original', relative);
  await mkdir(dirname(destination), { recursive: true });
  fs.renameSync(join(f.home, relative), destination);
  const reloaded = ResetJournal.load(f.home, f.journal.manifest.operationId);
  assert.equal(reloaded.phase(), 'prepared');
  await reloaded.restoreOriginal();
  await f.verify();
});

test('process termination during isolation leaves a discoverable and recoverable transaction', async () => {
  const f = await fixture();
  const script = join(f.home, 'crash-runner.mjs');
  // Pass the actual URL, avoiding platform-specific file URL reconstruction.
  const source = `import { ResetJournal } from ${JSON.stringify(new URL('../lib/reset-journal.ts', import.meta.url).href)}; import {renameSync,mkdirSync} from 'node:fs'; import {join,dirname} from 'node:path'; const j=ResetJournal.load(${JSON.stringify(f.home)},${JSON.stringify(f.journal.manifest.operationId)}); j.record('quarantining'); const e=j.manifest.entries[0]; const to=join(j.quarantine,'original',e.path); mkdirSync(dirname(to),{recursive:true}); renameSync(join(j.home,e.path),to); console.log('READY'); setInterval(()=>{},1000);`;
  await writeFile(script, source);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Crash fixture did not become ready')); }, 10000);
    child.stdout.on('data', (chunk) => { if (chunk.toString().includes('READY')) { ready = true; clearTimeout(timeout); child.kill('SIGKILL'); } });
    child.on('exit', () => { clearTimeout(timeout); if (!ready) reject(new Error('Child exited before the crash boundary')); else resolve(); });
    child.on('error', reject);
  });
  assert.equal(recoveryStatus(f.home, sessionId).operations.length, 1);
  await ResetJournal.load(f.home, f.journal.manifest.operationId).restoreOriginal();
  await f.verify();
});

test('partial quarantine and partial recovery failures can be retried without overwriting originals', async (t) => {
  const f = await fixture();
  const originalRename = fs.renameSync;
  let failIsolation = true, failRestore = false;
  const patched = t.mock.method(fs, 'renameSync', (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
    if (failIsolation && String(from).endsWith(`${sessionId}.json`)) throw new Error('injected isolation failure');
    if (failRestore && String(from).includes('original') && String(from).endsWith(sessionId)) throw new Error('injected restore failure');
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { patched.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(f.journal.quarantineOriginal(), /isolation failure/);
  failIsolation = false; failRestore = true;
  await assert.rejects(f.journal.restoreOriginal(), /restore failure/);
  assert.equal(recoveryStatus(f.home, sessionId).operations.length, 1);
  failRestore = false;
  await ResetJournal.load(f.home, f.journal.manifest.operationId).restoreOriginal();
  await f.verify();
});

test('corrupt or path-tampered manifests cannot restore arbitrary files', async () => {
  const f = await fixture();
  const path = join(f.journal.directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.entries[0].path = '../credentials';
  await writeFile(path, JSON.stringify(manifest));
  assert.throws(() => ResetJournal.load(f.home, f.journal.manifest.operationId), /无效/);
  assert.equal(recoveryStatus(f.home, sessionId).issues.length, 1);
  await f.verify();
});

test('uncommitted event temporaries are ignored; committed damaged events fail closed', async () => {
  const f = await fixture();
  await mkdir(join(f.journal.directory, 'events'), { recursive: true });
  await writeFile(join(f.journal.directory, 'events/interrupted.tmp'), '{');
  assert.equal(ResetJournal.load(f.home, f.journal.manifest.operationId).phase(), 'prepared');
  await writeFile(join(f.journal.directory, 'events/00000001-damaged.json'), '{');
  assert.equal(recoveryStatus(f.home, sessionId).issues.length, 1);
});
