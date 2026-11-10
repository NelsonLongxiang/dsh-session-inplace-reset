import assert from 'node:assert/strict';
import test from 'node:test';
import { candidatesFrom, outcome, previewHandoff, redact, sourceDigest } from '../lib/handoff-eval.ts';
import type { SourceMessage, SourceSnapshot } from '../lib/handoff-eval.ts';
import type { Questions, Evaluation } from '../lib/decision-model.ts';

const message = (seq: number, role: string, text: string): SourceMessage => ({ seq, role, sourceKind: role === 'assistant' ? 'model' : role, text });
const source = (messages: SourceMessage[]): SourceSnapshot => ({ sessionId: 'session-11111111-1111-1111-1111-111111111111', cursor: 99, messages });
const answer = (questions: Questions, { pending = false, audit = 0.95 } = {}): Evaluation => ({ answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === 'score' ? { score: pending ? 1.5 : 2.8, probabilities: pending ? { 0: 0, 1: 0.5, 2: 0.5, 3: 0 } : { 0: 0, 1: 0, 2: 0.2, 3: 0.8 } } : { probability: key.endsWith('_superseded') ? 0.05 : audit }])) });

test('probability boundaries use pending and reject invalid values', () => {
  assert.equal(outcome(0.4), 'fail');
  assert.equal(outcome(0.7), 'pass');
  assert.equal(outcome(0.5), 'pending');
  for (const value of [NaN, undefined, -0.1, 1.1]) assert.throws(() => outcome(value));
});

test('source digest changes with the captured generation and historical authority', () => {
  const original = source([message(0, 'user', '保留原ID')]);
  assert.notEqual(sourceDigest(original), sourceDigest({ ...original, cursor: 100 }));
  assert.notEqual(sourceDigest(original), sourceDigest({ ...original, messages: [{ ...original.messages[0], historical: true }] }));
});

test('nested handoffs unfold as historical quotes with source order intact', () => {
  const inner = { kind: 'handoff-seed', recent_messages: [{ role: 'user', text: '保留原ID' }, { role: 'assistant', text: '仅测试通过' }] };
  const text = `[原地重置生成的历史交接记录，并非新任务]\n完整历史备份：test\n${JSON.stringify(inner)}`;
  const { candidates, coverage } = candidatesFrom([message(5, 'user', text)]);
  assert.equal(coverage.complete, true);
  assert.deepEqual(candidates.map((item) => item.text), ['保留原ID', '仅测试通过']);
  assert.ok(candidates.every((item) => item.historical && item.seq === 5));
});

test('long-message tails remain eligible and incomplete sampling is explicit', () => {
  const text = '头'.repeat(9000) + '尾部重要约束：不能重启';
  const { candidates, coverage } = candidatesFrom([message(0, 'user', text)], { maxCandidates: 2 });
  assert.match(candidates.at(-1)!.text, /不能重启$/);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.assessed, 2);
  assert.ok(coverage.total > 2);
});

test('input budget reserves the tail before older large chunks consume it', () => {
  const { candidates, coverage } = candidatesFrom([message(0, 'user', '字'.repeat(9000) + '最新约束：不要重启')], { maxCandidates: 4, maxInputBytes: 4200 });
  assert.ok(candidates.some((item) => item.text.endsWith('最新约束：不要重启')));
  assert.ok(coverage.inputBytes <= 4200);
  assert.equal(coverage.complete, false);
});

test('common credentials are masked before model calls', async () => {
  const secret = 'vck_abcdefghijklmnopqrstuvwxyz';
  assert.doesNotMatch(redact(`"password": "a-secret-value" Authorization: Bearer abc123 token=${secret}`), /a-secret-value|abc123|vck_/);
  await previewHandoff(source([message(0, 'user', `api_key=${secret}`)]), async (state, questions) => {
    assert.doesNotMatch(JSON.stringify(state), /vck_/);
    return answer(questions);
  });
});

test('selection is extractive, audited against all supplied candidates, and cannot apply a reset', async () => {
  const snapshot = source([message(1, 'user', '不能重启'), message(3, 'assistant', '测试通过但原会话未执行')]);
  const original = JSON.stringify(snapshot);
  let calls = 0;
  const result = await previewHandoff(snapshot, async (state, questions) => {
    calls++;
    if (calls === 2) {
      const cut = state as { candidates: unknown[]; candidate_handoff: { selected_messages: unknown[] } };
      assert.equal(cut.candidates.length, 2);
      assert.equal(cut.candidate_handoff.selected_messages.length, 2);
    }
    return answer(questions);
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'pass');
  assert.equal(result.applied, false);
  assert.equal(result.mode, 'shadow');
  assert.deepEqual(result.selected.map((item) => item.text), snapshot.messages.map((item) => item.text));
  assert.equal(JSON.stringify(snapshot), original);
});

test('pending selections are retained without labelling the package approved', async () => {
  let count = 0;
  const result = await previewHandoff(source([message(0, 'user', '疑义应保留原文')]), async (_state, questions) => answer(questions, { pending: ++count === 1 }));
  assert.equal(result.status, 'pending');
  assert.equal(result.selected.length, 1);
});

test('offline and malformed responses never count as verified', async () => {
  for (const reply of [{ error: 'offline' }, { answers: {} }, { answers: { c0_importance: { score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1, extra: 2 } } } }]) {
    const result = await previewHandoff(source([message(0, 'user', '必须保留')]), async () => reply);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.applied, false);
  }
});

test('an audit failure outweighs positive selection scores', async () => {
  const result = await previewHandoff(source([message(0, 'user', '必须保留')]), async (_state, questions) => answer(questions, { audit: 0.1 }));
  assert.equal(result.status, 'fail');
});

test('partial coverage cannot pass even when every model answer is positive', async () => {
  const result = await previewHandoff(source([message(0, 'user', '字'.repeat(5000))]), async (_state, questions) => answer(questions), { maxCandidates: 2 });
  assert.equal(result.status, 'pending');
  assert.equal(result.coverage.complete, false);
});

test('UTF-8 budget is enforced and important omissions remain visible', async () => {
  const result = await previewHandoff(source([message(0, 'user', '中文'.repeat(400))]), async (_state, questions) => answer(questions), { targetBytes: 1024 });
  assert.equal(result.status, 'pending');
  assert.ok(typeof result.size === 'number' && result.size <= 1024);
  assert.equal(result.budgetOmissions, 1);
});
