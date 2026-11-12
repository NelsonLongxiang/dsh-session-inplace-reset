import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTopics } from '../lib/topic-analysis.ts';
import type { TopicLlm, TopicProgress } from '../lib/topic-analysis.ts';
import type { SourceSnapshot } from '../lib/handoff-eval.ts';

const selection = { provider: 'session-provider', model: 'configured-model', reasoningEffort: 'high' };
const source = (count = 1): SourceSnapshot => ({ sessionId: 'session-11111111-1111-1111-1111-111111111111', cursor: count, messages: Array.from({ length: count }, (_, seq) => ({ seq, role: 'user', sourceKind: 'user', text: `任务${seq}：继续开发上下文重置插件，保留原ID。` })) });
const topic = (id = 'c0') => ({ title: '上下文重置插件', goal: '继续开发上下文重置插件并核对剩余工作', evidenceIds: [id] });
function model(output: (input: any) => unknown, finish = 'stop'): { llm: TopicLlm; calls: object[] } {
  const calls: object[] = [];
  const llm: TopicLlm = { prepareCall: async (config) => {
    assert.deepEqual(config, selection);
    return { config: { ...config, maxTokens: 8192 }, stream: async function* (options: any) {
      calls.push(options);
      assert.equal(options.provider, selection.provider); assert.equal(options.model, selection.model); assert.equal(options.reasoningEffort, selection.reasoningEffort);
      assert.deepEqual(options.tools, []);
      assert.equal(options.sessionId, undefined, 'Auxiliary calls cannot write or drive the original session');
      const text = JSON.stringify(output(JSON.parse(options.messages[0].content[0].text)));
      yield { type: 'reasoning-delta', index: 9, text: 'private reasoning must not be returned' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: finish } };
    } };
  } };
  return { llm, calls };
}

test('session-model topics retain exact evidence, ignore reasoning and do not duplicate final text blocks', async () => {
  const f = model(() => ({ topics: [topic()] }));
  const snapshot = source(), original = JSON.stringify(snapshot);
  const report = await analyzeTopics(snapshot, 'a'.repeat(64), { selection, source: 'session' }, f.llm, new AbortController().signal, () => {});
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.model, selection);
  assert.equal(report.topics[0].evidence[0].seq, 0);
  assert.equal(report.topics[0].evidence[0].quote, snapshot.messages[0].text);
  assert.equal(report.requests, 1);
  assert.doesNotMatch(JSON.stringify(report), /private reasoning/);
  assert.equal(JSON.stringify(snapshot), original);
});

test('fabricated evidence, incomplete generations and an unexpected route cannot produce candidates', async () => {
  for (const output of [() => ({ topics: [topic('c999')] }), () => ({ topics: [{ ...topic(), evidenceIds: ['c0', 'c0'] }] }), () => ({ topics: [{ ...topic(), goal: '' }] })]) {
    const f = model(output);
    const report = await analyzeTopics(source(), 'a'.repeat(64), { selection, source: 'session' }, f.llm, new AbortController().signal, () => {});
    assert.equal(report.status, 'unavailable'); assert.equal(report.topics.length, 0);
  }
  const truncated = model(() => ({ topics: [topic()] }), 'max-tokens');
  assert.equal((await analyzeTopics(source(), 'a'.repeat(64), { selection, source: 'session' }, truncated.llm, new AbortController().signal, () => {})).status, 'unavailable');
  const wrong: TopicLlm = { prepareCall: async () => ({ config: { provider: 'other', model: 'other' }, stream: async function* () { assert.fail('Must reject before dispatching another model'); } }) };
  assert.equal((await analyzeTopics(source(), 'a'.repeat(64), { selection, source: 'session' }, wrong, new AbortController().signal, () => {})).status, 'unavailable');
});

test('topic generation never executes a tool call or exposes raw provider failures', async () => {
  for (const chunk of [{ type: 'tool-call-delta', index: 0, name: 'shell' }, { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'secret-api-key' } } }]) {
    const llm: TopicLlm = { prepareCall: async () => ({ config: selection, stream: async function* () { yield chunk; } }) };
    const result = await analyzeTopics(source(), 'a'.repeat(64), { selection, source: 'session' }, llm, new AbortController().signal, () => {});
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.topics, []); assert.doesNotMatch(JSON.stringify(result), /secret-api-key|shell/);
  }
});

