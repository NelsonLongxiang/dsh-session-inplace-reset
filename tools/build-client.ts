import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const sourcePath = new URL('../src/client.ts', import.meta.url);
const outputPath = new URL('../lib/client.js', import.meta.url);
const source = (await readFile(sourcePath, 'utf8')).replace(/\r\n/g, '\n');
const output = '// Generated from src/client.ts; run node tools/build-client.ts\n'
  + stripTypeScriptTypes(source, { mode: 'strip' }).trimStart();
if (process.argv.includes('--check')) {
  const saved = (await readFile(outputPath, 'utf8')).replace(/\r\n/g, '\n');
  if (saved !== output) throw new Error('Client output is stale; run the client build entry');
} else {
  await writeFile(outputPath, output, 'utf8');
}
