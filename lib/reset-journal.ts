import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { assertSessionId } from './session-id.ts';

type Phase = 'prepared' | 'quarantining' | 'quarantined' | 'rebuilding' | 'recovering' | 'recovery_required' | 'committed' | 'recovered';
interface Fingerprint { sha256: string; bytes: number; files: number }
interface Entry { path: string; original: Fingerprint }
interface Manifest { format: 1; operationId: string; sessionId: string; backupId: string; createdAt: string; entries: Entry[] }
interface JournalEvent { operationId: string; sequence: number; phase: Phase; at: string; detail?: unknown }
const operationPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const phases: Phase[] = ['prepared', 'quarantining', 'quarantined', 'rebuilding', 'recovering', 'recovery_required', 'committed', 'recovered'];
const terminal = (phase: Phase) => phase === 'committed' || phase === 'recovered';
const slash = (value: string) => value.replace(/\\/g, '/');

function noLinks(root: string, path: string) {
  const rel = relative(root, path);
  if (rel.startsWith('..') || resolve(root, rel) !== resolve(path)) throw new Error('事务路径越界');
  let current = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('事务路径含链接，未修改原件');
  }
}
function durableNew(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error('事务记录已存在，未覆盖');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temporary, path);
}
function allowedPath(path: string, sessionId: string) {
  const parts = path.split('/');
  return (parts.length === 3 && parts[0] === 'sessions' && parts[1] !== '..' && parts[1] !== '.' && !!parts[1] && parts[2] === sessionId)
    || path === `storages/session_projcache/sessions/${sessionId}.json` || path === `rewind-snapshots/${sessionId}`;
}
export function sessionEntities(home: string, sessionId: string): string[] {
  assertSessionId(sessionId);
  const paths: string[] = [];
  const root = join(home, 'sessions');
  if (existsSync(root)) for (const bucket of readdirSync(root, { withFileTypes: true })) {
    if (bucket.isSymbolicLink()) throw new Error('会话目录含链接，未修改存储');
    if (bucket.isDirectory() && existsSync(join(root, bucket.name, sessionId))) paths.push(slash(relative(home, join(root, bucket.name, sessionId))));
  }
  if (paths.length > 1) throw new Error('同ID存在多个日志实体，未修改存储');
  for (const path of [`storages/session_projcache/sessions/${sessionId}.json`, `rewind-snapshots/${sessionId}`]) if (existsSync(join(home, path))) paths.push(path);
  for (const path of paths) noLinks(home, join(home, path));
  return paths;
}
export async function fingerprint(path: string): Promise<Fingerprint> {
  const hash = createHash('sha256');
  let bytes = 0, files = 0;
  async function visit(current: string, name: string): Promise<void> {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error('原件含链接，未读取目标');
    if (info.isDirectory()) {
      hash.update(JSON.stringify(['directory', name]));
      for (const child of readdirSync(current).sort()) await visit(join(current, child), `${name}/${child}`);
    } else if (info.isFile()) {
      hash.update(JSON.stringify(['file', name, info.size]));
      for await (const chunk of createReadStream(current)) hash.update(chunk);
      const after = lstatSync(current);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('校验期间原件变化，已停止');
      bytes += info.size; files++;
    } else throw new Error('原件不是普通文件或目录');
  }
  await visit(path, '');
  return { sha256: hash.digest('hex'), bytes, files };
}
async function matches(path: string, original: Fingerprint): Promise<boolean> {
  return existsSync(path) && (await fingerprint(path)).sha256 === original.sha256;
}

