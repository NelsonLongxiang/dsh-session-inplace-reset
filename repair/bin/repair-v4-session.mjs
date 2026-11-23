#!/usr/bin/env node
// v4 会话日志修复工具（v9 终版方法）。用法见 --help。
// 背景：in-place-reset + superagent 重拉成员会写出两类损坏——
//   ① turn 编号回退（重拉后 turn/start 重写 turn=1）→ 精修用 fix-turn-rewind.mjs
//   ② 中段出现 system/message（v4 只许 system 在受保护 surface 首头）
// 管线：fixTurnsAndTypes（fold 语义）→ fixSystemFields → insertHead（合法三明治）→
//       ensureStepWindow → renumberSeqs 安全网 → 逐行一帧重压。
// 硬约束：seq 连续律（宿主 persistence 扫描器强制，oracle 不查这维）；插入事件必须各拿连续 seq
// 并连带平移四类引用（sourceEventSeqs / headerSeq / startSeq / endSeq / messageSeqs）。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openSession, writeSession, SURFACE_TYPES } from '../lib/v4-file.mjs';
import { recordLedger } from '../lib/ledger.mjs';

const usage = `repair-v4-session.mjs — DSH 会话日志修复（v9 方法）

  node repair-v4-session.mjs fix <session.v4.jsonl.zstd> [-o out.zstd]
      修复并重压（帧=行）。输出默认 <dir>/repaired-v9.zstd
  node repair-v4-session.mjs check <file.zstd>
      结构自检：帧数、行数、逐行 JSON、turn 单调性、中段 system 探测
  node repair-v4-session.mjs ensure-head <file.zstd> [-o out.zstd]
      CLEAN 无头冷会话补头（建 protectedHead 后永不复发）
  node repair-v4-session.mjs frames <file.zstd>
      只读帧结构（对照原始件的分帧布局）`;

function die(msg) { console.error('ERROR:', msg); process.exit(1); }

