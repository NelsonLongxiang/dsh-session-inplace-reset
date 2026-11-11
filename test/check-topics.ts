// Explicit read-only native-model topic check; never prompts the Agent or resets its source.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connectDsh } from './dsh-client.ts';

assert.ok(process.argv.includes('--live'), 'Use --live for a real session-model call');
const index = process.argv.indexOf('--session');
const sessionId = process.argv[index + 1];
assert.ok(index >= 0 && /^session-[a-f0-9-]{36}$/.test(sessionId), 'Provide the explicitly authorized source with --session');
const directory = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `topic-live-${randomUUID()}`);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'request.json'), JSON.stringify({ sessionId, readOnly: true, createdAt: new Date().toISOString() }), { flag: 'wx' });
const call = await connectDsh();
const before = await call('session/projections', { request: { sessionId } });
const expected = before.values?.modelSelection?.next;
let task = await call('sessionReset/sessionResetTopicPreviewStart', { sessionId });
await writeFile(join(directory, 'task.json'), JSON.stringify({ taskId: task.taskId, sessionId, model: task.model, modelSource: task.modelSource }), { flag: 'wx' });
const deadline = Date.now() + 180000;
while (task.running && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  task = await call('sessionReset/sessionResetTopicPreviewStatus', { request: { sessionId, taskId: task.taskId } });
  if (task.error) break;
}
await writeFile(join(directory, 'result.json'), JSON.stringify(task, null, 2), { flag: 'wx' });
assert.equal(task.running, false, 'Topic task did not finish in the bounded observation window');
assert.equal(task.error, undefined, task.error);
assert.equal(task.report?.status, 'ready', task.report?.note);
assert.ok(task.report.topics.length > 0, 'A nonempty labelled test source should offer a topic');
if (expected) {
  assert.equal(task.report.model.provider, expected.provider);
  assert.equal(task.report.model.model, expected.model);
  if (expected.reasoningEffort !== undefined) assert.equal(task.report.model.reasoningEffort, expected.reasoningEffort);
}
const after = await call('session/projections', { request: { sessionId } });
assert.deepEqual(after, before, 'Source projections changed during auxiliary topic analysis');
await writeFile(join(directory, 'verified.json'), JSON.stringify({ sessionId, model: task.report.model, modelSource: task.report.modelSource, requests: task.report.requests, topics: task.report.topics.map((topic: any) => ({ title: topic.title, goal: topic.goal, evidenceCount: topic.evidence.length })), sourceUnchanged: true, sourceAgentPrompted: false, resetRequested: false, realModelUsed: true }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ status: 'verified', model: task.report.model, topics: task.report.topics.length, requests: task.report.requests, sourceUnchanged: true, evidence: directory }));
