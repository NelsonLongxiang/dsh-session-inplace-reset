import { Session as InspectorSession } from 'node:inspector';
import { performance } from 'node:perf_hooks';
import { assertSessionId } from './session-id.ts';

export interface MemoryCleanup { queryEntries: number; persistenceEntries: number; pinnedSessions: string[]; warnings: string[] }
export interface ResetMemoryReport extends MemoryCleanup {
  pid: number; before: NodeJS.MemoryUsage; after: NodeJS.MemoryUsage;
  gcCompleted: boolean; durationMs: number;
}

/** Version-bounded read-cache adapter: evicts only the just-reset source and its verified fork; never touches files or writers. */
export function evictResetReadCaches(ctx: { get(name: string): any }, ids: readonly string[], symbols: { original: symbol }): MemoryCleanup {
  const result: MemoryCleanup = { queryEntries: 0, persistenceEntries: 0, pinnedSessions: [], warnings: [] };
  const targets = [...new Set(ids)];
  targets.forEach(assertSessionId);
  const raw = (value: any) => value?.[symbols.original] ?? value;
  const query = raw(ctx.get('sessionQuery'));
  const persistence = raw(ctx.get('sessionPersistence'));
  const queryCache = query?._observations?.cache;
  const parsedCache = persistence?.coldLogMemo;
  if (!(queryCache instanceof Map)) result.warnings.push('宿主查询缓存布局不受支持，未改动该缓存');
  else for (const id of targets) {
    const entry = queryCache.get(id);
    if (entry === undefined) continue;
    if (entry?.session?.header?.id !== id || !Array.isArray(entry.events) || !Number.isSafeInteger(entry.refs) || entry.refs < 0) { result.warnings.push(`查询缓存身份不可校验：${id}`); continue; }
    if (entry.refs > 0) { result.pinnedSessions.push(id); continue; }
    queryCache.delete(id); result.queryEntries++;
  }
  if (!(parsedCache instanceof Map)) result.warnings.push('宿主持久化解码缓存布局不受支持，未改动该缓存');
  else for (const id of targets) {
    const entry = parsedCache.get(id);
    if (entry === undefined) continue;
    if (entry?.meta?.id !== id || entry.status !== 'current' || !Array.isArray(entry.events)) { result.warnings.push(`持久化缓存身份或格式不可校验：${id}`); continue; }
    parsedCache.delete(id); result.persistenceEntries++;
  }
  if (result.pinnedSessions.length) result.warnings.push('仍有读取者持有旧观察，相关缓存暂未释放');
  return result;
}

/** Runs after the transaction promise has settled so old backup/event locals can become unreachable. No inspector port is opened. */
export async function reclaimResetMemory(ctx: { get(name: string): any }, ids: readonly string[], symbols: { original: symbol }, before = process.memoryUsage()): Promise<ResetMemoryReport> {
  const started = performance.now();
  let cleanup: MemoryCleanup;
  try { cleanup = evictResetReadCaches(ctx, ids, symbols); }
  catch { cleanup = { queryEntries: 0, persistenceEntries: 0, pinnedSessions: [], warnings: ['重置已完成，缓存清理未能执行'] }; }
  await new Promise((resolve) => setImmediate(resolve));
  let gcCompleted = false;
  const inspector = new InspectorSession();
  try {
    inspector.connect();
    await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', (error) => error ? reject(error) : resolve()));
    gcCompleted = true;
  } catch { cleanup.warnings.push('显式垃圾回收不可用；等待运行时自然回收'); }
  finally { inspector.disconnect(); }
  return { ...cleanup, pid: process.pid, before, after: process.memoryUsage(), gcCompleted, durationMs: Math.round(performance.now() - started) };
}
