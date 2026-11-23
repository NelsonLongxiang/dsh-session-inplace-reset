// 官方 v4 校验器封装（结构层）：header + relationships（fold 语义）+ 逐行 admission。
// 覆盖不到的：persistence 扫描层（seq 连续 / sourceEventSeqs 区间与唯一 / 逐行解码）→ 用 preflight-v4.mjs。
// 用法：node bin/oracle.mjs <file.zstd> [更多…]；或 import { oracle }。
import { loadDsh } from '../lib/dsh-lib.mjs';
import { openSession } from '../lib/v4-file.mjs';

const m = await loadDsh();

export function oracle(f, label) {
  const rows = openSession(f).rows;
  const header = { ...rows[0] }; delete header.type;
  const events = rows.slice(1);
  try { m.assertReleasedV4Header(header); } catch (e) { return `${label} HEADER-FAIL: ${e.message}`; }
  try { m.assertReleasedV4Relationships({ header, inheritedEventCount: 0, events }, new Set(events.map(e => e.type))); } catch (e) { return `${label} REL-FAIL: ${e.message.slice(0, 140)}`; }
  for (const ev of events) {
    try { m.assertV4RowAdmission(ev); } catch (e) { return `${label} ADMIT-FAIL seq ${ev.seq ?? '?'} ${ev.type}: ${e.message.slice(0, 140)}`; }
  }
  return `${label} ORACLE-PASS (${events.length} events)`;
}

// 作为 CLI 直接运行时
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const r = oracle(f, f);
    console.log(r);
    if (!r.includes('ORACLE-PASS')) bad++;
  }
  process.exit(bad ? 2 : 0);
}
