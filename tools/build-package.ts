import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Compiler {
  ScriptTarget: { ES2023: number }; ModuleKind: { ESNext: number };
  transpileModule(source: string, options: object): { outputText: string; diagnostics?: { category: number; messageText: unknown }[] };
  preProcessFile(source: string, readImports: boolean, detectJavaScriptImports: boolean): { importedFiles: { fileName: string }[] };
}
const root = fileURLToPath(new URL('../', import.meta.url));
const index = process.argv.indexOf('--compiler');
const compiler = createRequire(import.meta.url)(index >= 0 ? process.argv[index + 1] : 'typescript') as Compiler;
const checking = process.argv.includes('--check');
const output = join(root, 'dist');
const expected = new Map<string, string>();
for (const name of (await readdir(join(root, 'lib'))).sort()) {
  if (!/\.(?:js|ts)$/.test(name) || name.endsWith('.d.ts')) continue;
  const source = (await readFile(join(root, 'lib', name), 'utf8')).replace(/\r\n/g, '\n');
  const result = name === 'client.js' ? { outputText: source, diagnostics: [] } : compiler.transpileModule(source, { fileName: name, reportDiagnostics: true, compilerOptions: { allowJs: true, target: compiler.ScriptTarget.ES2023, module: compiler.ModuleKind.ESNext, rewriteRelativeImportExtensions: true } });
  assert.ok(!result.diagnostics?.some((item) => item.category === 1), `Runtime build failed: ${name}`);
  const text = result.outputText.replace(/\r\n/g, '\n');
  const imports = compiler.preProcessFile(text, true, true).importedFiles;
  assert.ok(imports.every((item) => !item.fileName.endsWith('.ts')), `Uncompiled runtime import in ${name}`);
  const destination = name.replace(/\.ts$/, '.js');
  assert.ok(!expected.has(destination), `Runtime output collision: ${destination}`);
  expected.set(destination, text);
}
if (!checking) await mkdir(output, { recursive: true });
for (const [name, content] of expected) {
  if (checking) assert.equal((await readFile(join(output, name), 'utf8')).replace(/\r\n/g, '\n'), content, `Stale generated runtime: ${name}`);
  else await writeFile(join(output, name), content, 'utf8');
}
assert.deepEqual((await readdir(output)).filter((name) => !name.startsWith('.')).sort(), [...expected.keys()].sort(), 'Unexpected generated runtime files');
console.log(`${checking ? 'Checked' : 'Built'} ${expected.size} JavaScript runtime files`);
