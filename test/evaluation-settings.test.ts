import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createEvaluationSettings, normalizeApiBase } from '../lib/evaluation-settings.ts';
import type { CredentialStore } from '../lib/evaluation-settings.ts';
import { DEFAULT_API_BASE, evaluateConnection } from '../lib/decision-model.ts';

type RecordValue = NonNullable<Awaited<ReturnType<CredentialStore['readRecord']>>>;
class MemoryCredentials implements CredentialStore {
  records = new Map<string, RecordValue>();
  writable = true;
  writes = 0;
  async readRecord(key: string) { return this.records.get(key); }
  async describeRecord(_key: string) { return { writable: this.writable }; }
  async modifyRecord(key: string, mutate: Parameters<CredentialStore['modifyRecord']>[1]) {
    const next = await mutate(this.records.get(key));
    if (next) { this.records.set(key, next); this.writes++; }
    return this.records.get(key);
  }
}
const fallback = async () => ({ apiBase: DEFAULT_API_BASE, apiKey: 'legacy-test-key' });
const fixture = () => {
  const store = new MemoryCredentials();
  let changes = 0;
  const settings = createEvaluationSettings(store, 'web', () => { changes++; }, fallback);
  return { store, settings, changes: () => changes };
};

test('default reads preserve existing credentials and never return their value', async () => {
  const { store, settings } = fixture();
  const value = await settings.describe();
  assert.deepEqual(value, { apiBase: DEFAULT_API_BASE, configured: true, hasSavedKey: false, usingDefault: true, writable: true });
  assert.doesNotMatch(JSON.stringify(value), /legacy-test-key|apiKey/);
  assert.equal(store.writes, 0);
});

test('one atomic save persists endpoint and key; safe response excludes secrets', async () => {
  const { store, settings, changes } = fixture();
  const before = await settings.connection();
  const value = await settings.save({ apiBase: 'https://eval.example.test', apiKey: '  saved-test-key  ' });
  assert.equal(store.writes, 1);
  assert.equal(changes(), 1);
  assert.equal(value.apiBase, 'https://eval.example.test/v4/ai/evaluation-model');
  assert.equal(value.hasSavedKey, true);
  assert.doesNotMatch(JSON.stringify(value), /saved-test-key|apiKey/);
  const after = await settings.connection();
  assert.equal(after.apiKey, 'saved-test-key');
  assert.notEqual(after.cacheKey, before.cacheKey);
});

test('blank key preserves the latest stored value; unchanged saves do not invalidate cache', async () => {
  const { store, settings, changes } = fixture();
  await settings.save({ apiBase: 'https://eval.example.test', apiKey: 'first-key' });
  const [address, record] = [...store.records][0];
  store.records.set(address, { ...record, kind: 'api-key', key: 'newer-concurrent-key' });
  await settings.save({ apiBase: 'https://eval.example.test/other-endpoint', apiKey: '' });
  assert.equal((await settings.connection()).apiKey, 'newer-concurrent-key');
  const count = changes();
  await settings.save({ apiBase: 'https://eval.example.test/other-endpoint' });
  assert.equal(changes(), count);
});

test('changing origin requires an explicitly reentered key and leaves previous configuration intact', async () => {
  const { store, settings, changes } = fixture();
  await settings.save({ apiBase: 'https://first.example.test', apiKey: 'original-key' });
  const before = JSON.stringify([...store.records]);
  await assert.rejects(settings.save({ apiBase: 'https://second.example.test' }), /重新填写/);
  assert.equal(JSON.stringify([...store.records]), before);
  assert.equal(changes(), 1);
});

test('custom endpoints never inherit the unrelated ambient gateway credential', async () => {
  const { store, settings } = fixture();
  await assert.rejects(settings.save({ apiBase: 'https://custom.example.test' }), /首次保存/);
  assert.equal(store.writes, 0);
  assert.equal((await settings.connection()).apiKey, 'legacy-test-key');
});

test('settings are isolated across profile identities', async () => {
  const { store, settings } = fixture();
  const other = createEvaluationSettings(store, 'cli', () => {}, fallback);
  await settings.save({ apiBase: 'https://web.example.test', apiKey: 'web-key' });
  await other.save({ apiBase: 'https://cli.example.test', apiKey: 'cli-key' });
  assert.equal(store.records.size, 2);
  assert.equal((await settings.connection()).apiKey, 'web-key');
  assert.equal((await other.connection()).apiKey, 'cli-key');
});

test('URL and key validation reject unsafe or malformed input before writes', async () => {
  const { store, settings } = fixture();
  for (const apiBase of ['file:///tmp/key', 'javascript:alert(1)', 'https://user:secret@example.test', 'https://example.test/?api_key=secret', 'https://example.test/#secret', 'not-a-url']) {
    await assert.rejects(settings.save({ apiBase, apiKey: 'test-key' }));
  }
  for (const apiKey of ['key with spaces', 'key\r\nsecret-header', 'x'.repeat(16385)]) {
    await assert.rejects(settings.save({ apiBase: 'https://example.test', apiKey }));
  }
  assert.equal(store.writes, 0);
  assert.equal(normalizeApiBase('https://EXAMPLE.test:443/'), 'https://example.test/v4/ai/evaluation-model');
});

test('read-only or absent credential providers preserve fallback and refuse saves', async () => {
  const { store, settings } = fixture();
  store.writable = false;
  assert.equal((await settings.describe()).writable, false);
  await assert.rejects(settings.save({ apiBase: DEFAULT_API_BASE, apiKey: 'test-key' }), /不可写/);
  const absent = createEvaluationSettings(undefined, 'web', () => {}, fallback);
  assert.equal((await absent.describe()).writable, false);
  assert.equal((await absent.connection()).apiKey, 'legacy-test-key');
});

test('unknown credential record kinds are not overwritten', async () => {
  const { store, settings } = fixture();
  await settings.save({ apiBase: DEFAULT_API_BASE, apiKey: 'test-key' });
  const address = [...store.records.keys()][0];
  store.records.set(address, { kind: 'grant', payload: { preserve: true } });
  await assert.rejects(settings.save({ apiBase: DEFAULT_API_BASE, apiKey: 'replacement' }), /不兼容/);
  assert.equal(store.records.get(address)?.kind, 'grant');
});

test('configured endpoint and key reach real HTTP requests without restarting or rereading an in-flight connection', async (t) => {
  const received: { url: string; auth: string | undefined; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ url: request.url!, auth: request.headers.authorization, body });
    if (request.url === '/redirect') { response.writeHead(307, { location: '/destination' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers: { q: { probability: 0.9 } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const { settings } = fixture();
  await settings.save({ apiBase: base, apiKey: 'old-request-key' });
  const inFlight = await settings.connection();
  await settings.save({ apiBase: `${base}/new-endpoint`, apiKey: 'new-request-key' });
  const questions = { q: { type: 'boolean' as const, instructions: '接口测试' } };
  await evaluateConnection(inFlight, {}, questions);
  await evaluateConnection(await settings.connection(), {}, questions);
  assert.deepEqual(received.map(({ url, auth }) => ({ url, auth })), [
    { url: '/v4/ai/evaluation-model', auth: 'Bearer old-request-key' },
    { url: '/new-endpoint', auth: 'Bearer new-request-key' },
  ]);
  assert.ok(received.every((value) => !value.body.includes('request-key')));
  const redirected = await evaluateConnection({ ...await settings.connection(), apiBase: `${base}/redirect` }, {}, questions);
  assert.ok(redirected.error);
  assert.equal(received.length, 3, 'Redirect destination must not receive credentials');
  assert.equal(received.at(-1)!.url, '/redirect');
});
