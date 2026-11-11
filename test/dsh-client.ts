import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function servingDshPid() {
  const value = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3080 -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess'], { encoding: 'utf8', timeout: 15000 }).trim());
  assert.ok(Number.isSafeInteger(value) && value > 0, 'Could not identify the serving DSH process');
  return value;
}

/** Authenticated local DSH API entry; login material stays in memory and is never returned. */
export async function connectDsh(requestTimeoutMs = 30000): Promise<(endpoint: string, args: object) => Promise<any>> {
  assert.ok(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1000 && requestTimeoutMs <= 600000, 'Invalid DSH request timeout');
  const candidates = [join(homedir(), '.dsh/logs/web-3080.log')];
  for (const name of await readdir(tmpdir())) if (/^dsh-(?:pocket|inplace)-restart-.*\.out\.log$/.test(name)) candidates.push(join(tmpdir(), name));
  const logs = (await Promise.all(candidates.map(async (path) => {
    try { return { path, time: (await stat(path)).mtimeMs }; } catch { return null; }
  }))).filter((item) => item !== null).sort((a, b) => b.time - a.time);
  for (const log of logs.slice(0, 14)) {
    const matches = [...(await readFile(log.path, 'utf8')).matchAll(/token=([A-Za-z0-9_-]+)/g)];
    if (!matches.length) continue;
    const login = await fetch(`http://127.0.0.1:3080/?token=${matches.at(-1)![1]}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const cookie = login.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
    if (!cookie) continue;
    const call = async (endpoint: string, args: object) => {
      assert.match(endpoint, /^[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/);
      const rpcId = randomUUID();
      const invoke = () => fetch(`http://127.0.0.1:3080/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), signal: AbortSignal.timeout(requestTimeoutMs) });
      let response;
      try { response = await invoke(); }
      catch (error) {
        if (!['session/list', 'sessionReset/sessionResetDryRun'].includes(endpoint)) throw error;
        response = await invoke(); // Preserve the integration driver's one retry for these read-only calls.
      }
      if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
      const full = await response.json();
      assert.equal(full.rpcId, rpcId, 'DSH response correlation failed');
      if (!full.result?.ok) throw new Error(`${endpoint}: ${full.result?.error?.message ?? 'request rejected'}`);
      return full.result.value;
    };
    try { await call('session/list', { _request: {} }); return call; } catch { /* Validate the next existing login without exposing it. */ }
  }
  throw new Error('No valid local DSH login was found in existing startup logs');
}
