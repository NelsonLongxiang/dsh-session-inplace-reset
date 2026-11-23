// v4 会话「持久层」预检——逐行复刻 dsh-session-persistence-jsonl 的 SessionLogScanner.consumeEventLine
// （assertV4RowAdmission + catalog.createRestore(recovery:strict).decodeRow），补 oracle 覆盖不到的
// 逐行装载校验（seq gap / sourceEventSeqs 区间与唯一性 / 行级解码）。
// 用法：node bin/preflight-v4.mjs <session.v4.jsonl.zstd> [更多文件…]
// 输出：每文件 PREFLIGHT-PASS(n events) 或首失败行号+原因（与装载红字同源）。
import { loadDsh } from '../lib/dsh-lib.mjs';
import { openSession } from '../lib/v4-file.mjs';

const m = await loadDsh();

let bad = 0;
for (const file of process.argv.slice(2)) {
  const rows = openSession(file).rows;
  const events = rows.slice(1);
  try {
    const restore = m.sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'transformed' });
    let n = 0;
    for (const ev of events) {
      n += 1;
      try {
        m.assertV4RowAdmission(ev, m.KNOWN_SESSION_EVENT_TYPES);
        restore.decodeRow(ev);
      } catch (e) {
        throw new Error(`line ${n}: ${e.message}`);
      }
    }
    restore.finish?.();
    console.log(`${file} PREFLIGHT-PASS (${events.length} events)`);
  } catch (e) {
    bad += 1;
    console.log(`${file} PREFLIGHT-FAIL: ${String(e.message).slice(0, 160)}`);
  }
}
process.exit(bad ? 2 : 0);
