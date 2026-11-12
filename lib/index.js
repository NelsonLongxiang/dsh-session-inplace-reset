import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { createModelPreviews } from './model-previews.ts';
import { createTopicPreviews } from './topic-previews.ts';
import { sessionModel } from './session-model.ts';
import { assertModelChoice } from './model-handoff.ts';
import { observedAgentPreset } from './agent-preset.ts';
import { createEvaluationSettings } from './evaluation-settings.ts';
import { registerSessionRpc } from './register-rpc.ts';
import { ENDPOINTS } from './typert.js';
import { mountResetRemote } from './remote-service.ts';
import { createSessionLifecycle } from './session-lifecycle.js';
import { executeReset, executeRecovery, sessionMetrics } from './reset.js';
import { Ledger } from './ledger.ts';
import { reclaimResetMemory } from './memory-reclaim.ts';
import { recoveryStatus, listRecoveryStatus } from './reset-journal.ts';
export { Ledger } from './ledger.ts';
import { assertSessionId } from './live-release.js';

const localRequire = createRequire(import.meta.url);
let hostRequire = localRequire;
try { localRequire.resolve('@deepseek-ai/schemastery'); }
catch { hostRequire = createRequire(process.argv[1]); }
const Schema = hostRequire('@deepseek-ai/schemastery').default ?? hostRequire('@deepseek-ai/schemastery');
const { symbols } = hostRequire('@deepseek-ai/cordis');
export const name = 'session-reset-inplace';
export const inject = ['sessionQuery', 'workspaceRegistry', 'sessionController', 'agents', 'sessions', 'sessionPersistence', 'agentLoop', 'typert'];
export const Config = Schema.object({
  requireConfirm: Schema.boolean().default(true),
  defaultK: Schema.natural().min(4).max(32).default(12),
  handoffHardCapKB: Schema.natural().min(16).default(512),
  handoffTargetKB: Schema.natural().min(1).default(64),
});

export function buildHandoff(events, opts = {}) {
  const turns = [];
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') { current = { turn: event.data.turn, messages: [] }; turns.push(current); }
    if (!current || !['user/message', 'assistant/message'].includes(event.type)) continue;
    const role = event.type === 'user/message' ? 'user' : 'assistant';
    const message = role === 'user' ? event.data : event.data.message;
    const text = (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      .replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/g, '').trim();
    if (text && !text.startsWith('<system-reminder>')) current.messages.push({ role, text });
  }
  let k = opts.k ?? 12;
  let cap = 8000;
  const hardCap = (opts.handoffHardCapKB ?? 512) * 1024;
  const make = () => ({ kind: 'handoff-seed', k, recent_messages: turns.filter((turn) => turn.messages.length).slice(-k).flatMap((turn) => turn.messages.map((message) => ({ turn: turn.turn, role: message.role, text: message.text.length > cap ? `${message.text.slice(0, cap)}\n[已截断]` : message.text }))) });
  let handoff = make();
  while (Buffer.byteLength(JSON.stringify(handoff)) > hardCap) {
    if (k > 4) k--;
    else if (cap > 128) cap = Math.max(128, Math.floor(cap / 2));
    else throw new Error('无法在体积上限内保留近期上下文，未执行重置');
    handoff = make();
  }
  return handoff;
}

