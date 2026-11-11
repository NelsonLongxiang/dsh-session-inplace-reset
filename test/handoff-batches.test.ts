import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateBatches, MAX_BATCHES, MAX_BATCH_CANDIDATES, MAX_BATCH_BYTES, MAX_EVALUATION_CALLS } from '../lib/handoff-batches.ts';
import { candidatesFrom, previewHandoff } from '../lib/handoff-eval.ts';
import type { Candidate, SourceSnapshot } from '../lib/handoff-eval.ts';
import type { Evaluation, Questions } from '../lib/decision-model.ts';
const snapshot = (count: number, text = '保留此阶段有效状态') => ({ sessionId: 'session-11111111-1111-1111-1111-111111111111', cursor: count - 1, messages: Array.from({ length: count }, (_, seq) => ({ seq, role: 'user', sourceKind: 'user', text: `来源 ${seq}：${text}` })) } as SourceSnapshot);
const answers = (questions: Questions, probability = 0.95): Evaluation => ({ answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === 'score' ? { score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } } : { probability: key.endsWith('_superseded') ? 0.05 : probability }])) });

test('89 source messages are scored exactly once with bounded contexts and source anchors', () => {
  const source = snapshot(89);
  const candidates = candidatesFrom(source.messages).candidates;
  const batches = candidateBatches(candidates);
  assert.ok(batches.length > 1 && batches.length <= MAX_BATCHES);
  assert.equal(new Set(batches.flatMap((batch) => batch.candidates.map((row) => row.id))).size, 89);
  assert.equal(batches.reduce((sum, batch) => sum + batch.candidates.length, 0), 89);
  for (const batch of batches) {
    assert.ok(batch.context.length <= MAX_BATCH_CANDIDATES);
    assert.ok(Buffer.byteLength(JSON.stringify(batch.context)) <= MAX_BATCH_BYTES);
    assert.ok(batch.context.some((row) => row.seq === 0));
    assert.ok(batch.context.some((row) => row.seq === 88));
  }
});

test('every batch is audited and the lowest batch result is displayed without inventing a global probability', async () => {
  const seen = new Set<string>();
  let audit = 0;
  const report = await previewHandoff(snapshot(89), async (state, questions) => {
    for (const key of Object.keys(questions).filter((key) => key.endsWith('_importance'))) {
      const id = key.replace('_importance', ''); assert.ok(!seen.has(id)); seen.add(id);
    }
    const context = (state as { candidates: Candidate[] }).candidates;
    assert.ok(context.length <= MAX_BATCH_CANDIDATES && Buffer.byteLength(JSON.stringify(context)) <= MAX_BATCH_BYTES);
    if ('constraints' in questions) audit++;
    return answers(questions, audit === 2 ? 0.69 : 0.95);
  });
  assert.equal(seen.size, 89);
  assert.equal(report.coverage.assessed, 89); assert.equal(report.coverage.complete, true);
  assert.equal(audit, report.batchCount);
  assert.equal(report.status, 'pending');
  assert.ok(report.checks.every((check) => check.probability === 0.69));
  assert.equal(report.auditAttempts![0].batches!.length, report.batchCount);
});

test('large histories stop at a finite request bound and never label the remainder covered', async () => {
  const report = await previewHandoff(snapshot(2000, '字'.repeat(900)), async (_state, questions) => answers(questions));
  assert.ok(report.batchCount! <= MAX_BATCHES);
  assert.ok(report.requestCount! <= MAX_EVALUATION_CALLS);
  assert.equal(report.coverage.total, 2000);
  assert.equal(report.coverage.complete, false);
  assert.ok(report.coverage.assessed < report.coverage.total);
  assert.notEqual(report.status, 'pass');
  assert.ok(report.assessments!.some((row) => row.seq === 1999), 'The tail must still be assessed before the bound is exhausted');
});

test('audit payloads contain only the matching excerpts and fit the combined source-and-quote budget', async () => {
  const report = await previewHandoff(snapshot(89, 'x'.repeat(350)), async (state, questions) => {
    const input = state as { candidates: Candidate[]; candidate_handoff?: { selected_messages: Candidate[] } };
    if (input.candidate_handoff) {
      const ids = new Set(input.candidates.map((row) => row.id));
      assert.ok(input.candidate_handoff.selected_messages.every((row) => ids.has(row.id)));
      assert.ok(Buffer.byteLength(JSON.stringify(input.candidates)) + Buffer.byteLength(JSON.stringify(input.candidate_handoff.selected_messages)) <= MAX_BATCH_BYTES);
    }
    return answers(questions);
  });
  assert.equal(report.coverage.complete, true);
  assert.equal(report.auditComplete, true);
  assert.equal(report.status, 'pass');
  assert.ok(report.requestCount! <= MAX_EVALUATION_CALLS);
});

test('a middle-batch outage stops calls and cannot claim planned batches were checked', async () => {
  let calls = 0;
  const report = await previewHandoff(snapshot(89), async (_state, questions) => ++calls === 2 ? { error: 'offline' } : answers(questions));
  assert.equal(calls, 2);
  assert.equal(report.requestCount, 2);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.coverage.complete, false);
  assert.ok(report.coverage.assessed < report.coverage.total);
});
