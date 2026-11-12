import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ResetJournal, fingerprint } from '../lib/reset-journal.ts';

type Call = (endpoint: string, args: object) => Promise<any>;
function windowsMemory(pid: number) {
  const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{ pid=$p.Id; workingSet=$p.WorkingSet64; privateBytes=$p.PrivateMemorySize64; handles=$p.HandleCount; startedAt=$p.StartTime.ToString("o") } | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, 'Owned process memory sampling failed');
  return JSON.parse(result.stdout);
}
export async function runMemoryExperiment(call: Call, directory: string, sizes = [16], isolatedHome?: string) {
  const probe = (operation: string, fields: object = {}) => call('resetMemoryProbe/action', { request: { operation, ...fields } });
  const phases: any[] = [];
  const sample = async (label: string, operation = 'metrics', fields: object = {}) => {
    const value = await probe(operation, fields);
    const row = { label, ...value, os: windowsMemory(value.pid) };
    phases.push(row);
    await writeFile(join(directory, `memory-${phases.length}-${label}.json`), JSON.stringify(row, null, 2), { flag: 'wx' });
    return row;
  };
  const results = [];
  for (const size of sizes) {
    await sample(`base-${size}`, 'gc');
    const fixture = await probe('fixture', { fixtureMiB: size });
    const sessionId = fixture.sessionId;
    await writeFile(join(directory, `memory-fixture-${size}.json`), JSON.stringify(fixture, null, 2), { flag: 'wx' });
    const loaded = await sample(`loaded-${size}`, 'gc');
    await probe('sample-start');
    const reset = await call('sessionReset/sessionResetExecute', { request: { sessionId, confirmShortId: sessionId.slice(8, 16) } });
    assert.equal(reset.phase, 'DONE'); assert.equal(reset.sameId, true); assert.equal(reset.verified, true); assert.equal(reset.after.totalTurns, 1);
    assert.ok(isolatedHome, 'The original verification must use the owned isolated home');
    const journal = ResetJournal.load(isolatedHome, reset.operationId);
    assert.equal(journal.phase(), 'committed');
    for (const entry of journal.manifest.entries) assert.deepEqual(await fingerprint(join(journal.quarantine, 'original', entry.path)), entry.original);
    await writeFile(join(directory, `memory-reset-${size}.json`), JSON.stringify(reset, null, 2), { flag: 'wx' });
    const returned = await sample(`reset-returned-${size}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const natural = await sample(`reset-idle-${size}`);
    const afterGc = await sample(`reset-gc-${size}`, 'gc');
    const refreshed = await sample(`public-refresh-${size}`, 'public-refresh', { sessionId });
    const afterRefreshGc = await sample(`public-refresh-gc-${size}`, 'gc');
    const pressured = await sample(`memo-pressure-${size}`, 'memo-pressure', { sessionId });
    const afterMemoGc = await sample(`memo-pressure-gc-${size}`, 'gc');
    const outerRefreshed = await sample(`outer-owner-refresh-${size}`, 'full-owner-refresh', { sessionId });
    const afterOuterGc = await sample(`outer-owner-gc-${size}`, 'gc');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const settled = await sample(`settled-${size}`);
    const trace = await probe('sample-stop');
    await writeFile(join(directory, `memory-trace-${size}.json`), JSON.stringify(trace, null, 2), { flag: 'wx' });
    const pids = new Set([loaded, returned, natural, afterGc, refreshed, afterRefreshGc, pressured, afterMemoGc, outerRefreshed, afterOuterGc, settled].map((row) => row.pid));
    assert.equal(pids.size, 1, 'The measured runtime must remain the same process');
    const sourceCache = (row: any) => row.cache?.find((entry: any) => entry.sessionId === sessionId);
    const result = { fixtureMiB: size, sessionId, pid: loaded.pid, before: loaded, returned, natural, afterGc, refreshed, afterRefreshGc, pressured, afterMemoGc, outerRefreshed, afterOuterGc, settled, originalCacheAfterReset: sourceCache(afterGc), originalCacheAfterRefresh: sourceCache(afterRefreshGc), heapDropAfterOuterRelease: afterMemoGc.heapUsed - afterOuterGc.heapUsed, heapDropAfterMemoPressure: afterRefreshGc.heapUsed - afterMemoGc.heapUsed, heapDropAfterRefresh: afterGc.heapUsed - afterRefreshGc.heapUsed, rssDropAfterRefresh: afterGc.rss - afterRefreshGc.rss, heapDropFromLoaded: loaded.heapUsed - afterRefreshGc.heapUsed, resetResult: reset, resetPeak: { heapUsed: Math.max(...trace.samples.map((row: any) => row.heapUsed)), rss: Math.max(...trace.samples.map((row: any) => row.rss)) }, forcedGcIsDiagnostic: true, originalPreserved: true, sourceIdPreserved: true };
    results.push(result);
    await writeFile(join(directory, `memory-comparison-${size}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ memoryTrial: size, pid: loaded.pid, loadedHeapMB: +(loaded.heapUsed / 1048576).toFixed(1), afterResetGcHeapMB: +(afterGc.heapUsed / 1048576).toFixed(1), afterPublicRefreshGcHeapMB: +(afterRefreshGc.heapUsed / 1048576).toFixed(1), afterMemoGcHeapMB: +(afterMemoGc.heapUsed / 1048576).toFixed(1), afterOuterGcHeapMB: +(afterOuterGc.heapUsed / 1048576).toFixed(1), outerDropMB: +(result.heapDropAfterOuterRelease / 1048576).toFixed(1), memoDropMB: +(result.heapDropAfterMemoPressure / 1048576).toFixed(1), heapDropMB: +(result.heapDropAfterRefresh / 1048576).toFixed(1), oldCacheEvents: result.originalCacheAfterReset?.events, refreshedCacheEvents: result.originalCacheAfterRefresh?.events }));
  }
  await writeFile(join(directory, 'memory-result.json'), JSON.stringify({ kind: 'isolated-real-dsh-reset-memory-comparison', results, businessSessionsUsed: false, currentDshRestarted: false, forcedGcIsDiagnostic: true }, null, 2), { flag: 'wx' });
}
