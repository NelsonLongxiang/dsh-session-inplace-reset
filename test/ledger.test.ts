import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Ledger } from '../lib/ledger.ts';

test('damaged historical tails are preserved and a fresh generation remains writable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reset-ledger-'));
  const root = join(home, 'session-reset');
  await mkdir(root);
  const path = join(root, 'operations.jsonl');
  const original = '{"operationId":"past","state":"RUNNING"}\n{"unfinished":';
  await writeFile(path, original);
  const ledger = new Ledger(home);
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.warnings.length, 1);
  ledger.append({ operationId: 'new', state: 'DONE' });
  assert.notEqual(ledger.path, path);
  assert.equal(await readFile(path, 'utf8'), original);
  const reloaded = new Ledger(home);
  assert.equal(reloaded.rows.length, 2);
  assert.equal(reloaded.warnings.length, 1);
  assert.notEqual(reloaded.path, ledger.path);
});

test('invalid legacy JSON does not prevent exposing safe recovery/configuration services', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reset-legacy-'));
  await mkdir(join(home, 'session-reset'));
  await writeFile(join(home, 'session-reset/ledger.json'), '{');
  const ledger = new Ledger(home);
  assert.equal(ledger.warnings.length, 1);
  ledger.append({ state: 'RECOVERED' });
  assert.equal(ledger.rows.length, 1);
  assert.equal(await readFile(join(home, 'session-reset/ledger.json'), 'utf8'), '{');
});
