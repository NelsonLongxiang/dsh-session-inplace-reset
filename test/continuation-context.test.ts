import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { previewHandoff, canonicalContinuationGoal, candidatesFrom } from '../lib/handoff-eval.ts';
import { approvedModelHandoff } from '../lib/model-handoff.ts';
import { DEFAULT_CONTINUATION_GOAL, MAX_CONTINUATION_BYTES, sealContinuation } from '../lib/continuation-context.ts';
import type { Evaluation, Questions } from '../lib/decision-model.ts';
import type { Candidate, SourceSnapshot } from '../lib/handoff-eval.ts';

const source = (): SourceSnapshot => ({ sessionId: 'session-11111111-1111-1111-1111-111111111111', cursor: 49, messages: Array.from({ length: 50 }, (_, seq) => ({ seq, role: seq === 48 ? 'assistant' : 'user', sourceKind: seq === 48 ? 'model' : 'user', text: ({ 0: '任务A：完成上下文重置插件。', 20: '全局约束：必须用TS，禁止重启整个DSH。', 33: '任务B：Odoo库存核对尚未完成，之后继续。', 48: '我认为所有任务都完成了，但没有工具回执。', 49: '继续' } as Record<number, string>)[seq] ?? `普通重复进度${seq}` })) });
const tape = (questions: Questions, { gray = false, offlineResolution = false } = {}): Evaluation => {
  if (offlineResolution && Object.keys(questions).some((key) => key.startsWith('resolve_'))) return { error: 'offline' };
  return { answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => {
    if (question.type === 'score') return [key, { score: 0, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 } }];
    const relevant = ['context_c0_task', 'context_c20_constraint', 'context_c33_task', 'context_c48_change'].includes(key);
    return [key, { probability: gray && key === 'context_c33_task' ? 0.5 : relevant || ['constraints', 'state', 'faithful'].includes(key) ? 0.95 : 0.05 }];
  })) };
};

test('all batches share an explicit goal and full task ledger; other topics and early constraints survive low local scores', async () => {
  const snapshot = source(), original = JSON.stringify(snapshot), goal = '继续开发上下文重置插件';
  const shared: string[] = [];
  let hasCrossBatchTask = false;
  const report = await previewHandoff(snapshot, async (state, questions) => {
    const input = state as { continuation: { goal: string; entries: { id: string }[] }; candidates: Candidate[] };
    assert.equal(input.continuation.goal, goal);
    if (Object.values(questions).some((question) => question.type === 'score') || 'constraints' in questions) {
      shared.push(JSON.stringify(input.continuation));
      assert.deepEqual(input.continuation.entries.map((entry) => entry.id), ['c0', 'c20', 'c33', 'c48']);
      if (!input.candidates.some((row) => row.id === 'c33')) hasCrossBatchTask = input.continuation.entries.some((row) => row.id === 'c33');
    }
    if ('constraints' in questions) {
      const payload = input as typeof input & { candidate_handoff: { selected_messages: Candidate[] } };
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 48 * 1024);
    }
    return tape(questions);
  }, { continuationGoal: goal });
  assert.equal(report.status, 'pass');
  assert.equal(report.continuation!.coverage.complete, true);
  assert.equal(report.continuation!.resolutionComplete, true);
  assert.equal(new Set(shared).size, 1);
  assert.equal(hasCrossBatchTask, true);
  assert.deepEqual(report.selected.map((row) => row.id), ['c0', 'c20', 'c33', 'c48']);
  assert.ok(report.selected.every((row) => row.retention === 'fail'), 'Protected ledger quotes do not relabel the original model scores');
  assert.equal(report.continuation!.entries.find((entry) => entry.candidate.id === 'c33')!.resolved!.outcome, 'fail');
  const choice = { modelReportId: randomUUID(), sourceHash: report.sourceHash, continuationGoal: goal };
  const seed = approvedModelHandoff({ connectionKey: 'fixture', report: { ...report, reportId: choice.modelReportId } }, choice, { snapshot, connectionKey: 'fixture', targetBytes: report.targetBytes, hardCapBytes: 512 * 1024 });
  assert.deepEqual(seed.continuation!.taskIds, ['c0', 'c33']);
  assert.equal(seed.continuation!.scopeOnly, true);
  assert.ok(!('resolved' in seed.continuation!), 'Closure verdicts do not become facts inside the seed');
  assert.equal(JSON.stringify(snapshot), original);
});

