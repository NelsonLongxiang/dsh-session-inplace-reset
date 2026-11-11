// Explicit small, frozen semantic fixture; no business session data and no reset request.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { legacyConnection, evaluateConnection } from '../lib/decision-model.ts';
import { previewHandoff } from '../lib/handoff-eval.ts';
import type { SourceMessage } from '../lib/handoff-eval.ts';

assert.ok(process.argv.includes('--live'), 'Use --live to run the fixed fixture against the configured evaluation service');
const raw = await readFile(new URL('./continuation-fixed.json', import.meta.url), 'utf8');
const fixture = JSON.parse(raw) as { id: string; goal: string; messages: SourceMessage[]; requiredQuotes: string[]; expectedOpenTaskSeqs: number[] };
const directory = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `continuation-${randomUUID()}`);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'fixture.json'), raw, { flag: 'wx' });
const connection = await legacyConnection();
const report = await previewHandoff({ sessionId: 'session-11111111-1111-1111-1111-111111111111', cursor: fixture.messages.at(-1)!.seq, messages: fixture.messages }, (state, questions) => evaluateConnection(connection, state, questions), { continuationGoal: fixture.goal });
const text = report.selected.map((row) => row.text).join('\n');
const missing = fixture.requiredQuotes.filter((quote) => !text.includes(quote));
const taskStates = fixture.expectedOpenTaskSeqs.map((seq) => ({ seq, entries: report.continuation?.entries.filter((entry) => entry.candidate.seq === seq && entry.kinds.includes('task')).map((entry) => ({ id: entry.candidate.id, resolution: entry.resolved?.outcome, probability: entry.resolved?.probability })) ?? [] }));
const result = { kind: 'fixed-multitopic-continuation-fixture', fixtureId: fixture.id, fixtureSha256: createHash('sha256').update(raw).digest('hex'), noTuningDuringRun: true, report, missing, taskStates, retainedAllRequiredQuotes: missing.length === 0, openTasksNotClaimedClosed: taskStates.every((task) => task.entries.length > 0 && task.entries.every((entry) => entry.resolution !== 'pass')), independentHumanReview: 'NOT_RUN', businessSessionsRead: false, resetRequested: false };
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, coverage: report.coverage, requests: report.requestCount, retainedAllRequiredQuotes: result.retainedAllRequiredQuotes, openTasksNotClaimedClosed: result.openTasksNotClaimedClosed, note: report.note, evidence: directory }));
if (report.status === 'unavailable' || !result.retainedAllRequiredQuotes || !result.openTasksNotClaimedClosed) process.exitCode = 1;
