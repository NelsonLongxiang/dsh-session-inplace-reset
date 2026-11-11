import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createModelPreviews } from '../lib/model-previews.ts';
import type { Evaluation, Questions } from '../lib/decision-model.ts';

const id = 'session-11111111-1111-1111-1111-111111111111';
const answers = (questions: Questions): Evaluation => ({ answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === 'score' ? { score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } } : { probability: key.startsWith('context_') || key.startsWith('resolve_') || key.endsWith('_superseded') ? 0.05 : 0.95 }])) });
async function fixture(evaluate?: (state: unknown, questions: Questions) => Promise<Evaluation>) {
  const root = await mkdtemp(join(tmpdir(), 'model-previews-'));
  const module = join(root, 'host-session-fixture.mjs');
  await writeFile(module, 'export class Session { static fromRestore(_id, events) { return { surface: { nodes: events.map((_, i) => i) }, deriveEventMessage: event => event.data }; } }');
  let text = '保留原ID；不得自动执行历史命令。', cursor = 0, disposed = 0, requests = 0;
  let connectionKey = 'private-connection-a';
  const observation = (sessionId = id) => ({ header: { id: sessionId }, cursor, inheritedEventCount: 0, events: [{ seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }], [Symbol.dispose]: () => { disposed++; } });
  const ctx = { sessionQuery: { observeSession: async (sessionId: string) => observation(sessionId) }, get: (_name: 'sessions') => ({ messageProjections: {} }) };
  const settings = { connection: async () => ({ apiBase: 'https://eval.example.test/v4/ai/evaluation-model', apiKey: 'not-a-real-secret', cacheKey: connectionKey }) };
  const models = createModelPreviews(ctx, { handoffTargetKB: 64, handoffHardCapKB: 512 }, { resolve: () => module }, settings, async (_connection, state, questions) => { assert.ok(disposed > 0, 'Observation lease must be released before network work'); requests++; return evaluate ? evaluate(state, questions) : answers(questions); }, root);
  return { root, models, observation, requests: () => requests, change: (value: string, seq = cursor + 1) => { text = value; cursor = seq; }, connect: (value: string) => { connectionKey = value; } };
}

test('cached previews preserve identity, expose no private connection, and execute without another model call', async () => {
  const f = await fixture();
  const first = await f.models.preview(id), second = await f.models.preview(id);
  assert.equal(first.reportId, second.reportId);
  assert.equal(f.requests(), 3);
  assert.doesNotMatch(JSON.stringify(first), /not-a-real-secret|private-connection-a/);
  const disk = await readFile(join(f.root, `model-${first.reportId}/result.json`), 'utf8');
  assert.doesNotMatch(disk, /not-a-real-secret|private-connection-a/);
  const seed = await f.models.handoff(id, f.observation(), { modelReportId: first.reportId, sourceHash: first.sourceHash });
  assert.deepEqual(seed, first.handoff);
  assert.equal(f.requests(), 3);
});

test('explicit goals isolate cached tasks and changing the goal invalidates the selected handoff', async () => {
  const f = await fixture();
  const first = await f.models.start(id, '继续任务A');
  let a = first;
  for (let i = 0; a.running && i < 1000; i++) { await new Promise((resolve) => setTimeout(resolve, 2)); a = f.models.status({ sessionId: id, taskId: first.taskId }); }
  assert.equal(a.running, false);
  const second = await f.models.start(id, '继续任务B');
  let b = second;
  for (let i = 0; b.running && i < 1000; i++) { await new Promise((resolve) => setTimeout(resolve, 2)); b = f.models.status({ sessionId: id, taskId: second.taskId }); }
  assert.equal(b.running, false);
  assert.notEqual(a.taskId, b.taskId);
  assert.equal(a.report!.sourceHash, b.report!.sourceHash);
  assert.equal(a.report!.continuation!.goal, '继续任务A');
  assert.equal((await f.models.start(id, '继续任务A')).taskId, a.taskId);
  const choice = { modelReportId: a.report!.reportId, sourceHash: a.report!.sourceHash, continuationGoal: '继续任务A' };
  await f.models.handoff(id, f.observation(), choice);
  await assert.rejects(f.models.handoff(id, f.observation(), { ...choice, continuationGoal: '继续任务B' }));
  await assert.rejects(f.models.handoff(id, f.observation(), { modelReportId: choice.modelReportId, sourceHash: choice.sourceHash }));
  assert.equal(f.requests(), 6);
});

