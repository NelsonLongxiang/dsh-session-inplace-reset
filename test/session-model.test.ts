import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionModel } from '../lib/session-model.ts';

test('topic analysis follows the exact session model and effort, including a pending selection', () => {
  const selected = { provider: 'session-provider', model: 'session-model', reasoningEffort: 'high' };
  const observation = { cursor: 7, projections: { asOfSeq: 7, values: { modelSelection: { next: selected } } } };
  let defaultReads = 0;
  const value = sessionModel(observation, { currentSelection: () => { defaultReads++; return { provider: 'other', model: 'default' }; } });
  assert.deepEqual(value, { selection: selected, source: 'session' });
  assert.equal(defaultReads, 0);
  value.selection.model = 'caller mutation';
  assert.equal(selected.model, 'session-model');
});

test('only an explicitly unselected session inherits the native default; absent or stale projections refuse', () => {
  const defaults = { currentSelection: () => ({ provider: 'native-default', model: 'current-default' }) };
  assert.deepEqual(sessionModel({ cursor: 0, projections: { asOfSeq: 0, values: { modelSelection: { next: null } } } }, defaults), { selection: defaults.currentSelection(), source: 'default' });
  assert.throws(() => sessionModel({ cursor: 0 }, defaults));
  assert.throws(() => sessionModel({ cursor: 0, projections: { asOfSeq: -1, values: {} } }, defaults));
  assert.throws(() => sessionModel({ cursor: 0, projections: { asOfSeq: 0, values: {} } }, defaults));
  assert.throws(() => sessionModel({ cursor: 0, projections: { asOfSeq: 0, values: { modelSelection: { next: null } } } }));
});
