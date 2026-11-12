import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTopicPreviews } from '../lib/topic-previews.ts';
import type { TopicLlm } from '../lib/topic-analysis.ts';
import type { SessionModelSelection } from '../lib/session-model.ts';

const id = 'session-11111111-1111-1111-1111-111111111111';
async function fixture(hold = false) {
  const root = await mkdtemp(join(tmpdir(), 'session-topics-'));
  const module = join(root, 'session-fixture.mjs');
  await writeFile(module, 'export class Session { static fromRestore(_id, events) { return { surface: { nodes: [0] }, deriveEventMessage: event => event.data }; } }');
  const events = [{ seq: 0, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续开发上下文重置插件，保留原ID。' }] } }];
  let cursor = 0, disposed = 0, calls = 0;
  let selected: SessionModelSelection = { provider: 'actual-session-provider', model: 'actual-session-model', reasoningEffort: 'high' };
  const gate = Promise.withResolvers<void>();
  const llm: TopicLlm = { prepareCall: async (selection) => {
    assert.ok(disposed > 0, 'The observation lease must be released before network analysis');
    assert.deepEqual(selection, selected);
    return { config: { ...selection }, stream: async function* (options: any) {
      calls++;
      if (hold) await Promise.race([gate.promise, new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))]);
      options.signal.throwIfAborted();
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ topics: [{ title: '上下文重置插件', goal: '继续开发上下文重置插件并核对剩余工作', evidence: [{ id: 'c0', quote: '继续开发上下文重置插件' }] }] }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } };
  const observeSession = async (sessionId: string) => ({ header: { id: sessionId }, cursor, inheritedEventCount: 0, events, projections: { asOfSeq: cursor, values: { modelSelection: { next: { ...selected } } } }, [Symbol.dispose]: () => { disposed++; } });
  const ctx = { sessionQuery: { observeSession }, get(name: string) {
    if (name === 'sessions') return { messageProjections: {} };
    if (name === 'llm') return llm;
    if (name === 'agentDefaultModel') return { currentSelection: () => { assert.fail('An explicit session selection must not read a different default'); } };
    assert.fail(`Unexpected service: ${name}`);
  } };
  const topics = createTopicPreviews(ctx, { resolve: () => module }, root);
  return { root, topics, gate, events, calls: () => calls, changeModel: () => { selected = { provider: 'new-session-provider', model: 'new-session-model' }; }, changeSource: () => { cursor++; } };
}
async function finished(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
  let view = await f.topics.status({ sessionId: id, taskId });
  for (let i = 0; i < 1000 && view.running; i++) { await new Promise((resolve) => setTimeout(resolve, 2)); view = await f.topics.status({ sessionId: id, taskId }); }
  assert.equal(view.running, false);
  return view;
}

test('topic tasks reuse the session selection, remain read-only and deduplicate unchanged analysis', async () => {
  const f = await fixture(), original = JSON.stringify(f.events);
  const first = await f.topics.start(id);
  const view = await finished(f, first.taskId);
  assert.equal(view.report!.status, 'ready');
  assert.equal(view.report!.model.provider, 'actual-session-provider');
  assert.equal(view.report!.model.model, 'actual-session-model');
  assert.equal(view.report!.model.reasoningEffort, 'high');
  assert.equal(f.calls(), 1);
  assert.equal((await f.topics.start(id)).taskId, first.taskId);
  view.report!.topics[0].goal = 'caller mutation';
  assert.notEqual((await f.topics.status({ sessionId: id, taskId: first.taskId })).report!.topics[0].goal, 'caller mutation');
  await assert.rejects(f.topics.status({ sessionId: 'session-22222222-2222-2222-2222-222222222222', taskId: first.taskId }), /失效|不属于/);
  assert.equal(JSON.stringify(f.events), original);
  await f.topics.dispose();
});

test('switching models or editing the source invalidates old candidates before adoption', async () => {
  for (const change of ['model', 'source']) {
    const f = await fixture();
    const first = await f.topics.start(id); await finished(f, first.taskId);
    if (change === 'model') f.changeModel(); else f.changeSource();
    const stale = await f.topics.status({ sessionId: id, taskId: first.taskId });
    assert.match(stale.error!, /会话内容或模型已变化/);
    const next = await f.topics.start(id);
    assert.notEqual(next.taskId, first.taskId);
    await finished(f, next.taskId);
    assert.equal(f.calls(), 2);
    await f.topics.dispose();
  }
});

test('reset invalidation removes the target topic report and drains only its matching stream', async () => {
  const f = await fixture();
  const first = await f.topics.start(id); await finished(f, first.taskId);
  await f.topics.invalidateSession(id);
  await assert.rejects(f.topics.status({ sessionId: id, taskId: first.taskId }), /失效/);
  await f.topics.dispose();
  const held = await fixture(true);
  const running = await held.topics.start(id);
  for (let i = 0; i < 1000 && held.calls() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  await held.topics.invalidateSession(id);
  assert.equal(held.calls(), 1);
  await assert.rejects(held.topics.status({ sessionId: id, taskId: running.taskId }), /失效/);
  await held.topics.dispose();
});

test('adapter changes abort pending topic work and unloading drains its owned calls', async () => {
  const f = await fixture(true);
  const first = await f.topics.start(id);
  for (let i = 0; i < 1000 && f.calls() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(f.calls(), 1);
  f.topics.clear();
  await assert.rejects(f.topics.status({ sessionId: id, taskId: first.taskId }), /失效/);
  await f.topics.dispose();
  await assert.rejects(f.topics.start(id), /正在停止/);
  assert.equal(f.calls(), 1);
});
