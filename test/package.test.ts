import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('normal node_modules imports use compiled JS and never require TypeScript stripping', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sandbox = await mkdtemp(join(tmpdir(), 'reset-installed-package-'));
  const installed = join(sandbox, 'node_modules/@local/dsh-session-inplace-reset');
  await cp(join(root, 'dist'), join(installed, 'dist'), { recursive: true });
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(installed, 'package.json'), JSON.stringify(metadata));
  for (const endpoint of ['.', './client', './preview', './typert']) assert.match(metadata.exports[endpoint], /^\.\/dist\/.+\.js$/);
  const imports = ['decision-model.js', 'evaluation-settings.js', 'reset-journal.js', 'reset-transaction.js', 'register-rpc.js'].map((name) => `await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', name)).href)});`).join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', imports], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});
