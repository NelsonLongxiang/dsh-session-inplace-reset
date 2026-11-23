// 修复 v4 会话中 compaction/{prune,summary} 的 shadowedSeqs 与当前 surface 实际跨度不符的损坏。
// 病征：SessionFormatError: compaction/xx shadowedSeqs do not name an exact current surface span
// 成因：宿主撤回（withdraw）后 compaction 引用了旧时间线的面序；端点仍在面上，但声明序列错。
// 修法：按 relationships.ts foldSurface 精确重放 surface，把 shadowedSeqs 重算为 [start..end] 的真实 span。
// 用法：node bin/fix-compaction-span.mjs <in.zstd> <out.zstd>
// 迭代至 oracle 逐事件全过；遇非本类失败即停（rc=3），面重放异常即停（rc=4）。
import { loadDsh } from '../lib/dsh-lib.mjs';
import { openSession, replaySurface, writeSession } from '../lib/v4-file.mjs';
import { recordLedger } from '../lib/ledger.mjs';

const m = await loadDsh();

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('usage: node bin/fix-compaction-span.mjs <in.zstd> <out.zstd>'); process.exit(1); }
const rows = openSession(inFile).rows;
const header = { ...rows[0] }; delete header.type;
const events = rows.slice(1);
const types = new Set(events.map(e => e.type));

// 二分找首个 relationships 失败点
function firstFail() {
  let lo = 1, hi = events.length;
  const failAt = n => { try { m.assertReleasedV4Relationships({ header, inheritedEventCount: 0, events: events.slice(0, n) }, types); return null; } catch (e) { return e.message; } };
  if (!failAt(hi)) return null;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (failAt(mid)) hi = mid; else lo = mid + 1; }
  return { idx: lo - 1, err: failAt(lo) };
}

let round = 0;
for (;;) {
  const f = firstFail();
  if (!f) break;
  const ev = events[f.idx];
  round++;
  console.log(`round ${round}: seq ${ev.seq} ${ev.type}: ${f.err}`);
  if (!ev.type.startsWith('compaction/') || !ev.data?.shadowedRange || !Array.isArray(ev.data.shadowedSeqs)) {
    console.error(`STOP: non-compaction failure at seq ${ev.seq}`); process.exit(3);
  }
  const r = replaySurface(events, ev.seq - 1);
  if (r.error) { console.error('STOP: surface replay: ' + r.error); process.exit(4); }
  const first = r.surface.indexOf(ev.data.shadowedRange.start);
  const last = r.surface.indexOf(ev.data.shadowedRange.end);
  if (first < 0 || last < first) {
    console.error(`STOP: shadowedRange endpoints off-surface at seq ${ev.seq} (${first},${last})`); process.exit(4);
  }
  ev.data.shadowedSeqs = r.surface.slice(first, last + 1);
  console.log(`  -> recomputed span [${ev.data.shadowedSeqs[0]}..${ev.data.shadowedSeqs.at(-1)}] len=${ev.data.shadowedSeqs.length}`);
}
writeSession(outFile, rows);
recordLedger({ tool: 'fix-compaction-span', input: inFile, output: outFile, summary: `${round} compaction span(s) recomputed` });
console.log(`OK: ${round} compaction span(s) fixed, ${events.length} events -> ${outFile}`);
