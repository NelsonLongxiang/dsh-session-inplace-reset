// Explicit integration drill: only the newly forked, labelled test session is reset. Never restarts DSH.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../lib/ledger.ts';
import { ResetJournal } from '../lib/reset-journal.ts';
import { packageRoot, testSourceSession } from './runtime.ts';

const verifyIndex = process.argv.indexOf('--verify-existing');
const reloadOnly = process.argv.includes('--reload-only');
const prepareModel = process.argv.includes('--prepare-model-preview');
const inspectOnly = process.argv.includes('--inspect-only');
if (!process.argv.includes('--run') && verifyIndex === -1 && !reloadOnly && !prepareModel && !inspectOnly) throw new Error('Pass --run, --verify-existing <result.json>, --reload-only, --inspect-only, or --prepare-model-preview');
const prior = verifyIndex === -1 ? null : JSON.parse(await readFile(process.argv[verifyIndex + 1], 'utf8'));
const repo = packageRoot;
if ((process.argv.includes('--run') || prepareModel) && !/^session-[0-9a-f-]{36}$/i.test(testSourceSession ?? '')) throw new Error('Set DSH_TEST_SOURCE_SESSION before a fork drill; no source is selected implicitly');
const logs = [join(homedir(), '.dsh/logs/web-3080.log')];
for (const [root, pattern] of [[tmpdir(), /^dsh-(?:pocket|inplace)-restart-.*\.out\.log$/], [join(repo, 'tmp'), /^(?:d\d+|dsh-.*)\.out$/]]) {
  for (const name of await readdir(root).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) if (pattern.test(name)) logs.push(join(root, name));
}
const ordered = (await Promise.all(logs.map(async (path) => ({ path, time: (await stat(path)).mtimeMs })))).sort((a, b) => b.time - a.time);
let call;
for (const { path } of ordered.slice(0, 14)) {
  const tokens = [...(await readFile(path, 'utf8')).matchAll(/token=([A-Za-z0-9_-]+)/g)];
  if (!tokens.length) continue;
  const response = await fetch(`http://127.0.0.1:3080/?token=${tokens.at(-1)[1]}`, { redirect: 'manual' });
  const cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  if (!cookie) continue;
  const rpc = async (endpoint, args) => {
    const rpcId = crypto.randomUUID();
    const invoke = () => fetch(`http://127.0.0.1:3080/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), signal: AbortSignal.timeout(90_000) });
    let response;
    try { response = await invoke(); }
    catch (error) {
      if (!['session/list', 'sessionReset/sessionResetDryRun'].includes(endpoint)) throw error;
      response = await invoke(); // Only these read-only calls may be retried after a stale keep-alive socket.
    }
    assert.equal(response.status, 200, endpoint);
    const full = await response.json();
    assert.equal(full.rpcId, rpcId);
    if (!full.result?.ok) throw new Error(`${endpoint}: ${full.result?.error?.message}`);
    return full.result.value;
  };
  try { await rpc('session/list', { _request: {} }); call = rpc; break; } catch { /* Try the next existing log, without printing credentials. */ }
}
assert.ok(call, 'No valid DSH session credential found');
const pid = () => {
  const value = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3080 -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess'], { encoding: 'utf8', timeout: 15_000 }).trim());
  assert.ok(Number.isSafeInteger(value) && value > 0, 'Could not identify the serving DSH process');
  return value;
};
const beforePid = prior?.beforePid ?? pid();
const evidence = prior ? { ...prior, checks: [] } : { beforePid, checks: [] };
delete evidence.error;
const out = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `live-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(out, { recursive: true });
try {
  if (inspectOnly) {
    const plugins = await call('pluginManager/listPlugins', {});
    const selected = plugins.filter((item) => item.moduleName.includes('session-inplace-reset') || item.moduleName.includes('typert-loader'));
    evidence.entries = selected.map(({ entryId, moduleName, enabled, fiberPhase, readOnlyReason }) => ({ entryId, moduleName, enabled, fiberPhase, readOnlyReason }));
    console.log(JSON.stringify(evidence.entries, null, 2));
  } else if (reloadOnly) {
    const home = join(homedir(), '.dsh');
    const latest = new Map(new Ledger(home).rows.map((row) => [row.operationId, row]));
    assert.ok([...latest.values()].every((row) => {
      if (!['RUNNING', 'BACKED_UP'].includes(row.state)) return true;
      try { return ['committed', 'recovered'].includes(ResetJournal.load(home, row.operationId).phase()); } catch { return false; }
    }), 'A reset is unfinished; leave plugin mounted and inspect its transaction');
    const disabled = await call('pluginManager/setBundleEnabled', { name: '@local/dsh-session-inplace-reset', enabled: false });
    assert.equal(disabled.application, 'applied', JSON.stringify(disabled));
    const enabled = await call('pluginManager/setBundleEnabled', { name: '@local/dsh-session-inplace-reset', enabled: true });
    evidence.reload = enabled;
    assert.equal(enabled.application, 'applied', JSON.stringify(enabled));
    assert.equal(pid(), beforePid);
    evidence.checks.push('plugin hot reload only', 'DSH PID unchanged', 'no session create, prompt, fork, reset, or restart requested');
    console.log(`PASS plugin reload only; DSH PID ${beforePid} unchanged`);
  } else if (prepareModel) {
    const listed = await call('session/list', { _request: {} });
    const source = listed.items.find((item) => item.sessionId === testSourceSession);
    assert.ok(source, 'Explicit test source is missing; no other source will be substituted');
    const target = await call('session/fork', { request: { sessionId: source.sessionId } });
    assert.ok(target.sessionId && target.sessionId !== source.sessionId, 'Fork must return a distinct test ID');
    evidence.sourceSessionId = source.sessionId;
    evidence.testSessionId = target.sessionId;
    await call('session/rename', { request: { sessionId: target.sessionId, title: '[reset-test] decision-model preview' } });
    assert.equal(pid(), beforePid);
    evidence.checks.push('forked previous test session only', 'no prompt or reset requested', 'DSH PID unchanged');
    console.log(`Prepared labelled preview fixture ${target.sessionId}`);
  } else {
  if (!prior) {
  // Reload only this plugin. Other plugins and the DSH process remain mounted.
  await call('pluginManager/setBundleEnabled', { name: '@local/dsh-session-inplace-reset', enabled: false });
  await call('pluginManager/setBundleEnabled', { name: '@local/dsh-session-inplace-reset', enabled: true });
  assert.equal(pid(), beforePid);
  const listed = await call('session/list', { _request: {} });
  const source = listed.items.find((item) => item.sessionId === testSourceSession);
  assert.ok(source, 'Read-only fork source missing');
  const guardian = await call('session/create', { request: { cwd: source.cwd } });
  evidence.guardianId = guardian.sessionId;
  const target = await call('session/fork', { request: { sessionId: source.sessionId } });
  assert.ok(target.sessionId && target.sessionId !== source.sessionId, 'Fork must return a distinct test ID');
  evidence.sourceSessionId = source.sessionId;
  evidence.testSessionId = target.sessionId;
  await call('session/rename', { request: { sessionId: target.sessionId, title: '[reset-test] live lifecycle drill' } });
  const dry = await call('sessionReset/sessionResetDryRun', { sessionId: target.sessionId });
  evidence.before = dry;
  assert.ok(Number.isInteger(dry.totalTurns), 'New host code was not activated');
  assert.equal(dry.canReset, true, dry.blockedReason);
  const browser = spawnSync(process.execPath, [join(repo, 'test/browser-menu.mjs'), '--execute-test-session', target.sessionId], { cwd: repo, encoding: 'utf8', timeout: 100_000 });
  console.log(browser.stdout);
  assert.equal(browser.status, 0, browser.stderr);
  }
  const dry = evidence.before;
  const targetId = evidence.testSessionId;
  evidence.afterPid = pid();
  assert.equal(evidence.afterPid, beforePid);
  const after = await call('sessionReset/sessionResetDryRun', { sessionId: targetId });
  evidence.after = after;
  assert.equal(after.totalTurns, 1);
  assert.ok(after.totalEvents < dry.totalEvents);
  const list = await call('session/list', { _request: {} });
  if (evidence.sourceSessionId) assert.ok(list.items.find((item) => item.sessionId === evidence.sourceSessionId), 'Source conversation disappeared');
  else evidence.checks.push('source-presence check NOT_RUN: legacy evidence has no source identity');
  const guard = list.items.find((item) => item.sessionId === evidence.guardianId);
  assert.ok(guard?.agentAvailable && !guard.running, 'Unrelated live agent changed');
  evidence.checks.push('plugin hot reload without DSH restart', 'already-live fork reset through real menu', 'persisted turn count is one', 'event count reduced', 'serving PID unchanged', 'unrelated live agent remains attached');
  console.log(`PASS live reset: ${dry.totalTurns} → ${after.totalTurns} turns; ${dry.totalEvents} → ${after.totalEvents} events; PID ${beforePid} unchanged`);
  }
} catch (error) {
  evidence.error = error.message;
  throw error;
} finally {
  await writeFile(join(out, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(`Integration evidence: ${out}`);
}