/** system/message 字段体检：step 必领正、message.id 必须非空（assertV4SystemMessageFields 同源） */
function systemFieldBad(ev) {
  if (ev.type !== 'system/message') return false;
  const d = ev.data ?? {};
  const m = d.message ?? {};
  return !(Number(d.step) >= 1) || typeof m.id !== 'string' || m.id.length === 0 || !m.source || typeof m.source !== 'object' || typeof m.source.kind !== 'string' || m.source.kind.length === 0 || m.source.kind === 'plugin';
}
/** 修 system/message 字段（step<1→1，缺 id→uuid）；返回修了几行 */
function fixSystemFields(evs) {
  let n = 0;
  for (const e of evs) {
    if (e.type !== 'system/message') continue;
    const d = e.data ?? (e.data = {});
    if (!(Number(d.step) >= 1)) { d.step = 1; n++; }
    const m = d.message ?? (d.message = { role: 'system', content: [] });
    if (typeof m.id !== 'string' || m.id.length === 0) { m.id = randomUUID(); n++; }
    if (!m.source || typeof m.source !== 'object' || typeof m.source.kind !== 'string' || m.source.kind.length === 0 || m.source.kind === 'plugin') { m.source = { kind: 'system-prompt' }; n++; }
  }
  return n;
}
/** surface 无 system 头时插入占位头（seq 与引用连带平移；必要时先补 step/start 窗口）；返回是否插入。 */
function insertHead(evs) {
  const firstSurface = evs.findIndex((e, i) => i > 0 && SURFACE_TYPES.has(e.type));
  if (firstSurface < 0 || evs[firstSurface].type === 'system/message') return false;
  const at = evs[firstSurface];
  const turn = Math.max(1, Number(at.data?.turn ?? at.turn ?? 1));
  const head = { type: 'system/message', seq: at.seq, time: at.time ?? Date.now(),
    data: { turn, step: 1, message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' };
  // 无 step 窗口时先补 step/start{turn,1}（system/message 必须落在打开的 turn+step 内）
  const hasOpenStep = evs.slice(1, firstSurface).some((e) => e.type === 'step/start');
  // 三件各拿连续 seq：atSeq / atSeq+1 / atSeq+2（hasOpenStep 时复用既有窗口则 +0/+1）
  head.seq = at.seq + (hasOpenStep ? 0 : 1);
  const stepEnd = { type: 'step/end', seq: head.seq + 1, time: head.time, data: { turn, step: 1 } };
  const insert = hasOpenStep ? [head, stepEnd] : [{ type: 'step/start', seq: at.seq, time: head.time, data: { turn, step: 1 } }, head, stepEnd];
  const atSeq = at.seq;
  for (const e of evs) {
    if (typeof e.seq === 'number' && e.seq >= atSeq) e.seq += insert.length;
    // 交叉引用连带平移：sourceEventSeqs / headerSeq / replace 型 surfaceOp 的 startSeq·endSeq
    const shift = (o) => {
      if (!o || typeof o !== 'object') return;
      if (typeof o.startSeq === 'number' && o.startSeq >= atSeq) o.startSeq += insert.length;
      if (typeof o.endSeq === 'number' && o.endSeq >= atSeq) o.endSeq += insert.length;
      if (Array.isArray(o.sourceEventSeqs)) o.sourceEventSeqs = o.sourceEventSeqs.map((v) => (typeof v === 'number' && v >= atSeq ? v + insert.length : v));
      if (Array.isArray(o.messageSeqs)) o.messageSeqs = o.messageSeqs.map((v) => (typeof v === 'number' && v >= atSeq ? v + insert.length : v));
      if (typeof o.headerSeq === 'number' && o.headerSeq >= atSeq) o.headerSeq += insert.length;
    };
    shift(e); shift(e.data); shift(e.surfaceOp); shift(e.data?.surfaceOp);
  }
  evs.splice(firstSurface, 0, ...insert);
  return true;
}
/** 头 system 前无 step/start 窗口时补一个（+1 平移）；返回是否插入 */
function ensureStepWindow(evs) {
  const headIdx = evs.findIndex((e, i) => i > 0 && e.type === 'system/message' && (e.surfaceOp ?? 'append') === 'append'
    && !evs.slice(1, i).some((x) => x.type === 'system/message'));
  if (headIdx < 0) return false;
  if (evs.slice(1, headIdx).some((e) => e.type === 'step/start')) return false;
  const head = evs[headIdx];
  const turn = Math.max(1, Number(head.data?.turn ?? 1));
  head.data.step = Math.max(1, Number(head.data?.step ?? 1));
  const step = head.data.step;
  const base = head.seq; // shift 后 head=base+2；step/start=base，step/end=base+1
  const at = { type: 'step/start', seq: base, time: head.time, data: { turn, step } };
  const tail = { type: 'step/end', seq: base + 1, time: head.time, data: { turn, step } };
  for (const e of evs) {
    if (typeof e.seq === 'number' && e.seq >= head.seq) e.seq += 2;
    const sh = (o) => {
      if (!o || typeof o !== 'object') return;
      if (typeof o.startSeq === 'number' && o.startSeq >= head.seq) o.startSeq += 2;
      if (typeof o.endSeq === 'number' && o.endSeq >= head.seq) o.endSeq += 2;
      if (Array.isArray(o.sourceEventSeqs)) o.sourceEventSeqs = o.sourceEventSeqs.map((v) => (typeof v === 'number' && v >= head.seq ? v + 2 : v));
      if (Array.isArray(o.messageSeqs)) o.messageSeqs = o.messageSeqs.map((v) => (typeof v === 'number' && v >= head.seq ? v + 2 : v));
      if (typeof o.headerSeq === 'number' && o.headerSeq >= head.seq) o.headerSeq += 2;
    };
    sh(e); sh(e.data); sh(e.surfaceOp); sh(e.data?.surfaceOp);
  }
  evs.splice(headIdx, 0, at);
  evs.splice(headIdx + 2, 0, tail);
  return true;
}

/** 行序重编号 seq=0..N-1 并重映射全部引用（对正确文件是恒等操作）；返回是否发生过变化 */
function renumberSeqs(evs) {
  const map = new Map();
  let next = 0;
  for (const e of evs.slice(1)) {
    if (e.seq !== next) map.set(e.seq, next);
    e.seq = next; next++;
  }
  if (!map.size) return false;
  const remap = (v) => (typeof v === 'number' && map.has(v) ? map.get(v) : v);
  for (const e of evs.slice(1)) {
    const sh = (o) => {
      if (!o || typeof o !== 'object') return;
      if (typeof o.startSeq === 'number') o.startSeq = remap(o.startSeq);
      if (typeof o.endSeq === 'number') o.endSeq = remap(o.endSeq);
      if (Array.isArray(o.sourceEventSeqs)) o.sourceEventSeqs = o.sourceEventSeqs.map(remap);
      if (Array.isArray(o.messageSeqs)) o.messageSeqs = o.messageSeqs.map(remap);
      if (typeof o.headerSeq === 'number') o.headerSeq = remap(o.headerSeq);
    };
    sh(e); sh(e.data); sh(e.surfaceOp); sh(e.data?.surfaceOp);
  }
  return true;
}

function fixTurnsAndTypes(lines) {
  const out = []; const stats = { turnFixed: 0, sysToUser: 0 };
  let maxTurn = 0; let curTurn = 0;
  let foldSurfaceLen = 0, foldHead = false; // fold 语义同步（决定 system 是否真违规）
  for (const raw of lines) {
    let ev;
    try { ev = JSON.parse(raw); } catch { die(`非 JSON 行: ${raw.slice(0, 80)}`); }
    const type = ev.type || (ev.data && ev.data.type);
    const setTurn = (t) => { if (ev.turn !== undefined) ev.turn = t; else if (ev.data) ev.data.turn = t; };
    const getTurn = () => ev.turn ?? ev.data?.turn;
    if (type === 'turn/start') {
      const t = getTurn();
      if (typeof t === 'number' && t <= maxTurn) { setTurn(++maxTurn); stats.turnFixed++; }
      else if (typeof t === 'number') maxTurn = t;
      curTurn = getTurn() ?? curTurn;
    } else {
      // 段内行跟随 curTurn（重编后的 turn/start 已抬高基准，旧 turn 需同步抬）；step 字段保留（v6 实测宿主接受）
      const t = getTurn();
      if (typeof t === 'number' && typeof curTurn === 'number' && t < curTurn) { setTurn(curTurn); stats.turnFixed++; }
    }
    // ② 违规 system/message → user/message 拉平（fold 语义：仅 surface 非空且无 protectedHead 时才是违规；
    //    合法头与已有头之后的合法 system 一律保留，字段问题交给 fixSystemFields）
    if (out.length > 0 && type === 'system/message' && foldSurfaceLen > 0 && !foldHead) {
      const d = ev.data ?? {};
      ev.type = 'user/message';
      if (ev.data) {
        const raw = d.content ?? d.message;
        const content = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray(raw.content)) ? raw.content : raw;
        ev.data = { id: d.id ?? d.message?.id ?? ev.id, role: 'user', source: { kind: 'user' }, content };
        // 注意：不携带 turn/step（原生 user/message 无这些字段，v5→v6 的关键修正）
      }
      stats.sysToUser++;
    }
    // fold 状态推进（用转换后的 type）
    {
      const t2 = ev.type || (ev.data && ev.data.type);
      if (SURFACE_TYPES.has(t2)) {
        if (t2 === 'system/message' && (ev.surfaceOp ?? 'append') === 'append' && foldSurfaceLen === 0) foldHead = true;
        foldSurfaceLen++;
      }
    }
    out.push(JSON.stringify(ev));
  }
  return { out, stats };
}

const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '--help' || !file) { console.log(usage); process.exit(cmd ? 0 : 2); }

