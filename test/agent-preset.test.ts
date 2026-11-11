import assert from 'node:assert/strict';
import test from 'node:test';
import { observedAgentPreset, optionalAgentPreset, resetAgentPreset } from '../lib/agent-preset.ts';

test('current projection and persisted preset selections take precedence over the header', () => {
  const observation = { header: { agentPreset: 'standard' }, events: [{ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }] };
  assert.equal(observedAgentPreset(observation), 'minimal');
  assert.equal(observedAgentPreset({ ...observation, projections: { values: { agentPreset: 'ptc' } } }), 'ptc');
  assert.equal(observedAgentPreset({ ...observation, projections: { values: { agentPreset: null } } }), undefined);
});

test('preset input is explicit and default preservation remains compatible without a registry', async () => {
  assert.equal(optionalAgentPreset(undefined), undefined);
  for (const input of ['', null, [], {}, 42, ' minimal ', 'x'.repeat(257)]) assert.throws(() => optionalAgentPreset(input));
  assert.equal(await resetAgentPreset(undefined, undefined, 'standard'), 'standard');
  await assert.rejects(resetAgentPreset(undefined, 'minimal', 'standard'), /预设服务/);
});
