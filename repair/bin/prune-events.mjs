// 删除指定 seq 的事件并全量重排（220b6caf 第七层「孤儿 image/offload」手术的原型）。
// 场景：某些事件已不可重建（如指向不存在图片的 offload 记录、跨会话串写件），只能摘除。
// 修法：删指定 seq → 后续 seq 递减重排 → 全部引用字段平移（含 targets[].seq / shadowedSeqs /
//       shadowedRange / data.sourceEventSeq）。删前验「引用恰好指向被删 seq」→ 有即拒（rc=2）。
// 用法：node bin/prune-events.mjs <in.zstd> <out.zstd> <seq> [seq…]
// 校验：修完跑 oracle.mjs + preflight-v4.mjs；绝不做第二次猜测（启发式选代目标已到语义极限）。
import { openSession, writeSession } from '../lib/v4-file.mjs';

const [inFile, outFile, ...seqArgs] = process.argv.slice(2);
if (!inFile || !outFile || !seqArgs.length) {
  console.error('usage: node bin/prune-events.mjs <in.zstd> <out.zstd> <seq> [seq…]');
  process.exit(1);
}
const rows = openSession(inFile).rows;
const DEL = new Set(seqArgs.map(Number));
if ([...DEL].some(s => !Number.isInteger(s) || s < 0)) { console.error('PRUNE-ABORT: seq 须为非负整数'); process.exit(1); }

// 守卫：任何引用恰好指向被删 seq → 删后即悬挂，拒修
let dangling = [];
for (const ev of rows.slice(1)) {
  const chk = (v, where) => { if (typeof v === 'number' && DEL.has(v)) dangling.push(`${ev.seq}:${where}=${v}`); };
  for (const k of ['startSeq', 'endSeq']) { chk(ev[k], 'top.' + k); chk(ev.data?.[k], 'data.' + k); chk(ev.surfaceOp?.[k], 'sop.' + k); }
  for (const arr of [ev.sourceEventSeqs, ev.messageSeqs, ev.data?.sourceEventSeqs, ev.data?.messageSeqs]) if (Array.isArray(arr)) arr.forEach(v => chk(v, 'arr'));
  chk(ev.headerSeq, 'hdr'); chk(ev.data?.sourceEventSeq, 'data.sourceEventSeq');
  if (Array.isArray(ev.data?.shadowedSeqs)) ev.data.shadowedSeqs.forEach(v => chk(v, 'shadowedSeqs'));
  if (ev.data?.shadowedRange) for (const k of ['start', 'end']) chk(ev.data.shadowedRange[k], 'shadowedRange.' + k);
  if (Array.isArray(ev.data?.targets)) ev.data.targets.forEach((t, i) => chk(t?.seq, `targets[${i}].seq`));
}
if (dangling.length) { console.error('PRUNE-ABORT: 引用指向被删 seq → ' + JSON.stringify(dangling)); process.exit(2); }

const evs = rows.slice(1).filter(e => !DEL.has(e.seq));
const shift = s => { let n = 0; for (const d of DEL) if (d < s) n++; return s - n; };

for (const ev of evs) ev.seq = shift(ev.seq);
let refs = 0;
for (const ev of evs) {
  const sh = o => {
    if (!o || typeof o !== 'object') return;
    for (const k of ['startSeq', 'endSeq']) if (typeof o[k] === 'number') { const ns = shift(o[k]); if (ns !== o[k]) { o[k] = ns; refs++; } }
    for (const k of ['sourceEventSeqs', 'messageSeqs']) if (Array.isArray(o[k])) for (let j = 0; j < o[k].length; j++) { const ns = shift(o[k][j]); if (ns !== o[k][j]) { o[k][j] = ns; refs++; } }
    if (typeof o.headerSeq === 'number') { const ns = shift(o.headerSeq); if (ns !== o.headerSeq) { o.headerSeq = ns; refs++; } }
  };
  sh(ev); sh(ev.data); sh(ev.surfaceOp); if (ev.data?.surfaceOp) sh(ev.data.surfaceOp);
  const d = ev.data;
  if (typeof d?.sourceEventSeq === 'number') { const ns = shift(d.sourceEventSeq); if (ns !== d.sourceEventSeq) { d.sourceEventSeq = ns; refs++; } }
  if (Array.isArray(d?.shadowedSeqs)) for (let j = 0; j < d.shadowedSeqs.length; j++) { const ns = shift(d.shadowedSeqs[j]); if (ns !== d.shadowedSeqs[j]) { d.shadowedSeqs[j] = ns; refs++; } }
  if (d?.shadowedRange) for (const k of ['start', 'end']) if (typeof d.shadowedRange[k] === 'number') { const ns = shift(d.shadowedRange[k]); if (ns !== d.shadowedRange[k]) { d.shadowedRange[k] = ns; refs++; } }
  if (Array.isArray(d?.targets)) for (const t of d.targets) if (typeof t?.seq === 'number') { const ns = shift(t.seq); if (ns !== t.seq) { t.seq = ns; refs++; } }
}
for (let k = 0; k < evs.length; k++) if (evs[k].seq !== k) { console.error(`PRUNE-ABORT: 重排后乱序 @${k}`); process.exit(2); }
writeSession(outFile, [rows[0], ...evs]);
console.log(`pruned ${DEL.size} event(s) (${[...DEL].join(',')}), events ${rows.length - 1} -> ${evs.length}, refs shifted ${refs} -> ${outFile}`);