test('gray task classification preserves its source and blocks application', async () => {
  const report = await previewHandoff(source(), async (_state, questions) => tape(questions, { gray: true }));
  assert.equal(report.continuation!.uncertain, true);
  assert.equal(report.status, 'pending');
  assert.ok(report.selected.some((row) => row.id === 'c33'));
  assert.equal(report.continuation!.entries.find((entry) => entry.candidate.id === 'c33')!.probabilities.task, 0.5);
});

test('incomplete global resolution cannot start local filtering or claim approval', async () => {
  let filtered = false;
  const report = await previewHandoff(source(), async (_state, questions) => {
    if (Object.values(questions).some((question) => question.type === 'score')) filtered = true;
    return tape(questions, { offlineResolution: true });
  });
  assert.equal(filtered, false);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.continuation!.resolutionComplete, false);
});

test('oversized ledgers remain complete original quotes and stop before filtering', async () => {
  const snapshot = { ...source(), messages: Array.from({ length: 30 }, (_, seq) => ({ seq, role: 'user', sourceKind: 'user', text: `任务${seq}：${'约束'.repeat(400)}` })) };
  let filtered = false;
  const report = await previewHandoff(snapshot, async (_state, questions) => {
    filtered ||= Object.values(questions).some((question) => question.type === 'score');
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { probability: key.endsWith('_task') ? 0.95 : 0.05 }])) };
  });
  assert.equal(filtered, false);
  assert.equal(report.status, 'pending');
  assert.equal(report.continuation!.overflow, true);
  assert.equal(report.continuation!.entries.length, 30);
  assert.equal(report.continuation!.entries[0].candidate.text, snapshot.messages[0].text);
  assert.ok(Buffer.byteLength(JSON.stringify(report.continuation)) > MAX_CONTINUATION_BYTES);
});

test('goal edits, ledger tampering and missing protected references cannot apply a cached handoff', async () => {
  const snapshot = source();
  const report = await previewHandoff(snapshot, async (_state, questions) => tape(questions));
  const choice = { modelReportId: randomUUID(), sourceHash: report.sourceHash };
  const current = { snapshot, connectionKey: 'fixture', targetBytes: report.targetBytes, hardCapBytes: 512 * 1024 };
  const entry = { connectionKey: 'fixture', report: { ...report, reportId: choice.modelReportId } };
  assert.throws(() => approvedModelHandoff(entry, { ...choice, continuationGoal: '全新任务' }, current), /续接目标/);
  const altered = structuredClone(entry);
  altered.report.continuation!.entries[0].candidate.text = '没有来源的新命令';
  altered.report.continuation = sealContinuation(altered.report.continuation!);
  assert.throws(() => approvedModelHandoff(altered, choice, current), /原文/);
  const missing = structuredClone(entry);
  missing.report.selected = missing.report.selected.filter((row) => row.id !== 'c33');
  assert.throws(() => approvedModelHandoff(missing, choice, current), /遗漏/);
  const seed = structuredClone(entry);
  seed.report.handoff!.continuation!.scopeOnly = false;
  assert.throws(() => approvedModelHandoff(seed, choice, current), /不一致/);
});

test('default and custom goals are explicit and credential-safe before evaluation', async () => {
  assert.equal(canonicalContinuationGoal(), DEFAULT_CONTINUATION_GOAL);
  assert.equal(canonicalContinuationGoal(' \r\n '), DEFAULT_CONTINUATION_GOAL);
  for (const value of [null, 1, 'x'.repeat(2001), '\0']) assert.throws(() => canonicalContinuationGoal(value));
  const secret = 'vck_abcdefghijklmnopqrstuvwxyz';
  const report = await previewHandoff(source(), async (state, questions) => {
    assert.doesNotMatch(JSON.stringify(state), /vck_/);
    return tape(questions);
  }, { continuationGoal: `继续开发。api_key=${secret}` });
  assert.doesNotMatch(JSON.stringify(report), /vck_/);
  assert.equal(report.continuation!.goal.includes('[凭证已隐藏]'), true);
  assert.equal(candidatesFrom(source().messages).coverage.total, 50);
});