export async function apply(ctx, config) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const ledger = new Ledger(home);
  const lifecycle = createSessionLifecycle(ctx, symbols);
  let modelPreviews;
  const evaluationSettings = createEvaluationSettings(ctx.get('credentials'), ctx.profileContext?.name ?? 'default', () => modelPreviews?.clear());
  modelPreviews = createModelPreviews(ctx, config, hostRequire, evaluationSettings);
  const topicPreviews = createTopicPreviews(ctx, hostRequire);
  ctx.effect(() => () => topicPreviews.dispose(), 'session-reset: topic workers');
  ctx.on('llm/adapters-updated', () => topicPreviews.clear());
  ctx.effect(() => () => modelPreviews.dispose(), 'session-reset: preview workers');
  ctx.effect(() => () => lifecycle.dispose(), 'session-reset: lifecycle guards');
  const reset = async (request, options) => {
    const beforeMemory = process.memoryUsage();
    const result = await executeReset(ctx, ledger, lifecycle, home, request, options);
    try {
      const ids = [result.sessionId, result.forkId].filter((id) => typeof id === 'string');
      await Promise.all(ids.flatMap((id) => [modelPreviews.invalidateSession(id), topicPreviews.invalidateSession(id)]));
      const memory = await reclaimResetMemory(ctx, ids, symbols, beforeMemory);
      try { ledger.append({ operationId: result.operationId, sessionId: result.sessionId, step: 'MEMORY_RECLAIM', state: 'OBSERVED', detail: memory }); }
      catch { memory.warnings.push('内存观测未写入可选历史账本'); }
      return { ...result, memory };
    } catch {
      return { ...result, auditWarning: [result.auditWarning, '重置已校验完成，内存回收未完成'].filter(Boolean).join('；') };
    }
  };
  const methods = {
    async sessionResetEvaluationSettings() { return evaluationSettings.describe(); },
    async sessionResetSaveEvaluationSettings(request) { return evaluationSettings.save(request); },
    async sessionResetRecoveries() { return { ...listRecoveryStatus(home), warnings: ledger.warnings }; },
    async sessionResetRecoveryStatus(sessionId) { return { ...recoveryStatus(home, sessionId), warnings: ledger.warnings }; },
    async sessionResetDryRun(sessionId) {
      assertSessionId(sessionId);
      const observation = await ctx.sessionQuery.observeSession(sessionId);
      try {
        const handoff = buildHandoff(observation.events, { ...config, k: config.defaultK });
        const pending = recoveryStatus(home, sessionId);
        const eligibility = pending.operations.length || pending.issues.length ? { canReset: false, blockedReason: '存在未完成或不可校验的事务，请先核对恢复记录' } : lifecycle.inspect(sessionId);
        let topicModel;
        try { topicModel = sessionModel(observation, ctx.get('agentDefaultModel')); } catch { /* Model analysis availability does not block ordinary reset previews. */ }
        return { ok: true, sessionId, ...sessionMetrics(observation.events), topicModel, agentPreset: observedAgentPreset(observation) ?? null, ...eligibility, size: Buffer.byteLength(JSON.stringify(handoff)), k: handoff.k, messages: handoff.recent_messages.length };
      } finally { observation[Symbol.dispose]?.(); }
    },
    async sessionResetModelPreview(sessionId) {
      assertSessionId(sessionId);
      return modelPreviews.preview(sessionId);
    },
    async sessionResetModelPreviewStart(sessionId) {
      assertSessionId(sessionId);
      return modelPreviews.start(sessionId);
    },
    async sessionResetModelPreviewStartWithGoal(request) {
      assertSessionId(request.sessionId);
      return modelPreviews.start(request.sessionId, request.continuationGoal);
    },
    async sessionResetModelPreviewStatus(request) { return modelPreviews.status(request); },
    async sessionResetTopicPreviewStart(sessionId) { return topicPreviews.start(sessionId); },
    async sessionResetTopicPreviewStatus(request) { return topicPreviews.status(request); },
    async sessionResetExecute(request) {
      return reset(request, { ...config, buildHandoff });
    },
    async sessionResetExecuteModel(request) {
      assertModelChoice(request);
      return reset(request, { ...config, modelReportId: request.modelReportId, modelSourceHash: request.sourceHash, buildHandoff: (_events, _options, source) => modelPreviews.handoff(request.sessionId, source, request) });
    },
    async sessionResetResume(request) {
      return executeRecovery(ctx, ledger, lifecycle, home, request);
    },
  };
  mountResetRemote(ctx, hostRequire, methods);
  await registerSessionRpc(ctx, ENDPOINTS);
}
