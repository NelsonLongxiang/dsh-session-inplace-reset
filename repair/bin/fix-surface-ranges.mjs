// 修复 v4 会话里 sourceEventSeqs 混入区间对 [a,b] 的损坏（replace 型面事件的覆盖集不完整）。
// 病征：SessionFormatError: replacement sourceEventSeqs omit a shadowed surface node。
// 成因：老的 seq-range 编码（v0 有区间语义）漏进了 v4 —— v4 fold 只认扁平数字 seq。
// 修法：把每个 [a,b] 区间对原地展开为 a..b 的独立 seq，保持原顺序、去重。
// 用法：node bin/fix-surface-ranges.mjs check|fix <in.zstd> [-o out.zstd]
// 校验：修完跑 oracle.mjs + preflight-v4.mjs。
import { openSession, writeSession } from '../lib/v4-file.mjs';

function die(msg) { console.error('FIX-ABORT: ' + msg); process.exit(2); }

// 返回该文件中所有含区间对的 sourceEventSeqs 位置
function scan(rows) {
  const hits = [];
  for (const ev of rows.slice(1)) {
    const s = ev.sourceEventSeqs;
    if (!Array.isArray(s)) continue;
    for (let k = 0; k < s.length; k++) {
      const v = s[k];
      if (Array.isArray(v)) {
        if (v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number' || v[0] > v[1]) die(`seq=${ev.seq} malformed range ${JSON.stringify(v)}`);
        hits.push({ seq: ev.seq, type: ev.type, at: k, range: v, covered: ev.surfaceOp });
      }
    }
  }
  return hits;
}
function flatten(rows) {
  let changed = 0;
  for (const ev of rows.slice(1)) {
    const s = ev.sourceEventSeqs;
    if (!Array.isArray(s) || !s.some(v => Array.isArray(v))) continue;
    const out = [];
    for (const v of s) {
      if (Array.isArray(v)) { for (let q = v[0]; q <= v[1]; q++) out.push(q); }
      else out.push(v);
    }
    ev.sourceEventSeqs = [...new Set(out)];
    changed++;
  }
  return changed;
}

const [mode, file, outFlag, outFile] = process.argv.slice(2);
if (!mode || !file || !['check', 'fix'].includes(mode)) {
  console.error('usage: node bin/fix-surface-ranges.mjs check|fix <in.zstd> [-o out.zstd]');
  process.exit(1);
}
const rows = openSession(file).rows;
const hits = scan(rows);
if (mode === 'check') {
  console.log(hits.length ? `RANGES: ${JSON.stringify(hits)}` : `OK: no nested ranges (${rows.length - 1} events)`);
  process.exit(0);
}
if (!hits.length) { console.log('nothing to fix'); process.exit(0); }
const changed = flatten(rows);
const out = outFlag === '-o' ? outFile : file.replace(/\.zstd$/, '') + '.rangefix.zstd';
writeSession(out, rows);
console.log(`flattened ${hits.length} range pair(s) across ${changed} event(s): ${JSON.stringify(hits.map(h => ({ seq: h.seq, type: h.type, range: h.range })))} -> ${out}`);
