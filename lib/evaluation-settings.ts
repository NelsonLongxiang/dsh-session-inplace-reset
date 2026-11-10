import { createHash } from 'node:crypto';
import { DEFAULT_API_BASE, legacyConnection } from './decision-model.ts';
import type { EvaluationConnection } from './decision-model.ts';

type ApiKeyRecord = { kind: 'api-key'; key?: string; env?: Readonly<Record<string, string>> };
type StoredRecord = ApiKeyRecord | { kind: 'grant'; payload: unknown };
export interface CredentialStore {
  readRecord(key: string): Promise<StoredRecord | undefined>;
  describeRecord(key: string): Promise<{ writable: boolean }>;
  modifyRecord(key: string, mutate: (record: StoredRecord | undefined) => Promise<StoredRecord | undefined>): Promise<StoredRecord | undefined>;
}
export interface EvaluationSettingsView { apiBase: string; configured: boolean; hasSavedKey: boolean; usingDefault: boolean; writable: boolean }
export interface EvaluationSettingsWrite { apiBase: string; apiKey?: string }
const BASE_FIELD = 'DSH_EVALUATION_API_BASE';

export function normalizeApiBase(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('请填写有效的 API Base');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('API Base 需要包含 http:// 或 https://'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API Base 仅支持 HTTP(S)，不能包含凭证、查询参数或片段');
  if (url.pathname === '/') url.pathname = '/v4/ai/evaluation-model';
  else url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function apiKeyRecord(record: StoredRecord | undefined): ApiKeyRecord | undefined {
  if (record && record.kind !== 'api-key') throw new Error('现有评估凭证格式不兼容，未覆盖保存内容');
  return record;
}

/** One atomic credential record holds the endpoint and key; the reference is scoped to the current DSH profile. */
export function createEvaluationSettings(store: CredentialStore | undefined, profile: string, changed: () => void = () => {}, fallback = legacyConnection) {
  const address = `session-reset-inplace/evaluation-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}`;
  async function connection(): Promise<EvaluationConnection & { cacheKey: string }> {
    const record = apiKeyRecord(await store?.readRecord(address));
    const value = record ? { apiBase: normalizeApiBase(record.env?.[BASE_FIELD] ?? DEFAULT_API_BASE), apiKey: record.key?.trim() ?? '' } : await fallback();
    const cacheKey = createHash('sha256').update(value.apiBase).update('\0').update(value.apiKey).digest('hex');
    return { ...value, cacheKey };
  }
  async function describe(): Promise<EvaluationSettingsView> {
    const record = apiKeyRecord(await store?.readRecord(address));
    const info = await store?.describeRecord(address);
    const resolved = record ? { apiBase: normalizeApiBase(record.env?.[BASE_FIELD] ?? DEFAULT_API_BASE), apiKey: record.key?.trim() ?? '' } : await fallback();
    return { apiBase: resolved.apiBase, configured: !!resolved.apiKey, hasSavedKey: !!record?.key?.trim(), usingDefault: !record, writable: info?.writable ?? false };
  }
  async function save(input: EvaluationSettingsWrite): Promise<EvaluationSettingsView> {
    const apiBase = normalizeApiBase(input?.apiBase);
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new Error('API Key 格式无效');
    const typedKey = input.apiKey?.trim() ?? '';
    if (typedKey.length > 16384 || /[\s\u0000-\u001f\u007f]/.test(typedKey)) throw new Error('API Key 不能包含空白或控制字符');
    if (!store || !(await store.describeRecord(address)).writable) throw new Error('当前凭证存储不可写');
    let wrote = false;
    await store.modifyRecord(address, async (current) => {
      const old = apiKeyRecord(current);
      const oldBase = normalizeApiBase(old?.env?.[BASE_FIELD] ?? DEFAULT_API_BASE);
      if (!typedKey && (!old?.key?.trim() || new URL(oldBase).origin !== new URL(apiBase).origin)) throw new Error('首次保存或更换服务域名时，请重新填写 API Key');
      const key = typedKey || old!.key!;
      if (old?.key === key && old.env?.[BASE_FIELD] === apiBase) return undefined;
      wrote = true;
      return { kind: 'api-key', key, env: { ...old?.env, [BASE_FIELD]: apiBase } };
    });
    if (wrote) changed();
    return describe();
  }
  return { connection, describe, save };
}
