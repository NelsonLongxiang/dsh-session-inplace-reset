// Explicit integration check: existing DSH runtime, isolated DSH_HOME and random port; no live instance mutation.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ResetJournal, fingerprint } from '../lib/reset-journal.ts';

const value = (flag: string) => { const index = process.argv.indexOf(flag); assert.ok(index >= 0 && process.argv[index + 1], `Missing ${flag}`); return resolve(process.argv[index + 1]); };
const launcher = value('--launcher');
const archive = value('--archive');
const evidence = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `install-${randomUUID()}`);
const home = join(evidence, 'isolated-home');
const profile = join(home, 'profiles/web');
await mkdir(profile, { recursive: true });
const note = (phase: string) => appendFileSync(join(evidence, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), phase }) + '\n', 'utf8');
note('prepare isolated profile');
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'session-reset-install-check', private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2));
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
const environment = { ...process.env, DSH_HOME: home };
const installer = spawnSync(process.execPath, [launcher, 'plugin', '--profile', 'web', 'add', archive, '--save-exact', '--offline', '--ignore-scripts'], { env: environment, encoding: 'utf8', timeout: 60000, windowsHide: true });
assert.equal(installer.status, 0, 'Isolated package installation failed');
note('offline installation complete');
const installed = join(profile, 'node_modules/@local/dsh-session-inplace-reset');
const resolved = await realpath(installed);
assert.ok(resolved.toLowerCase().includes('node_modules'), 'The check must use a normal installed package, not an external source link');
const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
assert.equal(metadata.main, 'dist/index.js');
const expectedKey = 'sandbox-only-not-a-real-key';
async function credentialHash() {
  try { return createHash('sha256').update(await readFile(join(homedir(), '.dsh/.credentials.yaml'))).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const realCredentialsBefore = await credentialHash();
async function start() {
  note('start isolated runtime');
  let output = '';
  const child = spawn(process.execPath, [launcher, '--profile', 'web', '--port', '0', '--no-open'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const processId = randomUUID();
  await writeFile(join(evidence, `owned-process-${processId}.json`), JSON.stringify({ pid: child.pid, home, startedAt: new Date().toISOString() }), { flag: 'wx' });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let closed = false;
  const stop = async () => {
    if (closed) return;
    note('stop isolated runtime');
    closed = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      const timeout = setTimeout(() => reject(new Error('Owned isolated DSH did not close')), 10000);
      child.once('exit', () => { clearTimeout(force); clearTimeout(timeout); resolve(); });
      child.kill('SIGTERM');
    });
    await writeFile(join(evidence, `closed-process-${processId}.json`), JSON.stringify({ pid: child.pid, exited: true, exitCode: child.exitCode, signal: child.signalCode }), { flag: 'wx' });
  };
  try {
    const deadline = Date.now() + 60000;
    let url: string | undefined;
    while (Date.now() < deadline) {
      url = output.match(/http:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_-]+/)?.[0];
      if (url) break;
      if (child.exitCode !== null) throw new Error('Isolated DSH exited during startup');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(url, 'Isolated DSH never announced readiness');
    note('isolated runtime ready');
    const address = new URL(url);
    assert.notEqual(address.port, '3080');
    const login = await fetch(url, { redirect: 'manual' });
    const cookie = login.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
    assert.ok(cookie);
    const call = async (endpoint: string, args: object) => {
      note(`request ${endpoint}`);
      const rpcId = randomUUID();
      const response = await fetch(`${address.origin}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200, endpoint);
      const full = await response.json();
      assert.equal(full.rpcId, rpcId);
      if (full.result?.ok !== true) throw new Error(`${endpoint}: ${String(full.result?.error?.message ?? 'rejected').replaceAll(expectedKey, '[sandbox key redacted]')}`);
      note(`completed ${endpoint}`);
      return full.result.value;
    };
    return { child, call, stop, safeOutput: () => output.replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]').replaceAll(expectedKey, '[sandbox key redacted]') };
  } catch (error) {
    await stop();
    await writeFile(join(evidence, `startup-failure-${randomUUID()}.redacted.log`), output.replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]').replaceAll(expectedKey, '[sandbox key redacted]'));
    throw error;
  }
}
let first: Awaited<ReturnType<typeof start>> | undefined;
let second: Awaited<ReturnType<typeof start>> | undefined;
try {
  first = await start();
  const plugins = await first.call('pluginManager/listPlugins', {});
  assert.ok(plugins.some((item: any) => item.moduleName === metadata.name && item.fiberPhase === 'active'));
  const saved = await first.call('sessionReset/sessionResetSaveEvaluationSettings', { request: { apiBase: 'http://127.0.0.1:9/evaluate', apiKey: expectedKey } });
  assert.equal(saved.hasSavedKey, true);
  assert.ok(!JSON.stringify(saved).includes(expectedKey));
  const pending = await first.call('sessionReset/sessionResetRecoveryStatus', { sessionId: 'session-11111111-1111-1111-1111-111111111111' });
  assert.equal(pending.operations.length, 0);
  const source = await first.call('session/create', { request: { cwd: evidence, agentPreset: 'minimal' } });
  await first.call('session/rename', { request: { sessionId: source.sessionId, title: '[reset-test] isolated crash recovery' } });
  const task = await first.call('sessionReset/sessionResetModelPreviewStart', { sessionId: source.sessionId });
  assert.equal(task.sessionId, source.sessionId);
  assert.equal(task.progress.concurrency, 4);
  let taskView = task;
  for (let i = 0; i < 100 && taskView.running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    taskView = await first.call('sessionReset/sessionResetModelPreviewStatus', { request: { sessionId: source.sessionId, taskId: task.taskId } });
  }
  assert.equal(taskView.running, false);
  assert.equal(taskView.progress.running, 0);
  assert.equal(taskView.progress.phase, 'complete');
  assert.equal(taskView.report.sessionId, source.sessionId);
  assert.ok(!JSON.stringify(taskView).includes(expectedKey));
  const goalTask = await first.call('sessionReset/sessionResetModelPreviewStartWithGoal', { request: { sessionId: source.sessionId, continuationGoal: '仅验证显式续接目标，不执行历史命令' } });
  assert.notEqual(goalTask.taskId, task.taskId);
  let goalView = goalTask;
  for (let i = 0; i < 100 && goalView.running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    goalView = await first.call('sessionReset/sessionResetModelPreviewStatus', { request: { sessionId: source.sessionId, taskId: goalTask.taskId } });
  }
  assert.equal(goalView.running, false);
  assert.equal(goalView.report.continuation.goal, '仅验证显式续接目标，不执行历史命令');
  const topicTask = await first.call('sessionReset/sessionResetTopicPreviewStart', { sessionId: source.sessionId });
  let topics = topicTask;
  for (let i = 0; i < 100 && topics.running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    topics = await first.call('sessionReset/sessionResetTopicPreviewStatus', { request: { sessionId: source.sessionId, taskId: topicTask.taskId } });
  }
  assert.equal(topics.running, false);
  assert.equal(topics.error, undefined);
  assert.equal(topics.report.status, 'ready');
  assert.equal(topics.report.requests, 0, 'The empty isolated source must not send a paid model request');
  assert.equal(topics.report.topics.length, 0);
  const projections = await first.call('session/projections', { request: { sessionId: source.sessionId } });
  assert.equal(projections.kind, 'sequenced');
  const backup = await first.call('session/fork', { request: { sessionId: source.sessionId, atSeq: projections.asOfSeq } });
  await first.stop();
  const interrupted = await ResetJournal.create(home, source.sessionId, randomUUID(), backup.sessionId);
  await interrupted.quarantineOriginal();
  await writeFile(join(evidence, 'first-start.redacted.log'), first.safeOutput());
  second = await start();
  const listedBeforeRecovery = await second.call('session/list', { _request: {} });
  const sourceVisibleBeforeRecovery = listedBeforeRecovery.items.some((item: any) => item.sessionId === source.sessionId);
  const interruptedIndex = await second.call('sessionReset/sessionResetRecoveries', {});
  assert.ok(interruptedIndex.operations.some((item: any) => item.operationId === interrupted.manifest.operationId && item.sessionId === source.sessionId));
  const interruptedState = await second.call('sessionReset/sessionResetRecoveryStatus', { sessionId: source.sessionId });
  assert.equal(interruptedState.operations.length, 1);
  const recovered = await second.call('sessionReset/sessionResetResume', { request: { sessionId: source.sessionId, operationId: interrupted.manifest.operationId, confirmShortId: source.sessionId.slice(8, 16) } });
  assert.equal(recovered.phase, 'RECOVERED');
  assert.equal(recovered.verified, true);
  for (const entry of interrupted.manifest.entries) assert.deepEqual(await fingerprint(join(home, entry.path)), entry.original);
  const restoredDirectory = await second.call('session/list', { _request: {} });
  assert.ok(restoredDirectory.items.some((item: any) => item.sessionId === source.sessionId), 'Recovered session must reappear in the native directory');
  assert.equal((await second.call('sessionReset/sessionResetRecoveryStatus', { sessionId: source.sessionId })).operations.length, 0);
  const persisted = await second.call('sessionReset/sessionResetEvaluationSettings', {});
  assert.equal(persisted.apiBase, 'http://127.0.0.1:9/evaluate');
  assert.equal(persisted.hasSavedKey, true);
  assert.ok(!JSON.stringify(persisted).includes(expectedKey));
  assert.equal(await credentialHash(), realCredentialsBefore, 'Real user credential storage changed');
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ package: metadata.name, version: metadata.version, installedPath: resolved, isolatedHome: home, sourceVisibleBeforeRecovery, recoveryOperationId: interrupted.manifest.operationId, checks: ['normal offline package installation', 'compiled package active in real DSH', 'new typed endpoints available', 'task start and progress available after cold boot', 'explicit goal survives typed RPC and isolates the preview task', 'topic endpoints use session model metadata without a paid call for an empty source', 'native credential save returns no secret', 'native credential persisted across isolated restart', 'interrupted real DSH session recovered through RPC', 'restored filesystem fingerprints match original', 'real credentials unchanged', 'live DSH not stopped'] }, null, 2), { flag: 'wx' });
  console.log(`PASS package install, native credential persistence and same-ID recovery; evidence: ${evidence}`);
} finally {
  await first?.stop(); await second?.stop();
  if (first) await writeFile(join(evidence, 'first-start.redacted.log'), first.safeOutput());
  if (second) await writeFile(join(evidence, 'second-start.redacted.log'), second.safeOutput());
}
