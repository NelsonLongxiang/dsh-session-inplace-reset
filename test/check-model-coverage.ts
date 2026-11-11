// Read-only live coverage check: explicit labelled test source, bounded model requests, no reset endpoint.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectDsh } from './dsh-client.ts';
import { MAX_BATCHES, MAX_EVALUATION_CALLS } from '../lib/handoff-batches.ts';
import { testSourceSession } from './runtime.ts';
assert.ok(process.argv.includes('--live'), 'Pass --live for a real decision-model evaluation');
const sessionOption = process.argv.indexOf('--session');
const sessionId = sessionOption < 0 ? testSourceSession : process.argv[sessionOption + 1];
assert.match(sessionId ?? '', /^session-[0-9a-f-]{36}$/i);
assert.equal(sessionId, testSourceSession, 'Only the explicitly configured test source is permitted');
const call = await connectDsh(360000);
const before = await call('sessionReset/sessionResetDryRun', { sessionId });
const report = await call('sessionReset/sessionResetModelPreview', { sessionId });
assert.equal(report.sessionId, sessionId);
assert.ok(report.batchCount >= 1 && report.batchCount <= MAX_BATCHES && report.requestCount <= MAX_EVALUATION_CALLS);
assert.ok(report.coverage.assessed > 32, 'Use a genuine longer test source');
const after = await call('sessionReset/sessionResetDryRun', { sessionId });
assert.deepEqual(after, before, 'Read-only preview changed source state');
let baseline;
const baselineOption = process.argv.indexOf('--baseline');
if (baselineOption >= 0) {
  const previous = JSON.parse(await readFile(process.argv[baselineOption + 1], 'utf8'));
  assert.equal(previous.sourceHash, report.sourceHash, 'Coverage comparison requires the same complete source digest');
  baseline = { reportId: previous.reportId, assessed: previous.coverage.assessed, total: previous.coverage.total };
  assert.ok(report.coverage.assessed > baseline.assessed);
}
const directory = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `coverage-${randomUUID()}`);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'result.json'), JSON.stringify({ sessionId, reportId: report.reportId, sourceHash: report.sourceHash, baseline, coverage: report.coverage, batches: report.batchCount, requests: report.requestCount, qualityStatus: report.status, note: report.note, auditErrors: report.auditAttempts?.flatMap((attempt: any) => (attempt.batches ?? []).filter((batch: any) => batch.error)), checks: report.checks, sourceUnchanged: true, resetRequested: false, independentHumanQualityReview: 'NOT_RUN' }, null, 2), { flag: 'wx' });
console.log(`PASS read-only coverage ${report.coverage.assessed}/${report.coverage.total}, ${report.batchCount} batches, ${report.requestCount} requests, quality ${report.status}; evidence: ${directory}`);
