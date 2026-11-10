// Explicit live check: synthetic cases only, no session APIs and no reset operations.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { previewHandoff, RUBRIC } from '../lib/handoff-eval.ts';
import { evaluate } from '../lib/decision-model.ts';
import type { Evaluation, Evaluator, Questions } from '../lib/decision-model.ts';

interface Fixture { id: string; description: string; messages: [string, string][]; mustKeep: string[]; fillerCount?: number }
interface Request { state: unknown; questions: Questions; resolve: (value: Evaluation) => void; id: string }

if (!process.argv.includes('--live')) throw new Error('Use --live for the existing decision-model endpoint; synthetic inputs only');
const fixtureSet = process.argv.includes('--heldout') ? 'heldout' : 'development';
const fixtures: Fixture[] = JSON.parse(await readFile(new URL(fixtureSet === 'heldout' ? './handoff-heldout.json' : './handoff-cases.json', import.meta.url), 'utf8'));
const queue: Request[] = [];
const calls: { questions: number; latencyMs: number; usage?: Evaluation['usage']; error?: string; state: unknown; questionDefinitions: Questions; answers?: Evaluation['answers'] }[] = [];
let draining = false;
let serial = 0;
const batched: Evaluator = (state, questions) => {
  return new Promise<Evaluation>((resolve) => {
    queue.push({ state, questions, resolve, id: `r${serial++}` });
    if (!draining) { draining = true; queueMicrotask(drain); }
  });
}
async function drain() {
  while (queue.length) {
    const batch = queue.splice(0, 4);
    const requests = Object.fromEntries(batch.map((item) => [item.id, item.state]));
    const questions = Object.fromEntries(batch.flatMap((item) => Object.entries(item.questions).map(([id, question]) => [`${item.id}_${id}`, { ...question, instructions: `本题只依据 state.requests.${item.id} 内的数据；其他requests与本题无关。${question.instructions}` }])));
    if (calls.length) await new Promise((done) => setTimeout(done, 15_000));
    const started = Date.now();
    const state = { requests };
    const response = await evaluate(state, questions);
    calls.push({ questions: Object.keys(questions).length, latencyMs: Date.now() - started, usage: response.usage, error: response.error, state, questionDefinitions: questions, answers: response.answers });
    console.log(`Model batch ${calls.length}: ${Object.keys(questions).length} questions, ${response.error ? 'unavailable' : 'answered'}`);
    for (const item of batch) item.resolve(response.error ? response : { answers: Object.fromEntries(Object.keys(item.questions).map((id) => [id, response.answers?.[`${item.id}_${id}`]])) });
  }
  draining = false;
}
const results = await Promise.all(fixtures.map(async (fixture) => {
  const pairs = [...fixture.messages];
  if (fixture.fillerCount) pairs.splice(pairs.length - 1, 0, ...Array.from({ length: fixture.fillerCount }, (_, i) => ['assistant', `例行进度播报${i}：仍在观察，没有新增证据或动作。`] as [string, string]));
  const messages = pairs.map(([role, text], seq) => ({ seq, role, sourceKind: role === 'assistant' ? 'model' : role, text }));
  const result = await previewHandoff({ sessionId: `fixture-${fixture.id}`, cursor: messages.length - 1, messages }, batched);
  assert.equal(result.applied, false);
  const kept = result.selected.map((item) => item.text).join('\n');
  const baseline = messages.slice(-12).map((item) => item.text).join('\n');
  return { id: fixture.id, description: fixture.description, expected: fixture.mustKeep, missing: fixture.mustKeep.filter((text) => !kept.includes(text)), baselineMissing: fixture.mustKeep.filter((text) => !baseline.includes(text)), result };
}));
const directory = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `golden-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const report = { kind: 'synthetic-held-fixed-fixtures', rubric: RUBRIC, fixtureSet, noTuningDuringRun: true, independentHumanReview: 'NOT_RUN', sessionMutations: false, cases: results.length, calls, retainedAllRequired: results.filter((row) => !row.missing.length).length, baselineRetainedAllRequired: results.filter((row) => !row.baselineMissing.length).length, results };
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ cases: report.cases, retainedAllRequired: report.retainedAllRequired, baselineRetainedAllRequired: report.baselineRetainedAllRequired, modelStatuses: Object.fromEntries(results.map((row) => [row.id, row.result.status])), evidence: join(directory, 'result.json') }, null, 2));
