import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionLifecycle } from '../lib/session-lifecycle.js';

const symbols = { effect: Symbol('effect'), original: Symbol('original') };
function fixture(status = 'idle') {
  const agents = new Map();
  const sessions = new Map();
  const effects = [];
  const calls = [];
  const loop = { runtime: { ctx: { fiber: { _disposables: effects, getEffects: () => effects.map((effect) => effect[symbols.effect]) } } }, prepare(_ctx, id) { calls.push(id); } };
  const agent = { status, session: { header: {} }, send() { calls.push('send'); } };
  agents.set('target', agent);
  sessions.set('target', agent.session);
  const other = { status: 'idle' };
  agents.set('other', other);
  const dispose = async () => { await Promise.resolve(); calls.push('writer closed'); agents.delete('target'); sessions.delete('target'); };
  dispose[symbols.effect] = { label: 'agentLoop.scope(target)' };
  effects.push(dispose);
  const controller = { agents: { resolveAgent: (id) => agents.get(id) }, prompt: ({ sessionId }) => calls.push(`prompt:${sessionId}`), create: () => {} };
  const services = { agents: { get: (id) => agents.get(id) }, sessions: { get: (id) => sessions.get(id) }, agentLoop: loop, sessionController: controller };
  const lifecycle = createSessionLifecycle({ get: (key) => services[key] }, symbols);
  return { lifecycle, agents, sessions, other, loop, calls, controller, effects };
}

test('live idle session uses its ordered owner disposer and leaves other agents attached', async () => {
  const f = fixture();
  assert.deepEqual(f.lifecycle.inspect('target'), { canReset: true });
  await f.lifecycle.run('target', async (lease) => {
    await lease.release();
    assert.equal(f.agents.has('target'), false);
    assert.equal(f.sessions.has('target'), false);
    assert.equal(f.agents.get('other'), f.other);
    assert.deepEqual(f.calls, ['writer closed']);
  });
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
