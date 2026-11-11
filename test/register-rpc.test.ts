import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { registerSessionRpc } from '../lib/register-rpc.ts';

type Manifest = Parameters<typeof registerSessionRpc>[1];
const artifact = (): Manifest => ({ package: '@local/dsh-session-inplace-reset', face: 'host', invocations: ['sessionResetDryRun', 'sessionResetExecute', 'sessionResetResume'].map((method) => ({ id: method, service: 'sessionReset', namespace: 'sessionReset', method, result: { schema: 'existing-codec' } })) });
function fixture(legacy = true) {
  const base = { ...artifact(), invocations: legacy ? artifact().invocations.map((item) => ({ ...item, service: 'workspaceRegistry', namespace: 'workspaceRegistry' })) : [] };
  const owners = new Map<string, Manifest>([[artifact().package, base]]);
  const cleanups: (() => unknown)[] = [];
  const ctx = {
    get: (_name: 'typert') => ({
      register: (manifest: Manifest) => {
        assert.equal(owners.has(manifest.package), false, 'must not overwrite any live owner');
        for (const existing of owners.values()) for (const old of existing.invocations) assert.ok(!manifest.invocations.some((item) => item.namespace === old.namespace && item.method === old.method), 'must not collide with an existing endpoint');
        owners.set(manifest.package, manifest);
        return () => { owners.delete(manifest.package); };
      },
    }),
    effect: (mount: () => () => unknown) => { cleanups.push(mount()); },
  };
  return { ctx, owners, dispose: () => cleanups.forEach((cleanup) => cleanup()) };
}

test('preview contribution uses a real exported module key and removes only its own scope', async () => {
  const runtime = fixture();
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./preview'], './dist/register-rpc.js');
  await registerSessionRpc(runtime.ctx, artifact());
  const preview = runtime.owners.get(`${artifact().package}/preview`)!;
  assert.deepEqual(preview.invocations.map((item) => item.method), ['sessionResetDryRun', 'sessionResetExecute', 'sessionResetResume', 'sessionResetModelPreview', 'sessionResetEvaluationSettings', 'sessionResetSaveEvaluationSettings', 'sessionResetRecoveryStatus', 'sessionResetRecoveries']);
  runtime.dispose();
  assert.equal(runtime.owners.has(artifact().package), true);
  assert.equal(runtime.owners.has(preview.package), false);
});

test('cold automatic-loader metadata coexists with all owned RPC endpoints', async () => {
  const runtime = fixture(false);
  await registerSessionRpc(runtime.ctx, artifact());
  assert.equal(runtime.owners.get(`${artifact().package}/preview`)!.invocations.length, 8);
});

test('cached base endpoints remain owned by the host while preview activates', async () => {
  const runtime = fixture();
  const original = runtime.owners.get(artifact().package);
  await registerSessionRpc(runtime.ctx, artifact());
  assert.equal(runtime.owners.get(artifact().package), original);
  assert.equal(runtime.owners.size, 2);
});

test('artifact is not mutated and duplicate preview declarations are not copied', async () => {
  const runtime = fixture();
  const source = artifact();
  source.invocations.push({ ...source.invocations[0], id: 'old-preview', method: 'sessionResetModelPreview' });
  const original = JSON.stringify(source);
  await registerSessionRpc(runtime.ctx, source);
  assert.equal(runtime.owners.get(`${source.package}/preview`)!.invocations.filter((item) => item.method === 'sessionResetModelPreview').length, 1);
  assert.equal(JSON.stringify(source), original);
});

test('missing codec publishes no new endpoint', async () => {
  const runtime = fixture();
  await assert.rejects(registerSessionRpc(runtime.ctx, { ...artifact(), invocations: [] }), /codec/);
  assert.equal(runtime.owners.size, 1);
});

test('settings writes use their own strict request codec and strip unrelated fields', async () => {
  const runtime = fixture();
  await registerSessionRpc(runtime.ctx, artifact());
  const methods = runtime.owners.get(`${artifact().package}/preview`)!.invocations;
  assert.deepEqual(methods.find((item) => item.method === 'sessionResetEvaluationSettings')!.parameters, []);
  const save = methods.find((item) => item.method === 'sessionResetSaveEvaluationSettings')!;
  const parameters = save.parameters as { codec: { schema: { parse(value: unknown): unknown } } }[];
  const parse = parameters[0].codec.schema.parse;
  assert.throws(() => parse({ apiBase: 'https://example.test', apiKey: 123 }));
  assert.deepEqual(parse({ apiBase: 'https://example.test', apiKey: 'synthetic-key', extra: 'ignored' }), { apiBase: 'https://example.test', apiKey: 'synthetic-key' });
});

test('an existing preview owner is not overwritten', async () => {
  const runtime = fixture();
  await registerSessionRpc(runtime.ctx, artifact());
  const owner = runtime.owners.get(`${artifact().package}/preview`);
  await assert.rejects(registerSessionRpc(runtime.ctx, artifact()), /overwrite/);
  assert.equal(runtime.owners.get(`${artifact().package}/preview`), owner);
});
