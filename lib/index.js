import { appendFileSync, existsSync, readFileSync, mkdirSync, openSync, fsyncSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { previewHandoff, RUBRIC, SAMPLER, sourceDigest } from './handoff-eval.ts';
import { evaluateConnection } from './decision-model.ts';
import { createEvaluationSettings } from './evaluation-settings.ts';
import { registerSessionRpc } from './register-rpc.ts';
import { TYPERT } from './typert.js';
import { createSessionLifecycle } from './session-lifecycle.js';
import { executeReset, sessionMetrics } from './reset.js';
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

/** Legacy ledger is preserved; new records are appended and fsynced independently. */
export class Ledger {
  constructor(home) {
    const directory = join(home, 'session-reset');
    mkdirSync(directory, { recursive: true });
    const legacy = join(directory, 'ledger.json');
    this.path = join(directory, 'operations.jsonl');
    this.rows = existsSync(legacy) ? JSON.parse(readFileSync(legacy, 'utf8')) : [];
    if (existsSync(this.path)) this.rows.push(...readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  }
  append(record) {
    const row = { at: Date.now(), ...record };
    const fd = openSync(this.path, 'a');
    try { appendFileSync(fd, `${JSON.stringify(row)}\n`, 'utf8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.rows.push(row);
    return row;
  }
}

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
  await registerSessionRpc(ctx, TYPERT);
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const ledger = new Ledger(home);
  const lifecycle = createSessionLifecycle(ctx, symbols);
  const previews = new Map();
  const evaluationSettings = createEvaluationSettings(ctx.get('credentials'), ctx.profileContext?.name ?? 'default', () => previews.clear());
  let activePreviews = 0;
  ctx.effect(() => () => lifecycle.dispose(), 'session-reset: lifecycle guards');
  const service = ctx.get('workspaceRegistry')[symbols.original] ?? ctx.get('workspaceRegistry');
  const methods = {
    async sessionResetEvaluationSettings() { return evaluationSettings.describe(); },
    async sessionResetSaveEvaluationSettings(request) { return evaluationSettings.save(request); },
    async sessionResetDryRun(sessionId) {
      assertSessionId(sessionId);
      const observation = await ctx.sessionQuery.observeSession(sessionId);
      try {
        const handoff = buildHandoff(observation.events, { ...config, k: config.defaultK });
        return { ok: true, sessionId, ...sessionMetrics(observation.events), ...lifecycle.inspect(sessionId), size: Buffer.byteLength(JSON.stringify(handoff)), k: handoff.k, messages: handoff.recent_messages.length };
      } finally { observation[Symbol.dispose]?.(); }
    },
    async sessionResetModelPreview(sessionId) {
      assertSessionId(sessionId);
      const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
      let snapshot;
      try {
        const { Session } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-session')).href);
        const replay = Session.fromRestore(sessionId, observation.events, observation.header, observation.inheritedEventCount, 'shared-frozen', ctx.get('sessions').messageProjections);
        const messages = replay.surface.nodes.flatMap((seq) => {
          const message = replay.deriveEventMessage(observation.events[seq]);
          const text = message?.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
          return text ? [{ seq, role: message.role, sourceKind: message.source.kind, text }] : [];
        });
        snapshot = { sessionId, cursor: observation.cursor, messages };
      } finally { observation[Symbol.dispose]?.(); }
      const connection = await evaluationSettings.connection();
      const key = createHash('sha256').update(JSON.stringify([RUBRIC, SAMPLER, config.handoffTargetKB, connection.cacheKey, sourceDigest(snapshot)])).digest('hex');
      if (previews.has(key)) return previews.get(key);
      if (activePreviews >= 2) throw new Error('已有模型预览正在评估，请稍后再试');
      activePreviews++;
      const pending = (async () => {
        try {
          const report = await previewHandoff(snapshot, (state, questions) => evaluateConnection(connection, state, questions), { targetBytes: config.handoffTargetKB * 1024 });
          const reportId = randomUUID();
          const directory = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `model-${reportId}`);
          mkdirSync(directory, { recursive: true });
          const value = { ...report, evaluationApiBase: connection.apiBase, reportId, checkedAt: new Date().toISOString() };
          writeFileSync(join(directory, 'result.json'), JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
          if (report.status === 'unavailable') previews.delete(key);
          return value;
        } catch (error) { previews.delete(key); throw error; }
        finally { activePreviews--; }
      })();
      previews.set(key, pending);
      if (previews.size > 8) previews.delete(previews.keys().next().value);
      return pending;
    },
    async sessionResetExecute(request) {
      return executeReset(ctx, ledger, lifecycle, home, request, { ...config, buildHandoff });
    },
    async sessionResetResume() {
      throw new Error('旧版重启操作不会自动续跑。请核对旧账本和隔离区；新重置流程一次完成且不重启 DSH。');
    },
  };
  for (const [method, implementation] of Object.entries(methods)) {
    const previous = service[method];
    service[method] = implementation;
    ctx.effect(() => () => {
      if (service[method] !== implementation) return;
      if (previous === undefined) delete service[method];
      else service[method] = previous;
    }, `session-reset: ${method}`);
  }
}
