// 修复台账：每次实际写盘的修理动作追加一行 JSONL，替代 OPS 手记。
// 位置：$DSH_REPAIR_LEDGER，默认 ~/.dsh/session-repair/ledger.jsonl（与宿主 DSH_HOME 同根）。
// 只记 check 不动盘；追加失败只告警，绝不影响修复本身。
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function ledgerPath() {
  return process.env.DSH_REPAIR_LEDGER ?? join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'session-repair', 'ledger.jsonl');
}

/** @param {{ tool: string; input: string; output: string; summary?: string; backup?: string; extra?: Record<string, unknown> }} entry */
export function recordLedger(entry) {
  const file = ledgerPath();
  let bytes = null;
  try { bytes = statSync(entry.output).size; } catch { /* 输出已改名（守卫换件）时大小由后续条目补记 */ }
  const row = { at: new Date().toISOString(), tool: entry.tool, input: entry.input, output: entry.output, bytes, ...(entry.summary ? { summary: entry.summary } : {}), ...(entry.backup ? { backup: entry.backup } : {}), ...(entry.extra ?? {}) };
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, JSON.stringify(row) + '\n');
  } catch (error) { console.error(`ledger: 台账追加失败（不影响修复）：${error.message}`); }
  return row;
}