export class ResetJournal {
  readonly directory: string;
  readonly quarantine: string;
  readonly home: string;
  readonly manifest: Manifest;
  private constructor(home: string, manifest: Manifest) {
    this.home = home;
    this.manifest = manifest;
    this.directory = join(home, 'session-reset/transactions', manifest.operationId);
    this.quarantine = join(home, 'session-reset/quarantine', manifest.operationId);
  }
  static async create(home: string, sessionId: string, operationId: string, backupId: string) {
    home = resolve(home); assertSessionId(sessionId); assertSessionId(backupId);
    if (!operationPattern.test(operationId)) throw new Error('无效的操作ID');
    const paths = sessionEntities(home, sessionId);
    if (!paths.some((path) => path.startsWith('sessions/'))) throw new Error('未找到原日志实体，未隔离');
    const entries = [];
    for (const path of paths) entries.push({ path, original: await fingerprint(join(home, path)) });
    const journal = new ResetJournal(home, { format: 1, sessionId, operationId, backupId, createdAt: new Date().toISOString(), entries });
    noLinks(home, journal.directory); noLinks(home, journal.quarantine);
    if (existsSync(journal.directory) || existsSync(journal.quarantine)) throw new Error('操作目录已存在，未覆盖');
    const staging = join(home, 'session-reset/transactions', `.staging-${operationId}`);
    noLinks(home, staging);
    if (existsSync(staging)) throw new Error('事务暂存目录已存在');
    durableNew(join(staging, 'manifest.json'), journal.manifest);
    renameSync(staging, journal.directory);
    return journal;
  }
  static load(home: string, operationId: string): ResetJournal {
    home = resolve(home);
    if (!operationPattern.test(operationId)) throw new Error('无效的操作ID');
    const directory = join(home, 'session-reset/transactions', operationId);
    noLinks(home, join(directory, 'manifest.json'));
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Manifest;
    assertSessionId(manifest.sessionId); assertSessionId(manifest.backupId);
    if (manifest.format !== 1 || manifest.operationId !== operationId || !Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error('事务清单无效');
    const unique = new Set();
    for (const entry of manifest.entries) {
      if (typeof entry.path !== 'string' || !allowedPath(entry.path, manifest.sessionId) || entry.path.includes('\\') || unique.has(entry.path) || !/^[0-9a-f]{64}$/.test(entry.original?.sha256)) throw new Error('事务清单路径或摘要无效');
      unique.add(entry.path);
    }
    if (manifest.entries.filter((entry) => entry.path.startsWith('sessions/')).length !== 1) throw new Error('事务日志实体不唯一');
    const journal = new ResetJournal(home, manifest);
    noLinks(home, journal.quarantine);
    journal.events();
    return journal;
  }
  events(): JournalEvent[] {
    const root = join(this.directory, 'events');
    noLinks(this.home, root);
    if (!existsSync(root)) return [];
    const result: JournalEvent[] = [];
    for (const name of readdirSync(root).filter((name) => name.endsWith('.json')).sort()) {
      noLinks(this.home, join(root, name));
      const event = JSON.parse(readFileSync(join(root, name), 'utf8')) as JournalEvent;
      if (event.operationId !== this.manifest.operationId || event.sequence !== result.length + 1 || !phases.includes(event.phase) || (result.length && terminal(result.at(-1)!.phase))) throw new Error('事务事件链无效');
      result.push(event);
    }
    return result;
  }
  phase(): Phase { return this.events().at(-1)?.phase ?? 'prepared'; }
  record(phase: Phase, detail?: unknown) {
    const events = this.events();
    if (events.length && terminal(events.at(-1)!.phase)) throw new Error('事务已终结，未重复执行');
    const sequence = events.length + 1;
    durableNew(join(this.directory, 'events', `${String(sequence).padStart(8, '0')}-${randomUUID()}.json`), { operationId: this.manifest.operationId, sequence, phase, at: new Date().toISOString(), detail });
  }
  async quarantineOriginal() {
    this.record('quarantining');
    for (const entry of this.manifest.entries) {
      const source = join(this.home, entry.path), target = join(this.quarantine, 'original', entry.path);
      noLinks(this.home, source); noLinks(this.home, target);
      if (!(await matches(source, entry.original)) || existsSync(target)) throw new Error('隔离前原件变化或目标冲突');
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
      this.record('quarantining', { moved: entry.path });
    }
    this.record('quarantined');
  }
  async restoreOriginal() {
    if (terminal(this.phase())) throw new Error('该事务已经完成，不重复恢复');
    // Discover actual file locations: an interruption may occur between a rename and its event.
    for (const entry of this.manifest.entries) {
      const source = join(this.home, entry.path), original = join(this.quarantine, 'original', entry.path);
      noLinks(this.home, source); noLinks(this.home, original);
      if (!(await matches(source, entry.original)) && !(await matches(original, entry.original))) throw new Error('原件不完整或摘要不符，已保留所有代际并停止恢复');
    }
    this.record('recovering');
    const preservation = join(this.quarantine, 'preserved', randomUUID());
    for (const path of sessionEntities(this.home, this.manifest.sessionId)) {
      const entry = this.manifest.entries.find((entry) => entry.path === path);
      if (entry && await matches(join(this.home, path), entry.original)) continue;
      const target = join(preservation, path);
      noLinks(this.home, target);
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) throw new Error('保全目标已存在，未覆盖');
      renameSync(join(this.home, path), target);
      this.record('recovering', { preserved: path, generation: preservation });
    }
    for (const entry of this.manifest.entries) {
      const source = join(this.home, entry.path), original = join(this.quarantine, 'original', entry.path);
      if (await matches(source, entry.original)) continue;
      if (existsSync(source) || !(await matches(original, entry.original))) throw new Error('恢复路径冲突，原件未覆盖');
      mkdirSync(dirname(source), { recursive: true });
      renameSync(original, source);
      this.record('recovering', { restored: entry.path });
    }
    for (const entry of this.manifest.entries) if (!(await matches(join(this.home, entry.path), entry.original))) throw new Error('恢复后的原件独立校验失败');
    this.record('recovered', { preservation });
    return { preservation, originalVerified: true };
  }
}

export function listRecoveryStatus(home: string) {
  const root = resolve(home, 'session-reset/transactions');
  noLinks(resolve(home), root);
  const operations: { operationId: string; sessionId: string; backupId: string; phase: Phase; createdAt: string }[] = [];
  const issues: string[] = [];
  if (existsSync(root)) for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!operationPattern.test(entry.name)) continue;
    try {
      const journal = ResetJournal.load(home, entry.name);
      const phase = journal.phase();
      if (!terminal(phase)) operations.push({ operationId: entry.name, sessionId: journal.manifest.sessionId, backupId: journal.manifest.backupId, phase, createdAt: journal.manifest.createdAt });
    } catch { issues.push(`事务 ${entry.name} 的记录不可校验，未自动修改原件`); }
  }
  return { operations, issues };
}
export function recoveryStatus(home: string, sessionId: string) {
  assertSessionId(sessionId);
  const all = listRecoveryStatus(home);
  return { sessionId, operations: all.operations.filter((operation) => operation.sessionId === sessionId), issues: all.issues };
}
