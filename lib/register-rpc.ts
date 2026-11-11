interface Invocation { id: string; method: string; namespace: string; result: Record<string, unknown>; [key: string]: unknown }
interface Manifest { package: string; face: string; invocations: Invocation[]; [key: string]: unknown }
interface Registry { register(manifest: Manifest): () => unknown }
interface Context { get(name: 'typert'): Registry; effect(mount: () => () => unknown, label: string): unknown }

/** Own all current endpoints through a separate contribution; cached older namespaces remain untouched. */
export async function registerSessionRpc(ctx: Context, artifact: Manifest): Promise<void> {
  const dry = artifact.invocations.find((item) => item.method === 'sessionResetDryRun');
  if (!dry || dry.namespace !== 'sessionReset' || dry.service !== 'sessionReset') throw new Error('缺少已核验的会话参数 codec，未注册新接口');
  const packageKey = `${artifact.package}/preview`;
  const preview = { ...dry, id: `${packageKey}#sessionReset/sessionResetModelPreview`, method: 'sessionResetModelPreview', result: { ...dry.result, typeSymbol: `${packageKey}/types#ModelPreviewValue` } };
  const saveCodec = {
    mode: 'strict', typeSymbol: `${packageKey}/types#EvaluationSettingsWrite`,
    create: () => saveCodec.schema,
    schema: { parse(value: unknown) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('evaluation settings request required');
      const input = value as Record<string, unknown>;
      if (typeof input.apiBase !== 'string' || input.apiBase.length > 2048 || (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 16384))) throw new TypeError('evaluation settings fields are invalid');
      return { apiBase: input.apiBase, ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }) };
    } },
  };
  const settingsResult = { ...dry.result, typeSymbol: `${packageKey}/types#EvaluationSettingsView` };
  const read = { ...dry, id: `${packageKey}#sessionReset/sessionResetEvaluationSettings`, method: 'sessionResetEvaluationSettings', parameters: [], result: settingsResult };
  const save = { ...dry, id: `${packageKey}#sessionReset/sessionResetSaveEvaluationSettings`, method: 'sessionResetSaveEvaluationSettings', parameters: [{ name: 'request', wire: 'request', source: 'json', codec: saveCodec }], result: settingsResult };
  const recovery = { ...dry, id: `${packageKey}#sessionReset/sessionResetRecoveryStatus`, method: 'sessionResetRecoveryStatus', result: { ...dry.result, typeSymbol: `${packageKey}/types#RecoveryStatus` } };
  const recoveries = { ...read, id: `${packageKey}#sessionReset/sessionResetRecoveries`, method: 'sessionResetRecoveries', result: { ...dry.result, typeSymbol: `${packageKey}/types#RecoveryIndexView` } };
  const base = artifact.invocations.filter((item) => ['sessionResetDryRun', 'sessionResetExecute', 'sessionResetResume'].includes(item.method)).map((item) => ({ ...item, id: `${packageKey}#sessionReset/${item.method}` }));
  const manifest = { ...artifact, package: packageKey, schemas: [], invocations: [...base, preview, read, save, recovery, recoveries] };
  ctx.effect(() => ctx.get('typert').register(manifest), 'session-reset: owned RPC');
}
