import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { a2aRosterRisk } from '../lib/a2a-roster.ts';

test('a2a roster risk reports joined sessions and probes the host a2a fix state', () => {
  const home = mkdtempSync(join(tmpdir(), 'a2a-risk-'));
  const id = 'session-11111111-1111-1111-1111-111111111111';
  try {
    assert.equal(a2aRosterRisk(home, id), undefined, 'no roster file → no risk row');
    mkdirSync(join(home, 'a2a'), { recursive: true });
    writeFileSync(join(home, 'a2a', 'joined.json'), 'not json', 'utf8');
    assert.equal(a2aRosterRisk(home, id), undefined, 'malformed roster → no guess');
    writeFileSync(join(home, 'a2a', 'joined.json'), JSON.stringify({ sessions: ['session-22222222-2222-2222-2222-222222222222'] }), 'utf8');
    assert.equal(a2aRosterRisk(home, id), undefined, 'not joined → no risk row');
    writeFileSync(join(home, 'a2a', 'joined.json'), JSON.stringify({ sessions: [id] }), 'utf8');
    const unknown = a2aRosterRisk(home, id);
    assert.ok(unknown?.joined === true && unknown.hostA2aUnfixed === null && /名册/.test(unknown.warning), 'unresolvable a2a lib → unfixed=null, warning without #756 wording');
    const lib = join(home, 'fake-a2a.js');
    writeFileSync(lib, 'return face.resolveAgent(SessionId(id)).then(result => result.agent)', 'utf8');
    const unfixed = a2aRosterRisk(home, id, () => lib)!;
    assert.equal(unfixed.hostA2aUnfixed, true, 'bare resolveAgent call → #756 wording');
    assert.match(unfixed.warning, /#756/);
    writeFileSync(lib, 'return Promise.resolve(face.resolveAgent(SessionId(id))).then(r => r.agent, () => undefined)', 'utf8');
    const fixed = a2aRosterRisk(home, id, () => lib)!;
    assert.equal(fixed.hostA2aUnfixed, false, 'wrapped call → no #756 wording');
    assert.doesNotMatch(fixed.warning, /#756/);
    assert.equal(a2aRosterRisk(home, id, () => { throw new Error('boom'); })?.hostA2aUnfixed, null, 'resolver throw → null, never crashes dryRun');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