let doc;
try { doc = openSession(file); } catch (e) { console.log(`FAIL: 文件无法解析（非 JSON 行或截断）: ${String(e.message).slice(0, 100)}`); process.exit(1); }
const lines = doc.rows.map((e) => JSON.stringify(e));

if (cmd === 'ensure-head') {
  const evs = doc.rows;
  const before = evs.length;
  const firstIsSystem = evs.some((e, i) => i > 0 && (e.type === 'user/message' || e.type === 'developer/message' || e.type === 'assistant/message' || e.type === 'tool/result' || e.type === 'system/message'));
  if (!firstIsSystem) { console.log('NO-SURFACE-SKIP（空壳会话，无需补头）'); process.exit(0); }
  const fieldsFixed = fixSystemFields(evs);
  const inserted = insertHead(evs);
  const win = ensureStepWindow(evs);
  const renum = renumberSeqs(evs);
  if (!inserted && !fieldsFixed && !win && !renum) { console.log('ALREADY-HEADED'); process.exit(0); }
  const outIdx = rest.indexOf('-o');
  const outFile = outIdx >= 0 ? rest[outIdx + 1] : file.replace(/\.zstd$/, '.headed.zstd');
  writeSession(outFile, evs);
  recordLedger({ tool: 'repair-v4-session:ensure-head', input: file, output: outFile, summary: `行数 ${before}→${evs.length}` });
  console.log(`ensure-head done: ${outFile}（行数 ${before}→${evs.length}）`);
  process.exit(0);
}

