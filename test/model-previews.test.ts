import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createModelPreviews } from '../lib/model-previews.ts';
import type { Evaluation, Questions } from '../lib/decision-model.ts';

const id = 'session-11111111-1111-1111-1111-111111111111';
const answers = (questions: Questions): Evaluation => ({ answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === 'score' ? { score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } } : { probability: key.endsWith('_superseded') ? 0.05 : 0.95 }])) });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'model-previews-'));
  const module = join(root, 'host-session-fixture.mjs');
  await writeFile(module, 'export class Session { static fromRestore(_id, events) { return { surface: { nodes: events.map((_, i) => i) }, deriveEventMessage: event => event.data }; } }');
  let text = '保留原ID；不得自动执行历史命令。', cursor = 0, disposed = 0, requests = 0;
  let connectionKey = 'private-connection-a';
  const observation = (sessionId = id) => ({ header: { id: sessionId }, cursor, inheritedEventCount: 0, events: [{ seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }], [Symbol.dispose]: () => { disposed++; } });
  const ctx = { sessionQuery: { observeSession: async (sessionId: string) => observation(sessionId) }, get: (_name: 'sessions') => ({ messageProjections: {} }) };
  const settings = { connection: async () => ({ apiBase: 'https://eval.example.test/v4/ai/evaluation-model', apiKey: 'not-a-real-secret', cacheKey: connectionKey }) };
  const models = createModelPreviews(ctx, { handoffTargetKB: 64, handoffHardCapKB: 512 }, { resolve: () => module }, settings, async (_connection, _state, questions) => { assert.ok(disposed > 0, 'Observation lease must be released before network work'); requests++; return answers(questions); }, root);
  return { root, models, observation, requests: () => requests, change: (value: string, seq = cursor + 1) => { text = value; cursor = seq; }, connect: (value: string) => { connectionKey = value; } };
}

test('cached previews preserve identity, expose no private connection, and execute without another model call', async () => {
  const f = await fixture();
  const first = await f.models.preview(id), second = await f.models.preview(id);
  assert.equal(first.reportId, second.reportId);
  assert.equal(f.requests(), 2);
  assert.doesNotMatch(JSON.stringify(first), /not-a-real-secret|private-connection-a/);
  const disk = await readFile(join(f.root, `model-${first.reportId}/result.json`), 'utf8');
  assert.doesNotMatch(disk, /not-a-real-secret|private-connection-a/);
  const seed = await f.models.handoff(id, f.observation(), { modelReportId: first.reportId, sourceHash: first.sourceHash });
  assert.deepEqual(seed, first.handoff);
  assert.equal(f.requests(), 2);
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
  assert.equal(f.requests(), 2);
});

test('the bounded in-memory cache cannot revive an evicted report from its saved JSON', async () => {
  const f = await fixture();
  const first = await f.models.preview(id);
  for (let i = 1; i <= 8; i++) { f.change(`新的约束 ${i}`); await f.models.preview(id); }
  f.change('保留原ID；不得自动执行历史命令。', 0);
  await assert.rejects(f.models.handoff(id, f.observation(), { modelReportId: first.reportId, sourceHash: first.sourceHash }), /失效/);
  assert.equal(f.requests(), 18);
});