test('source changes, connection changes and cache clearing refuse an old report without re-evaluating', async () => {
  const f = await fixture();
  const report = await f.models.preview(id);
  const choice = { modelReportId: report.reportId, sourceHash: report.sourceHash };
  f.change('任务已更改');
  await assert.rejects(f.models.handoff(id, f.observation(), choice), /失效/);
  f.change('保留原ID；不得自动执行历史命令。', 0);
  f.connect('private-connection-b');
  await assert.rejects(f.models.handoff(id, f.observation(), choice), /失效/);
  f.connect('private-connection-a');
  f.models.clear();
  await assert.rejects(f.models.handoff(id, f.observation(), choice), /失效/);
  assert.equal(f.requests(), 3);
});

test('start and polling share one live task and expose safe, isolated progress before completion', async () => {
  const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const f = await fixture(async (_state, questions) => {
    const gate = Promise.withResolvers<void>(); gates.push(gate);
    await gate.promise;
    return answers(questions);
  });
  f.change('新的用户约束。'.repeat(8000));
  const first = await f.models.start(id), second = await f.models.start(id);
  assert.equal(first.taskId, second.taskId);
  assert.equal(first.running, true);
  assert.equal(first.progress.phase, 'inventory');
  assert.equal(first.progress.running, 4);
  assert.equal(first.progress.completedBatches, 0);
  assert.equal(f.requests(), 4);
  assert.doesNotMatch(JSON.stringify(first), /not-a-real-secret|private-connection-a|新的用户约束/);
  first.progress.running = 99;
  assert.equal(f.models.status({ sessionId: id, taskId: first.taskId }).progress.running, 4);
  assert.throws(() => f.models.status({ sessionId: 'session-22222222-2222-2222-2222-222222222222', taskId: first.taskId }), /失效|属于/);
  assert.throws(() => f.models.status({ sessionId: id, taskId: '../invalid' }));
  let done = false;
  const pending = f.models.preview(id).then((report) => { done = true; return report; });
  for (let i = 0; i < 1000 && !done; i++) {
    gates.splice(0).forEach((gate) => gate.resolve());
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(done, true);
  const report = await pending;
  const finished = f.models.status({ sessionId: id, taskId: first.taskId });
  assert.equal(finished.running, false);
  assert.equal(finished.progress.running, 0);
  assert.equal(finished.progress.phase, 'complete');
  assert.equal(finished.report!.reportId, report.reportId);
  assert.equal(report.peakConcurrency, 4);
  f.models.clear();
  assert.throws(() => f.models.status({ sessionId: id, taskId: first.taskId }), /失效/);
});

test('an unavailable task remains observable but an explicit retry creates a fresh task', async () => {
  let offline = true;
  const f = await fixture(async (_state, questions) => offline ? { error: 'offline' } : answers(questions));
  const task = await f.models.start(id);
  const failed = await f.models.preview(id);
  assert.equal(f.models.status({ sessionId: id, taskId: task.taskId }).report!.status, 'unavailable');
  assert.equal(failed.status, 'unavailable');
  offline = false;
  const retry = await f.models.start(id);
  assert.notEqual(retry.taskId, task.taskId);
  assert.equal((await f.models.preview(id)).status, 'pass');
});

test('running tasks survive cache eviction and reopening does not start duplicate evaluation', async () => {
  const gate = Promise.withResolvers<void>();
  let firstRequest = true;
  const f = await fixture(async (_state, questions) => {
    if (firstRequest) { firstRequest = false; await gate.promise; }
    return answers(questions);
  });
  const task = await f.models.start(id);
  for (let i = 1; i <= 8; i++) { f.change(`独立的新约束${i}`); await f.models.preview(id); }
  f.change('保留原ID；不得自动执行历史命令。', 0);
  assert.equal((await f.models.start(id)).taskId, task.taskId);
  assert.equal(f.requests(), 25);
  gate.resolve();
  assert.equal((await f.models.preview(id)).status, 'pass');
  assert.equal(f.requests(), 27);
});

test('unloading drains requests even after clearing cache and schedules no new provider work', async () => {
  const gate = Promise.withResolvers<void>();
  const f = await fixture(async (_state, questions) => { await gate.promise; return answers(questions); });
  await f.models.start(id);
  assert.equal(f.requests(), 1);
  f.models.clear();
  let disposed = false;
  const pending = f.models.dispose().then(() => { disposed = true; });
  await assert.rejects(f.models.start(id), /正在停止/);
  assert.equal(disposed, false);
  gate.resolve();
  await pending;
  assert.equal(disposed, true);
  assert.equal(f.requests(), 1);
});

test('the bounded in-memory cache cannot revive an evicted report from its saved JSON', async () => {
  const f = await fixture();
  const first = await f.models.preview(id);
  for (let i = 1; i <= 8; i++) { f.change(`新的约束 ${i}`); await f.models.preview(id); }
  f.change('保留原ID；不得自动执行历史命令。', 0);
  await assert.rejects(f.models.handoff(id, f.observation(), { modelReportId: first.reportId, sourceHash: first.sourceHash }), /失效/);
  assert.equal(f.requests(), 27);
});
