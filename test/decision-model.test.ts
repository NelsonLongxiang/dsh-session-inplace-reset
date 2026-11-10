import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../lib/decision-model.ts';
import type { Questions } from '../lib/decision-model.ts';

const questions: Questions = { q: { type: 'boolean', instructions: '是否保留原ID？' } };
const withToken = async (run: () => Promise<void>) => {
  const previous = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = 'synthetic-test-key';
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previous;
  }
};

test('TypeScript client uses the existing v4 protocol and keeps credentials out of body/results', async (t) => withToken(async () => {
  const transport = t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    assert.equal(String(url), 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
    assert.equal(options?.method, 'POST');
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-test-key');
    assert.equal(headers.get('ai-model-id'), 'typesafe-ai/jev');
    assert.equal(headers.get('ai-evaluation-model-specification-version'), '4');
    assert.equal(headers.get('ai-gateway-protocol-version'), '0.0.1');
    assert.equal(headers.get('ai-gateway-auth-method'), 'api-key');
    assert.ok(options?.signal);
    assert.equal(options?.redirect, 'error');
    assert.doesNotMatch(String(options?.body), /synthetic-test-key/);
    return new Response(JSON.stringify({ answers: { q: { probability: 0.95 } }, usage: { inputTokens: 20, outputTokens: 5 } }));
  });
  const result = await evaluate({ text: '保留原ID' }, questions);
  assert.equal(result.answers?.q?.probability, 0.95);
  assert.equal(result.usage?.inputTokens, 20);
  assert.equal(transport.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-test-key/);
}));

for (const status of [401, 429, 529]) test(`HTTP ${status} is explicit, does not retry, and never echoes gateway bodies`, async (t) => withToken(async () => {
  const transport = t.mock.method(globalThis, 'fetch', async () => new Response('private-gateway-detail', { status }));
  const result = await evaluate({}, questions);
  assert.match(result.error!, new RegExp(String(status)));
  assert.doesNotMatch(result.error!, /private-gateway-detail/);
  assert.equal(transport.mock.callCount(), 1);
}));

test('network failure is unavailable rather than a successful judgement', async (t) => withToken(async () => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-network-detail'); });
  const result = await evaluate({}, questions);
  assert.ok(result.error);
  assert.equal(result.answers, undefined);
  assert.doesNotMatch(result.error!, /private-network-detail/);
}));

for (const body of ['not-json', '{"answers":[]}', 'null']) test(`malformed response ${body} is rejected`, async (t) => withToken(async () => {
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  const result = await evaluate({}, questions);
  assert.ok(result.error);
  assert.equal(result.answers, undefined);
}));