if (cmd === 'frames') {
  console.log(`${path.basename(file)}: bytes=${fs.statSync(file).size} frames=${doc.frames} lines=${lines.length}`);
  process.exit(0);
}

if (cmd === 'check') {
  // fold 语义（对齐 v4 relationships.ts）：system/message 仅当 surface 非空且无 protectedHead 时违规
  let bad = 0; let sysBad = 0; let fieldBad = 0; let seqBad = 0; let lastTurn = 0; let turnBack = 0; let surfaceLen = 0; let head = false; let lastSeq = null;
  lines.forEach((l, i) => {
    let ev; try { ev = JSON.parse(l); } catch { bad++; return; }
    if (i > 0 && typeof ev.seq === 'number') { if (lastSeq !== null && ev.seq !== lastSeq + 1) seqBad++; lastSeq = ev.seq; }
    const type = ev.type || (ev.data && ev.data.type);
    if (i > 0 && SURFACE_TYPES.has(type)) {
      if (type === 'system/message') {
        if (surfaceLen > 0 && !head) sysBad++;
        if (systemFieldBad(ev)) fieldBad++;
        if ((ev.surfaceOp ?? 'append') === 'append' && surfaceLen === 0) head = true;
      }
      surfaceLen++;
    }
    const t = ev.turn ?? ev.data?.turn;
    if (typeof t === 'number') { if (t < lastTurn) turnBack++; lastTurn = Math.max(lastTurn, t); }
  });
  console.log(`lines=${lines.length} badJson=${bad} badSystem=${sysBad} fieldBad=${fieldBad} seqBad=${seqBad} turnBacktracks=${turnBack} head=${head}`);
  console.log(bad ? 'FAIL: 存在非 JSON 行' : sysBad || fieldBad || seqBad ? 'NEEDS-REPAIR' : 'CLEAN');
  process.exit(bad ? 1 : 0);
}

if (cmd === 'fix') {
  const outIdx = rest.indexOf('-o');
  const outFile = outIdx >= 0 ? rest[outIdx + 1] : path.join(path.dirname(file), 'repaired-v9.zstd');
  // 先备份原始明文，防止覆盖
  fs.writeFileSync(outFile + '.plaintext.jsonl', lines.join('\n') + '\n');
  const { out, stats } = fixTurnsAndTypes(lines);
  const evs = out.map((l) => JSON.parse(l));
  stats.fieldsFixed = fixSystemFields(evs);
  const headed = insertHead(evs);
  if (headed) stats.headInserted = 1;
  if (ensureStepWindow(evs)) stats.stepWindowInserted = 1;
  if (renumberSeqs(evs)) stats.seqRenumbered = 1;
  writeSession(outFile, evs);
  recordLedger({ tool: 'repair-v4-session:fix', input: file, output: outFile, summary: `行数 ${lines.length}→${evs.length} | turn ${stats.turnFixed} | sys→user ${stats.sysToUser} | head ${stats.headInserted ?? 0} | seq ${stats.seqRenumbered ?? 0}` });
  fs.writeFileSync(outFile + '.fixed.jsonl', evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`fix done: ${outFile}`);
  console.log(`  行数 ${lines.length} | turn 修正 ${stats.turnFixed} 行 | system→user 转换 ${stats.sysToUser} 行`);
  console.log(`  原始明文留存: ${outFile}.plaintext.jsonl`);
  console.log(`  部署前务必在目标机用宿主同源 reader 验证（oracle.mjs + preflight-v4.mjs）`);
  process.exit(0);
}

die(`未知命令 ${cmd}；--help 看用法`);