test('failed output diagnostics contain only redacted visible text and a safe code', async () => {
  const f = model(() => ({ topics: [{ ...topic('c999'), goal: 'api_key=vck_abcdefghijklmnopqrstuvwxyz' }] }));
  const diagnostics: { code: string; output?: string }[] = [];
  const result = await analyzeTopics(source(), 'a'.repeat(64), { selection, source: 'session' }, f.llm, new AbortController().signal, () => {}, async (value) => { diagnostics.push(value); });
  assert.equal(result.errorCode, 'UNVERIFIED_EVIDENCE');
  assert.equal(diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /vck_|private reasoning/);
  assert.doesNotMatch(JSON.stringify(result), /vck_/);
});

test('the server resolves evidence text from valid IDs and never displays a generated misquote', async () => {
  const f = model(() => ({ topics: [{ title: '引用可靠性', goal: '继续核对引用可靠性', evidence: [{ id: 'c0', quote: '模型改写或漏了标点的错误引文' }] }] }));
  const snapshot = source();
  const report = await analyzeTopics(snapshot, 'a'.repeat(64), { selection, source: 'session' }, f.llm, new AbortController().signal, () => {});
  assert.equal(report.status, 'ready');
  assert.equal(report.topics[0].evidence[0].quote, snapshot.messages[0].text);
  assert.doesNotMatch(JSON.stringify(report), /模型改写或漏了标点/);
});

test('source snippets are bounded by Unicode code points without splitting a surrogate pair', async () => {
  const snapshot = source(); snapshot.messages[0].text = '中'.repeat(159) + '😀' + '后续原文';
  const f = model(() => ({ topics: [topic()] }));
  const report = await analyzeTopics(snapshot, 'a'.repeat(64), { selection, source: 'session' }, f.llm, new AbortController().signal, () => {});
  assert.equal(report.status, 'ready');
  const evidence = report.topics[0].evidence[0];
  assert.equal(Array.from(evidence.quote).length, 160);
  assert.ok(evidence.quote.endsWith('😀'));
  assert.equal(evidence.truncated, true);
  assert.ok(snapshot.messages[0].text.startsWith(evidence.quote));
});

test('long intent histories map in parallel and reduce only already-grounded evidence', async () => {
  const calls: string[] = [], updates: TopicProgress[] = [];
  let active = 0, peak = 0;
  const llm: TopicLlm = { prepareCall: async () => ({ config: selection, stream: async function* (options: any) {
    active++; peak = Math.max(peak, active);
    const input = JSON.parse(options.messages[0].content[0].text);
    calls.push(input.proposals ? 'reduce' : 'map');
    await new Promise((resolve) => setTimeout(resolve, 4));
    const topics = input.proposals ? [input.proposals[0]] : [topic(input.candidates[0].id)];
    const text = JSON.stringify({ topics });
    active--;
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }) };
  const report = await analyzeTopics(source(180), 'a'.repeat(64), { selection, source: 'session' }, llm, new AbortController().signal, (value) => updates.push(value));
  assert.equal(report.status, 'ready'); assert.equal(report.coverage.complete, true);
  assert.equal(peak, 4); assert.equal(active, 0); assert.ok(calls.includes('reduce'));
  assert.ok(updates.some((value) => value.phase === 'merging'));
  assert.equal(report.topics.length, 1);
  assert.equal(updates.at(-1)!.running, 0);
});

test('topic material covers user intent and recent answers without importing unrelated tool or context logs', async () => {
  const snapshot = source();
  snapshot.messages.push({ seq: 2, role: 'tool', sourceKind: 'tool', text: 'UNRELATED_TOOL_LOG' }, { seq: 3, role: 'user', sourceKind: 'instructions', text: 'UNRELATED_CONTEXT_CATALOG' });
  const f = model((input) => { assert.doesNotMatch(JSON.stringify(input), /UNRELATED/); return { topics: [topic()] }; });
  const report = await analyzeTopics(snapshot, 'a'.repeat(64), { selection, source: 'session' }, f.llm, new AbortController().signal, () => {});
  assert.equal(report.status, 'ready'); assert.equal(report.coverage.materialMessages, 1); assert.equal(report.coverage.sourceMessages, 3);
});
