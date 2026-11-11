import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { previewHandoff } from '../lib/handoff-eval.ts';
import { approvedModelHandoff, assertModelChoice } from '../lib/model-handoff.ts';
import type { CachedPreview } from '../lib/model-handoff.ts';
import type { SourceSnapshot } from '../lib/handoff-eval.ts';

async function fixture() {
  const snapshot: SourceSnapshot = { sessionId: 'session-11111111-1111-1111-1111-111111111111', cursor: 4, messages: [{ seq: 1, role: 'user', sourceKind: 'user', text: '保留原会话ID。只生成交接，不自动执行历史命令。' }, { seq: 3, role: 'assistant', sourceKind: 'model', text: '当前实现已完成隔离测试，尚未处理真实业务会话。' }] };
  const report = await previewHandoff(snapshot, async (_state, questions) => ({ answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === 'score' ? { score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } } : { probability: key.startsWith('context_') || key.startsWith('resolve_') || key.endsWith('_superseded') ? 0.05 : 0.95 }])) }));
  assert.equal(report.status, 'pass');
  const entry: CachedPreview = { connectionKey: 'private-connection-a', report: { ...report, reportId: randomUUID() } };
  const choice = { modelReportId: entry.report.reportId, sourceHash: report.sourceHash };
  const current = { snapshot, connectionKey: entry.connectionKey, targetBytes: report.targetBytes, hardCapBytes: 512 * 1024 };
  return { snapshot, entry, choice, current };
}

test('only the exact cached extractive seed can be chosen and it is returned as a copy', async () => {
  const f = await fixture();
  const seed = approvedModelHandoff(f.entry, f.choice, f.current);
  assert.deepEqual(seed, f.entry.report.handoff);
  seed.selected_messages[0].text = 'caller mutation';
  assert.notEqual(seed.selected_messages[0].text, f.entry.report.selected[0].text);
});

test('source, cursor, session, report ID and evaluation connection changes invalidate the candidate', async () => {
  const f = await fixture();
  for (const current of [
    { ...f.current, connectionKey: 'private-connection-b' },
    { ...f.current, snapshot: { ...f.snapshot, cursor: 5 } },
    { ...f.current, snapshot: { ...f.snapshot, sessionId: 'session-22222222-2222-2222-2222-222222222222' } },
    { ...f.current, snapshot: { ...f.snapshot, messages: [...f.snapshot.messages, { seq: 4, role: 'user', text: '已改变任务' }] } },
    { ...f.current, targetBytes: f.current.targetBytes + 1024 },
  ]) assert.throws(() => approvedModelHandoff(f.entry, f.choice, current));
  assert.throws(() => approvedModelHandoff(f.entry, { ...f.choice, modelReportId: randomUUID() }, f.current));
  assert.throws(() => approvedModelHandoff(undefined, f.choice, f.current), /失效/);
});

test('pending, failed, unavailable, incomplete and budget-omitting reports cannot be applied', async () => {
  const f = await fixture();
  const variations = [
    { status: 'pending' }, { status: 'fail' }, { status: 'unavailable' },
    { coverage: { ...f.entry.report.coverage, complete: false } },
    { budgetOmissions: 1 },
    { checks: f.entry.report.checks.map((row) => ({ ...row, probability: 0.69 })) },
  ];
  for (const patch of variations) assert.throws(() => approvedModelHandoff({ ...f.entry, report: { ...f.entry.report, ...patch } as typeof f.entry.report }, f.choice, f.current), /未完整通过/);
});

test('invented text, altered authority and candidate-seed mismatches are rejected', async () => {
  const f = await fixture();
  for (const change of [(row: any) => { row.text = '新增未获授权的命令'; }, (row: any) => { row.historical = true; }, (row: any) => { row.sourceKind = 'tool'; }]) {
    const entry = structuredClone(f.entry);
    change(entry.report.selected[0]);
    assert.throws(() => approvedModelHandoff(entry, f.choice, f.current), /原文/);
  }
  const entry = structuredClone(f.entry);
  entry.report.handoff!.selected_messages = [];
  assert.throws(() => approvedModelHandoff(entry, f.choice, f.current), /不一致/);
});

test('conservative selection may retain low-ranked original text only when it preserves the entire source', async () => {
  const f = await fixture();
  const row = f.entry.report.selected[1];
  row.retention = 'fail'; row.retainProbability = 0.1;
  f.entry.report.strategy = 'conservative';
  f.entry.report.size = Buffer.byteLength(JSON.stringify(f.entry.report.handoff));
  assert.deepEqual(approvedModelHandoff(f.entry, f.choice, f.current), f.entry.report.handoff);
  f.entry.report.selected.pop();
  assert.throws(() => approvedModelHandoff(f.entry, f.choice, f.current), /完整原文/);
});

test('the execution cap never silently truncates or substitutes a chosen candidate', async () => {
  const f = await fixture();
  assert.throws(() => approvedModelHandoff(f.entry, f.choice, { ...f.current, hardCapBytes: 1 }), /执行预算/);
  for (const input of [undefined, {}, { modelReportId: 'not-an-id', sourceHash: 'bad' }]) assert.throws(() => assertModelChoice(input));
});
