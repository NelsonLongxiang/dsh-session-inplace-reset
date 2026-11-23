// 全量分诊扫描：扫一个主机的全部 v4 会话，逐件跑快检（轮机＋区间对），分诊报告。
// 用法：node repair/bin/sweep.mjs [--root <dir>] [--gates] [--json] [file…]
//   --root   会话根目录（默认 $SESSIONS_ROOT 或 ~/.dsh/sessions），只收 */session-*/session.v4.jsonl.zstd
//   --gates  加跑慢门：oracle＋preflight（需 DSH_FORMAT_LIB；大文件耗时分钟级）
//   file…    直接点名文件（跳过目录遍历）
// 输出：每件一行 `短id 判定 [细节]`＋末尾汇总；rc=0 全健康（含合法尾部开放轮），rc=2 有病，rc=1 用法错。
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('.', import.meta.url));

function sh(tool, ...args) {
  try { return { rc: 0, out: execFileSync('node', [join(BIN, tool), ...args], { encoding: 'utf8' }) }; }
  catch (e) { return { rc: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

// 轮机判定的输出 → 病种归类
function classifyTurn(out) {
  const m = out.match(/CORRUPT: turn\/start seq=\d+ got=(\d+) expect=(\d+)/);
  if (m) return { verdict: 'SICK', layer: 'turn-rewind', detail: `seq 回退 expect=${m[2]} got=${m[1]}`, tool: 'fix-turn-rewind.mjs fix' };
  if (/seq gap at seq=/.test(out)) return { verdict: 'SICK', layer: 'seq-gap', detail: out.match(/seq gap at seq=\d+ \(last=\d+\)/)?.[0] ?? '', tool: '人工：推编号代数后平移（README 换件纪律）' };
  if (/forward jump/.test(out)) return { verdict: 'SICK', layer: 'turn-forward-jump', detail: out.match(/forward jump at seq=\d+ [^\n]*/)?.[0] ?? '', tool: '人工：前向跳号另判' };
  if (/file ends with open turn/.test(out)) return { verdict: 'NOTE', layer: 'trailing-open-turn', detail: '合法形态（进程中断残留），装载器认；换件时留意接缝' };
  if (/while turn \d+ still open|turn\/end seq=|without data\.turn/.test(out)) return { verdict: 'SICK', layer: 'turn-machine', detail: out.match(/FIX-ABORT: [^\n]*/)?.[0] ?? '', tool: '人工：轮机异常另判' };
  return { verdict: 'SICK', layer: 'unreadable', detail: out.split('\n')[0].slice(0, 120), tool: '人工' };
}
function classifyGates(oracle, preflight) {
  if (oracle.rc !== 0) {
    const kind = /REL-FAIL/.test(oracle.out) ? 'relationships' : /ADMIT-FAIL/.test(oracle.out) ? 'admission' : 'header';
    return { verdict: 'SICK', layer: `oracle-${kind}`, detail: oracle.out.split('\n')[0].slice(0, 140), tool: '对照 repair/README.md 病征速查' };
  }
  if (preflight.rc !== 0) {
    const o = preflight.out;
    let layer = 'persistence';
    if (/image\/offload/.test(o)) layer = /target seq/.test(o) ? 'offload-target' : 'offload-orphan';
    else if (/sourceEventSeqs ranges/.test(o)) layer = 'seqs-duplicate';
    else if (/seq gap/.test(o)) layer = 'seq-gap';
    else if (/shadowedSeqs/.test(o)) layer = 'compaction-span';
    return { verdict: 'SICK', layer, detail: o.split('\n')[0].slice(0, 140), tool: layer === 'offload-orphan' ? 'prune-events.mjs（先审计确认孤儿）' : '对照 repair/README.md 病征速查' };
  }
  return null;
}

const argv = process.argv.slice(2);
const gates = argv.includes('--gates');
const json = argv.includes('--json');
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; if (!v || v.startsWith('--')) return undefined; argv.splice(i, 2); return v; };
const root = flag('--root') ?? process.env.SESSIONS_ROOT ?? join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'sessions');
const files = argv.filter(a => !a.startsWith('--'));

if (!files.length) {
  files.push(...readdirSync(root).flatMap(ws => {
    const wsDir = join(root, ws);
    try { return readdirSync(wsDir).filter(d => d.startsWith('session-')).map(d => join(wsDir, d, 'session.v4.jsonl.zstd')); }
    catch { return []; }
  }).filter(f => { try { return statSync(f).isFile(); } catch { return false; } }));
}
if (!files.length) { console.error(`sweep: ${root} 下没有 v4 会话文件`); process.exit(1); }

const results = [];
for (const f of files) {
  const id8 = (f.match(/session-([0-9a-f]{8})/)?.[1]) ?? f;
  let r;
  const turn = sh('fix-turn-rewind.mjs', 'check', f);
  if (turn.rc === 0 && /OK: /.test(turn.out)) {
    r = { verdict: 'OK', layer: null, detail: turn.out.match(/(\d+) events/)?.[1] + ' events' };
    const ranges = sh('fix-surface-ranges.mjs', 'check', f);
    if (ranges.rc !== 0 || /RANGES: /.test(ranges.out)) r = { verdict: 'SICK', layer: 'nested-ranges', detail: ranges.out.split('\n')[0].slice(0, 140), tool: 'fix-surface-ranges.mjs fix' };
  } else r = classifyTurn(turn.out);
  if (r.verdict !== 'SICK' && gates) {
    const g = classifyGates(sh('oracle.mjs', f), sh('preflight-v4.mjs', f));
    if (g) r = g; else if (r.verdict === 'OK') r.detail += '；oracle+preflight PASS';
  }
  results.push({ file: f, id8, ...r });
}

if (json) console.log(JSON.stringify(results, null, 2));
else {
  for (const r of results) console.log(`${r.id8}  ${r.verdict === 'OK' ? 'HEALTHY' : r.verdict === 'NOTE' ? 'NOTE   ' : 'SICK   '}  ${r.layer ?? ''}${r.detail ? `  ${r.detail}` : ''}${r.tool ? `  → ${r.tool}` : ''}`);
  const sick = results.filter(r => r.verdict === 'SICK').length;
  const note = results.filter(r => r.verdict === 'NOTE').length;
  console.log(`\nsweep: ${results.length} 件｜健康 ${results.length - sick - note}｜合法形态 ${note}｜有病 ${sick}${gates ? '｜含 oracle+preflight 慢门' : ''}（快检；--gates 加慢门）`);
}
process.exit(results.some(r => r.verdict === 'SICK') ? 2 : 0);
