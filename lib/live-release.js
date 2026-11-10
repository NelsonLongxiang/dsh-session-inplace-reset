import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function assertSessionId(id) {
  if (typeof id !== 'string' || !/^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new TypeError('无效的会话 ID');
}

/** Preserve the source under a unique quarantine path; rollback never overwrites newer files. */
export function quarantineEntities(home, sessionId, operationId = randomUUID()) {
  assertSessionId(sessionId);
  if (!/^[a-z0-9-]+$/i.test(operationId)) throw new TypeError('无效的操作 ID');
  home = resolve(home);
  const quarantine = join(home, 'session-reset', 'quarantine', operationId);
  if (existsSync(quarantine)) throw new Error('隔离目录已存在，未覆盖');
  const entries = [];
  const root = join(home, 'sessions');
  if (existsSync(root)) for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (bucket.isSymbolicLink()) throw new Error('会话存储含链接，未修改存储');
    if (!bucket.isDirectory()) continue;
    const source = join(root, bucket.name, sessionId);
    if (existsSync(source)) entries.push({ source, destination: join(quarantine, 'sessions', bucket.name, sessionId) });
  }
  if (entries.length > 1) throw new Error('同 ID 存在多个会话实体，未修改存储');
  for (const [source, destination] of [
    [join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), join(quarantine, 'projcache', `${sessionId}.json`)],
    [join(home, 'rewind-snapshots', sessionId), join(quarantine, 'rewind-snapshots', sessionId)],
  ]) if (existsSync(source)) entries.push({ source, destination });
  if (entries.some(({ source }) => lstatSync(source).isSymbolicLink())) throw new Error('目标实体为链接，未修改存储');
  mkdirSync(quarantine, { recursive: true });
  writeFileSync(join(quarantine, 'manifest.json'), JSON.stringify({ sessionId, entries }), { encoding: 'utf8', flag: 'wx' });
  const moved = [];
  try {
    for (const entry of entries) {
      mkdirSync(resolve(entry.destination, '..'), { recursive: true });
      renameSync(entry.source, entry.destination);
      moved.push(entry);
    }
  } catch (error) {
    for (const entry of moved.reverse()) {
      if (existsSync(entry.source)) throw new Error(`隔离失败且原位有新文件，请人工恢复：${quarantine}`, { cause: error });
      renameSync(entry.destination, entry.source);
    }
    throw error;
  }
  return { quarantine, moved: entries.map(({ source }) => source) };
}

export function restoreFromQuarantine(home, quarantine, sessionId) {
  assertSessionId(sessionId);
  const root = resolve(home, 'session-reset', 'quarantine');
  if (relative(root, resolve(quarantine)).startsWith('..') || resolve(quarantine) === root) throw new Error('隔离目录越界');
  const manifest = JSON.parse(readFileSync(join(quarantine, 'manifest.json'), 'utf8'));
  if (manifest.sessionId !== sessionId) throw new Error('隔离记录不属于目标会话');
  for (const { source, destination } of manifest.entries) {
    if (relative(resolve(home), resolve(source)).startsWith('..') || relative(resolve(quarantine), resolve(destination)).startsWith('..')) throw new Error('隔离记录路径越界');
    if (existsSync(source)) throw new Error('原位已有文件，回退未覆盖');
    if (!existsSync(destination)) throw new Error('隔离实体不完整，回退已停止');
  }
  for (const { source, destination } of manifest.entries) {
    mkdirSync(resolve(source, '..'), { recursive: true });
    renameSync(destination, source);
  }
  return manifest.entries.map(({ source }) => source);
}
