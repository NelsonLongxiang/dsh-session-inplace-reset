import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionLifecycle } from '../lib/session-lifecycle.js';

const symbols = { effect: Symbol('effect'), original: Symbol('original') };
function fixture(status = 'idle') {
  const agents = new Map();
  const sessions = new Map();
  const effects = [];
  const calls = [];
  const owners = [];
  const ownerFiber = { _disposables: owners, getEffects: () => owners.map((dispose) => dispose[symbols.effect]) };
  const loop = { runtime: { ctx: { fiber: { _disposables: effects, getEffects: () => effects.map((effect) => effect[symbols.effect]) } } }, prepare(_ctx, id) { calls.push(id); } };
  const agent = { status, session: { header: {} }, send() { calls.push('send'); } };
  agents.set('target', agent);
  sessions.set('target', agent.session);
  const other = { status: 'idle' };
  agents.set('other', other);
  let closed = false;
  const dispose = async () => { if (closed) return; closed = true; await Promise.resolve(); calls.push('writer closed'); agents.delete('target'); sessions.delete('target'); const index = effects.indexOf(dispose); if (index >= 0) effects.splice(index, 1); };
  dispose[symbols.effect] = { label: 'agentLoop.scope(target)' };
  effects.push(dispose);
  const owner = async () => { await dispose(); calls.push('owner released'); const index = owners.indexOf(owner); if (index >= 0) owners.splice(index, 1); };
  owner[symbols.effect] = { label: 'agentLoop.lifecycle(target)' };
  owners.push(owner);
  const controller = { ctx: { fiber: ownerFiber }, agents: { resolveAgent: (id) => agents.get(id) }, prompt: ({ sessionId }) => calls.push(`prompt:${sessionId}`), create: () => {} };
  const services = { agents: { get: (id) => agents.get(id) }, sessions: { get: (id) => sessions.get(id) }, agentLoop: loop, sessionController: controller };
  const lifecycle = createSessionLifecycle({ get: (key) => services[key] }, symbols);
  return { lifecycle, agents, sessions, other, loop, calls, controller, effects, owners };
}

test('live idle session uses its ordered owner disposer and leaves other agents attached', async () => {
  const f = fixture();
  assert.deepEqual(f.lifecycle.inspect('target'), { canReset: true });
  await f.lifecycle.run('target', async (lease) => {
    await lease.release();
    assert.equal(f.agents.has('target'), false);
    assert.equal(f.sessions.has('target'), false);
    assert.equal(f.agents.get('other'), f.other);
    assert.deepEqual(f.calls, ['writer closed', 'owner released']);
    assert.equal(f.owners.length, 0);
    assert.equal(f.effects.length, 0);
  });
  f.lifecycle.dispose();
});

test('the complete owner is required and stale same-ID owners are released without touching another session', async () => {
  const unknown = fixture();
  unknown.owners.length = 0;
  await assert.rejects(unknown.lifecycle.run('target', async () => {}), /完整生命周期/);
  unknown.lifecycle.dispose();
  const f = fixture();
  let oldReleased = false, otherReleased = false;
  const old = async () => { oldReleased = true; f.owners.splice(f.owners.indexOf(old), 1); };
  old[symbols.effect] = { label: 'agentLoop.lifecycle(target)' };
  const other = async () => { otherReleased = true; };
  other[symbols.effect] = { label: 'agentLoop.lifecycle(other)' };
  f.owners.push(old, other);
  await f.lifecycle.run('target', (lease) => lease.release());
  assert.equal(oldReleased, true); assert.equal(otherReleased, false);
  assert.deepEqual(f.owners, [other]);
  assert.equal(f.agents.get('other'), f.other);
  f.lifecycle.dispose();
});

test('cold sessions can clean already-detached owner effects but refuse an unpublished active scope', async () => {
  const f = fixture();
  f.agents.delete('target'); f.sessions.delete('target');
  await assert.rejects(f.lifecycle.run('target', async () => {}), /未归属/);
  f.effects.length = 0;
  await f.lifecycle.run('target', (lease) => lease.release());
  assert.equal(f.owners.length, 0);
  f.lifecycle.dispose();
});

test('running or unknown lifecycle refuses before entering destructive work', async () => {
  const f = fixture('running');
  let operated = false;
  await assert.rejects(f.lifecycle.run('target', async () => { operated = true; }), /正在运行/);
  f.agents.get('target').status = 'idle';
  f.effects.length = 0;
  await assert.rejects(f.lifecycle.run('target', async () => { operated = true; }), /唯一确认/);
  assert.equal(operated, false);
  assert.equal(f.agents.has('target'), true);
  f.lifecycle.dispose();
});

test('plugin disposal drains the active transaction before removing its write fence', async () => {
  const f = fixture();
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const operation = f.lifecycle.run('target', async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  let disposed = false;
  const disposal = f.lifecycle.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  assert.throws(() => f.controller.prompt({ sessionId: 'target' }), /正在重置/);
  await assert.rejects(f.lifecycle.run('other', async () => {}), /卸载/);
  finish.resolve();
  await operation;
  await disposal;
  assert.equal(disposed, true);
  f.controller.prompt({ sessionId: 'target' });
});

test('same-session concurrent writes are fenced while another session remains usable', async () => {
  const f = fixture();
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const job = f.lifecycle.run('target', async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  assert.throws(() => f.controller.prompt({ sessionId: 'target' }), /正在重置/);
  assert.throws(() => f.loop.prepare(null, 'target'), /正在重置/);
  f.controller.prompt({ sessionId: 'other' });
  f.loop.prepare(null, 'other');
  await assert.rejects(f.lifecycle.run('target', async () => {}), /重复提交/);
  finish.resolve();
  await job;
  f.controller.prompt({ sessionId: 'target' });
  f.lifecycle.dispose();
  assert.ok(f.calls.includes('prompt:other'));
  assert.ok(f.calls.includes('prompt:target'));
});
