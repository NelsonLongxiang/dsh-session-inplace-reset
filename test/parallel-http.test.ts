import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { evaluateConnection } from '../lib/decision-model.ts';
import type { Questions } from '../lib/decision-model.ts';
import { previewHandoff } from '../lib/handoff-eval.ts';

test('the real HTTP evaluation client sends at most four concurrent requests and aggregates the complete result', async () => {
  let active = 0, peak = 0, calls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { questions: Questions };
    active++; calls++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const answers = Object.fromEntries(Object.entries(input.questions).map(([key, question]) => [key, question.type === 'score' ? { score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } } : { probability: key.startsWith('context_') || key.startsWith('resolve_') || key.endsWith('_superseded') ? 0.05 : 0.95 }]));
    active--;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const connection = { apiBase: `http://127.0.0.1:${port}/evaluation`, apiKey: 'synthetic-local-key' };
    const source = { sessionId: 'session-11111111-1111-1111-1111-111111111111', cursor: 149, messages: Array.from({ length: 150 }, (_, seq) => ({ seq, role: 'user', sourceKind: 'user', text: `第${seq}条有效约束，保留原ID。` })) };
    const report = await previewHandoff(source, (state, questions) => evaluateConnection(connection, state, questions));
    assert.equal(report.status, 'pass');
    assert.equal(report.coverage.assessed, 150);
    assert.equal(report.coverage.complete, true);
    assert.equal(report.auditComplete, true);
    assert.equal(peak, 4);
    assert.equal(active, 0);
    assert.equal(calls, report.requestCount);
    assert.equal(report.peakConcurrency, peak);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
