#!/usr/bin/env node
// watch-member-sessions.mjs — 会话守卫 v3（2026-11-14 起在 .223 计划任务每 15 分钟跑）
// 变化 vs v2：判定对齐 v4 校验器 fold 语义（system/message 仅当 surface 非空且无
// protectedHead 时违规——首头 system 是合法且必需的，v2 会误伤）；新增「CLEAN 但无头」
// 的冷会话补头升级（ensure-head，建 protectedHead 后永不复发）。
// 只碰冷会话（不在 a2a state 里的），修复/补头前备份 .guard-<epoch>；修复后再体检，不过则保留原件。
// 单进程内联巡检（不逐文件 spawn node——.223 内存紧张）；修复/补头时才 spawn 工具。
// 环境：A2A_STATE_URL（默认本机 13080）、SESSIONS_ROOT（默认 ~/.dsh/sessions）、SESSION_GUARD_LOG。
import { execFileSync } from 'node:child_process';
import { readdirSync, renameSync, copyFileSync, existsSync, appendFileSync } from 'node:fs';
import { recordLedger } from '../lib/ledger.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { frameEnd, SURFACE_TYPES } from '../lib/v4-file.mjs';

const HOME = process.env.USERPROFILE || process.env.HOME;
const SESSIONS_ROOT = process.env.SESSIONS_ROOT || join(HOME, '.dsh', 'sessions');
const REPAIR = join(import.meta.dirname, '..', 'bin', 'repair-v4-session.mjs');
const LOG = process.env.SESSION_GUARD_LOG || join(HOME, 'session-guard', 'guard.log');
const STATE_URL = process.env.A2A_STATE_URL || 'http://127.0.0.1:13080/__dsh_a2a/state';
const NODE = process.execPath;
const SURFACE = SURFACE_TYPES;

function log(line) {
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`); } catch { }
}

function decompressAll(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const parts = []; let i = 0;
  while (i < buf.length) {
    if (buf.subarray(i, i + 4).equals(magic)) { const e = frameEnd(buf, i); parts.push(zstdDecompressSync(buf.subarray(i, e))); i = e; }
    else if (i + 8 <= buf.length && buf.readUInt32BE(i) >= 0x184d2a50 && buf.readUInt32BE(i) <= 0x184d2a5f) i += 8 + buf.readUInt32LE(i + 4);
    else throw new Error(`frame boundary @${i}`);
  }
  return Buffer.concat(parts);
}

/** fold 体检：{ badSystem, fieldBad, hasSurface, head, seqBad } —— 任一非零需修 */
function inspect(buf) {
  let plain;
  try { plain = decompressAll(buf); } catch { return null; } // 解不开不归本守卫管
  const lines = plain.toString('utf8').split('\n');
  let surfaceLen = 0, head = false, badSystem = 0, fieldBad = 0, seqBad = 0, lastSeq = null;
  for (let i = 1; i < lines.length; i++) { // 跳过 header（i=0）
    const l = lines[i].trim();
    if (!l) continue;
    let ev; try { ev = JSON.parse(l); } catch { continue; }
    if (typeof ev.seq === 'number') { if (lastSeq !== null && ev.seq !== lastSeq + 1) seqBad++; lastSeq = ev.seq; }
    const t = ev.type || (ev.data && ev.data.type);
    if (!SURFACE.has(t)) continue;
    if (t === 'system/message') {
      if (surfaceLen > 0 && !head) badSystem++;
      const d = ev.data ?? {}, m = d.message ?? {};
      const srcBad = !m.source || typeof m.source !== 'string' && (typeof m.source !== 'object' || typeof m.source.kind !== 'string' || m.source.kind.length === 0 || m.source.kind === 'plugin');
      if (!(Number(d.step) >= 1) || typeof m.id !== 'string' || m.id.length === 0 || srcBad) fieldBad++;
      if ((ev.surfaceOp ?? 'append') === 'append' && surfaceLen === 0) head = true;
    }
    surfaceLen++;
  }
  return { badSystem, fieldBad, seqBad, hasSurface: surfaceLen > 0, head };
}

function liveIds() {
  try {
    const out = execFileSync('curl', ['-s', '-m', '8', STATE_URL], { encoding: 'utf8' });
    const j = JSON.parse(out);
    return new Set((j.sessions || []).map((s) => (s.id || '').replace(/^session-/, '').slice(0, 8)));
  } catch { return null; }
}

const live = liveIds();
if (live === null) { log('state 不可达，跳过本轮'); process.exit(0); }

let scanned = 0, repaired = 0, headed = 0;
for (const ws of readdirSync(SESSIONS_ROOT)) {
  const wsDir = join(SESSIONS_ROOT, ws);
  let dirs;
  try { dirs = readdirSync(wsDir).filter((d) => d.startsWith('session-')); } catch { continue; }
  for (const d of dirs) {
    const f = join(wsDir, d, 'session.v4.jsonl.zstd');
    if (!existsSync(f)) continue;
    const id8 = d.replace(/^session-/, '').slice(0, 8);
    scanned++;
    if (live.has(id8)) continue;
    let st;
    try { st = inspect(readFileSync(f)); } catch { continue; }
    if (!st) continue;
    if (!st.hasSurface) continue; // 空壳会话：未来 system append 落空 surface 本就合法，无需补头
    if (!st.badSystem && !st.fieldBad && !st.seqBad && st.head) continue; // 完好且已免疫
    const mode = (st.badSystem || st.fieldBad || st.seqBad) ? 'fix' : 'ensure-head';
    if (!existsSync(f)) continue; // 防竞态：会话正被删除
    const out = join(wsDir, d, st.badSystem ? 'guardfix.zstd' : 'guardhead.zstd');
    try {
      execFileSync(NODE, [REPAIR, mode, f, '-o', out], { encoding: 'utf8', timeout: 120000 });
      const after = inspect(readFileSync(out));
      if (!after || after.badSystem || after.fieldBad || after.seqBad || !after.head) { log(`${id8} ${mode} 后校验不过，保留原件`); renameSync(out, out + '.bad'); continue; }
      const bak = `${f}.guard-${Date.now()}`;
      copyFileSync(f, bak);
      renameSync(out, f);
      recordLedger({ tool: 'guard:swap', input: f, output: f, backup: bak, summary: `${mode} in-place（备份 ${bak.split(/[\\/]/).pop()}）` });
      if (st.badSystem || st.fieldBad || st.seqBad) { repaired++; log(`${id8} 自动修复（badSystem=${st.badSystem} fieldBad=${st.fieldBad} seqBad=${st.seqBad}）；备份 ${bak.split(/[\\/]/).pop()}`); }
      else { headed++; log(`${id8} 补头升级（CLEAN 无 protectedHead → 免疫）；备份 ${bak.split(/[\\/]/).pop()}`); }
    } catch (e) {
      log(`${id8} ${mode} 失败: ${String(e.message).split('\n')[0].slice(0, 120)}`);
    }
  }
}
log(`v3 巡检 ${scanned}，修复 ${repaired}，补头 ${headed}，live ${live.size}`);
