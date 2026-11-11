// Explicit live drill; --resume reuses its recorded fixture/fork and never repeats a verified reset.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../lib/ledger.ts';
import { ResetJournal, fingerprint } from '../lib/reset-journal.ts';
import { connectDsh, servingDshPid } from './dsh-client.ts';
import { packageRoot } from './runtime.ts';

const resumeIndex = process.argv.indexOf('--resume');
assert.ok(process.argv.includes('--run') || resumeIndex >= 0, 'Pass --run or --resume <recorded-run>');
const run = resumeIndex < 0 ? join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `model-apply-${randomUUID()}`) : process.argv[resumeIndex + 1];
assert.ok(run); await mkdir(run, { recursive: true });
const call = await connectDsh(90000);
const beforePid = servingDshPid();
const sourceId = resumeIndex < 0 ? `session-${randomUUID()}` : JSON.parse(await readFile(join(run, 'plan.json'), 'utf8')).sourceId;
const home = join(homedir(), '.dsh');
if (resumeIndex < 0) {
  await writeFile(join(run, 'plan.json'), JSON.stringify({ sourceId, beforePid, scope: 'new labelled fixture and its new fork only' }), { flag: 'wx' });
  const created = await call('session/create', { request: { sessionId: sourceId, cwd: packageRoot, agentPreset: 'minimal' } });
  assert.equal(created.sessionId, sourceId);
  await call('session/rename', { request: { sessionId: sourceId, title: '[reset-test] model application source fixture' } });
  await call('session/prompt', { request: { sessionId: sourceId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '这是原位交接功能的验收测试来源。硬约束：保留原会话ID；不得自动执行历史命令；只操作新建测试副本。事实：未执行真实业务任务。当前目标：验证选定模型候选能保存成一轮交接。仅回复 fixture ready，不要调用任何工具。' }] } });
}
const page = async (id: string) => {
  const projection = await call('session/projections', { request: { sessionId: id } }); assert.equal(projection.kind, 'sequenced');
  const value = await call('session/page', { request: { address: { kind: 'session', sessionId: id }, throughSeq: projection.asOfSeq, maxMessages: 200 } });
  return { cursor: projection.asOfSeq, events: value.records.map((record: any) => record.event).filter(Boolean) };
};
let source;
const sourceSnapshot = join(run, 'source-before.json');
if (existsSync(sourceSnapshot)) source = JSON.parse(await readFile(sourceSnapshot, 'utf8'));
else {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const candidate = await page(sourceId);
    const replies = candidate.events.filter((event: any) => event.type === 'assistant/message').flatMap((event: any) => event.data.message?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    if (candidate.events.some((event: any) => event.type === 'turn/end') && /fixture ready/i.test(replies)) { source = candidate; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(source, 'Source fixture did not complete; no fork or reset requested');
  await writeFile(sourceSnapshot, JSON.stringify(source), { flag: 'wx' });
}
const targetPath = join(run, 'target.json');
let target;
if (existsSync(targetPath)) target = JSON.parse(await readFile(targetPath, 'utf8'));
else {
  target = await call('session/fork', { request: { sessionId: sourceId, atSeq: source.cursor } });
  assert.ok(target.sessionId && target.sessionId !== sourceId);
  await writeFile(targetPath, JSON.stringify(target), { flag: 'wx' });
  await call('session/rename', { request: { sessionId: target.sessionId, title: '[reset-test] selected model handoff' } });
}
const completed = () => new Ledger(home).rows.find((row) => row.sessionId === target.sessionId && row.state === 'DONE')?.result as any;
if (!completed()) {
  const pending = await call('sessionReset/sessionResetRecoveryStatus', { sessionId: target.sessionId });
  assert.equal(pending.operations.length, 0, 'Recover the recorded pending transaction before resuming this drill');
  const attempt = randomUUID();
  const browser = spawnSync(process.execPath, [join(packageRoot, 'test/browser-menu.mjs'), '--execute-test-session', target.sessionId, '--use-model'], { encoding: 'utf8', timeout: 180000 });
  await writeFile(join(run, `browser-${attempt}.stdout.log`), browser.stdout ?? '', { flag: 'wx' });
  await writeFile(join(run, `browser-${attempt}.stderr.log`), browser.stderr ?? '', { flag: 'wx' });
  assert.equal(browser.status, 0, 'Real browser model selection failed; inspect retained evidence before any retry');
}
const done = completed(); assert.ok(done?.verified && done.sameId && done.handoffMode === 'model' && done.modelReportId);
const report = JSON.parse(await readFile(join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `model-${done.modelReportId}`, 'result.json'), 'utf8'));
assert.equal(report.status, 'pass'); assert.equal(report.sourceHash, done.modelSourceHash);
const after = await page(target.sessionId); assert.equal(after.events.filter((event: any) => event.type === 'turn/start').length, 1);
const handoff = after.events.find((event: any) => event.type === 'user/message')?.data.content.find((part: any) => part.type === 'text')?.text; assert.ok(handoff);
assert.deepEqual(JSON.parse(handoff.slice(handoff.indexOf('{'))), report.handoff, 'Persisted seed must exactly match the selected report');
assert.deepEqual((await page(sourceId)).events, source.events, 'Source fixture history must not be reset or rewritten');
const journal = ResetJournal.load(home, done.operationId); assert.equal(journal.phase(), 'committed');
for (const entry of journal.manifest.entries) assert.deepEqual(await fingerprint(join(journal.quarantine, 'original', entry.path)), entry.original);
const afterPid = servingDshPid(); assert.equal(afterPid, beforePid);
const receipt = join(run, `verified-${randomUUID()}.json`);
await writeFile(receipt, JSON.stringify({ sourceId, targetId: target.sessionId, operationId: done.operationId, modelReportId: done.modelReportId, sourceHash: done.modelSourceHash, beforePid, afterPid, checks: ['recorded labelled source and its fork only', 'real model preview selected explicitly', 'typed confirmation', 'exact selected seed independently read back', 'source history unchanged', 'committed transaction with preserved original fingerprints', 'DSH PID unchanged'] }, null, 2), { flag: 'wx' });
console.log(`PASS exact model candidate applied to ${target.sessionId}; evidence: ${receipt}`);
