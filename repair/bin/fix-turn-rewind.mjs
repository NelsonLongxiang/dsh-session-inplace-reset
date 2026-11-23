// 修复 v4 会话的 turn 号回退（rewind 后 turn/start 重写旧号，后缀未抬）。
// 病征：SessionFormatError: turn/start does not open the expected turn（NUM 支，非缺 turn/end）。
// 修法：从首个回退点起对所有事件的 data.turn 统一 +N（回退段及其后整段后缀一起抬，
//       避免与后面已有的大号撞号——repair-v4-session 的 fixTurnsAndTypes 只抬小于当前 turn 的行，会撞号）。
// 用法：
//   node bin/fix-turn-rewind.mjs check <session.v4.jsonl.zstd>   # 只诊断（零改动）
//   node bin/fix-turn-rewind.mjs fix   <in.zstd> [-o out.zstd]   # 修复并写出（逐行一帧）
// 校验：修完请再跑 oracle.mjs 与 preflight-v4.mjs。
// 限制：遇前向跳号/未闭合 turn/open step 会拒修（die），需人工另判。
import fs from 'node:fs';
import { openSession, writeSession } from '../lib/v4-file.mjs';

function die(msg) { console.error('FIX-ABORT: ' + msg); process.exit(2); }

// 走一遍 turn 机；返回 {fixes, turns, lastSeq, events}；异常即拒修
function walk(rows, mutate) {
  let shift = 0, nextTurn = 1, open = null;
  const fixes = [];
  const turns = [];
  let lastSeq = null;
  for (const ev of rows.slice(1)) {
    if (typeof ev.seq === 'number') {
      if (lastSeq !== null && ev.seq !== lastSeq + 1) die(`seq gap at seq=${ev.seq} (last=${lastSeq})`);
      lastSeq = ev.seq;
    }
    if (mutate && typeof ev.data?.turn === 'number') ev.data.turn += shift;
    if (ev.type === 'turn/start') {
      const t = ev.data?.turn;
      if (typeof t !== 'number') die(`turn/start without data.turn at seq=${ev.seq}`);
      if (t !== nextTurn) {
        const extra = nextTurn - t;
        if (extra <= 0) die(`forward jump at seq=${ev.seq} got=${t} expect=${nextTurn}`);
        if (!mutate) die(`CORRUPT: turn/start seq=${ev.seq} got=${t} expect=${nextTurn} (rewind, extra=${extra})`);
        ev.data.turn += extra; shift += extra;
        fixes.push({ seq: ev.seq, extra, shift, turn: ev.data.turn });
      }
      if (open !== null) die(`turn/start seq=${ev.seq} while turn ${open} still open`);
      open = ev.data.turn; turns.push(ev.data.turn);
    } else if (ev.type === 'turn/end') {
      const t = ev.data?.turn;
      if (open === null || t !== open) die(`turn/end seq=${ev.seq} open=${open} got=${t}`);
      open = null; nextTurn++;
    }
  }
  if (open !== null) die(`file ends with open turn ${open}`);
  return { fixes, turns, lastSeq, events: rows.length - 1 };
}

const [mode, file, outFlag, outFile] = process.argv.slice(2);
if (!mode || !file || !['check', 'fix'].includes(mode)) {
  console.error('usage: node bin/fix-turn-rewind.mjs check|fix <in.zstd> [-o out.zstd]');
  process.exit(1);
}
const rows = openSession(file).rows;
if (mode === 'check') {
  try { const r = walk(rows, false); console.log(`OK: ${r.events} events, turns=[${r.turns.join(',')}], lastSeq=${r.lastSeq}`); }
  catch (e) { if (String(e.message).startsWith('FIX-ABORT:')) { console.log(e.message); process.exit(2); } else throw e; }
  process.exit(0);
}
const r = walk(rows, true);
if (!r.fixes.length) { console.log('nothing to fix'); process.exit(0); }
const out = outFlag === '-o' ? outFile : file.replace(/\.zstd$/, '') + '.turnfix.zstd';
writeSession(out, rows);
console.log(`fixed ${r.fixes.length} rewind point(s): ${JSON.stringify(r.fixes)} turns=[${r.turns.join(',')}] lastSeq=${r.lastSeq} -> ${out}`);
