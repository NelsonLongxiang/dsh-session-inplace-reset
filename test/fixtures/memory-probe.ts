// Isolated integration fixture only; this package is generated under one check's private DSH_HOME.
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { Session as InspectorSession } from 'node:inspector';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const load = createRequire(process.argv[1]);
const { TypertRemoteService } = load('@deepseek-ai/dsh-typert-protocol');
const { symbols } = load('@deepseek-ai/cordis');
const raw = (value: any) => value?.[symbols.original] ?? value;
const schema = { parse(value: unknown) { return value; } };
const codec = { mode: 'strict', typeSymbol: '@local/reset-memory-probe/types#Value', create: () => schema, schema };
export const TYPERT = { package: '@local/reset-memory-probe', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [{ id: '@local/reset-memory-probe#resetMemoryProbe/action', service: 'resetMemoryProbe', namespace: 'resetMemoryProbe', method: 'action', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec }], result: codec }] };
export const name = 'reset-memory-probe';
export const inject = ['sessionQuery', 'sessionController', 'sessions', 'agents', 'sessionPersistence', 'agentLoop', 'typert'];

export async function apply(ctx: any, config: { pluginRoot: string; home: string }) {
  if (process.env.DSH_MEMORY_PROBE !== 'isolated' || resolve(process.env.DSH_HOME ?? '') !== resolve(config.home) || !/[\\/]install-[a-f0-9-]+[\\/]isolated-home$/i.test(config.home)) throw new Error('Memory probe is restricted to its own isolated test home');
  const { createSessionLifecycle } = await import(pathToFileURL(resolve(config.pluginRoot, 'dist/session-lifecycle.js')).href);
  const lifecycle = createSessionLifecycle(ctx, symbols);
  ctx.effect(() => () => lifecycle.dispose(), 'memory-check: owned session guards');
  const owned = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const samples: object[] = [];
  const query = raw(ctx.get('sessionQuery'));
  const cache = () => query?._observations?.cache;
  const persistence = raw(ctx.get('sessionPersistence'));
  const cacheRows = (map: unknown) => map instanceof Map ? [...map].map(([id, entry]: [string, any]) => ({ sessionId: id, refs: entry.refs ?? null, events: entry.events?.length ?? null, textChars: Array.isArray(entry.events) ? entry.events.reduce((sum: number, event: any) => sum + (event.type === 'user/message' ? (event.data.content ?? []).reduce((size: number, part: any) => size + (part.type === 'text' ? part.text.length : 0), 0) : 0), 0) : null })) : null;
  const controller = raw(ctx.get('sessionController'));
  const loop = raw(ctx.get('agentLoop'));
  const fibers = () => [...new Set([controller?.ctx?.fiber, raw(controller?.agents)?.ctx?.fiber, raw(controller?.commands)?.ctx?.fiber, loop?.ctx?.fiber, loop?.runtime?.ctx?.fiber].filter(Boolean))];
  const lifecycleEffects = () => fibers().map((fiber: any, index: number) => ({ index, labels: [...(fiber._disposables ?? [])].map((dispose: any) => dispose[symbols.effect]?.label).filter((label: unknown) => typeof label === 'string' && label.startsWith('agentLoop.')) }));
  const metrics = () => ({ at: new Date().toISOString(), pid: process.pid, ...process.memoryUsage(), cache: cacheRows(cache()), persistenceMemo: cacheRows(persistence.coldLogMemo), handles: persistence.tracker?.openHandles?.size ?? null, writers: persistence.tracker?.writers?.size ?? null, lifecycleEffects: lifecycleEffects() });
  const requireOwned = (id: unknown): string => { if (typeof id !== 'string' || !owned.has(id)) throw new Error('Only this probe\'s explicitly created test sessions are allowed'); return id; };
  ctx.effect(() => () => { if (timer) clearInterval(timer); }, 'memory-check: sampling timer');
  class Probe extends TypertRemoteService {
    constructor() { super(ctx, 'resetMemoryProbe'); }
    async action(request: { operation: string; sessionId?: string; fixtureMiB?: number }) {
      switch (request.operation) {
        case 'metrics': return metrics();
        case 'sample-start':
          if (timer) throw new Error('Sampler already active');
          samples.length = 0;
          timer = setInterval(() => samples.push({ at: new Date().toISOString(), ...process.memoryUsage() }), 200);
          return metrics();
        case 'sample-stop':
          if (timer) clearInterval(timer); timer = undefined;
          return { ...metrics(), samples: [...samples] };
        case 'gc': {
          const inspector = new InspectorSession();
          inspector.connect();
          try { await new Promise<void>((done, reject) => inspector.post('HeapProfiler.collectGarbage', (error) => error ? reject(error) : done())); }
          finally { inspector.disconnect(); }
          return metrics();
        }
        case 'fixture': {
          const size = request.fixtureMiB ?? 16;
          if (!Number.isSafeInteger(size) || size < 4 || size > 64) throw new Error('Fixture size must be 4–64 MiB');
          const id = `session-${randomUUID()}`;
          owned.add(id);
          const controller = ctx.get('sessionController');
          const created = await controller.create({ sessionId: id, cwd: config.home, agentPreset: 'minimal' });
          if (created.sessionId !== id) throw new Error('Fixture identity mismatch');
          await controller.rename({ sessionId: id, title: `[reset-test] memory ${size}MiB ${id.slice(8, 16)}` });
          const agent = ctx.get('agents').get(id);
          const chunkBytes = 128 * 1024;
          const turns = size * 1024 * 1024 / chunkBytes;
          await agent.runMaintenance(async () => {
            for (let index = 0; index < turns; index++) {
              const text = randomBytes(chunkBytes / 2).toString('hex');
              agent.session.append('turn/start', { turn: index + 1 });
              agent.session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { surfaceOp: 'append' });
              agent.session.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } });
            }
            await ctx.get('sessionPersistence').flush();
          });
          return { sessionId: id, fixtureMiB: size, turns, ...metrics() };
        }
        case 'full-owner-refresh': {
          const id = requireOwned(request.sessionId);
          await lifecycle.run(id, async () => {
            const label = `agentLoop.lifecycle(${id})`;
            const disposers = fibers().flatMap((fiber: any) => [...(fiber._disposables ?? [])].filter((dispose: any) => dispose[symbols.effect]?.label === label));
            if (!disposers.length) throw new Error('Could not locate an owned outer lifecycle effect');
            for (const dispose of disposers as (() => Promise<void>)[]) await dispose();
            if (ctx.get('agents').get(id) || ctx.get('sessions').get(id)) throw new Error('Outer lifecycle did not release target');
            await ctx.get('sessionController').resolveAgent(id);
          });
          return metrics();
        }
        case 'memo-pressure': {
          requireOwned(request.sessionId);
          for (let index = 0; index < 2; index++) {
            const id = `session-${randomUUID()}`;
            owned.add(id);
            const controller = ctx.get('sessionController');
            await controller.create({ sessionId: id, cwd: config.home, agentPreset: 'minimal' });
            await controller.rename({ sessionId: id, title: `[reset-test] small memo control ${index}` });
            await ctx.get('sessionPersistence').flush();
            await lifecycle.run(id, (lease: { release(): Promise<void> }) => lease.release());
            const reader = await ctx.get('sessionPersistence').open(id, 'read');
            try { await reader.read(0); } finally { await reader.close(); }
          }
          return metrics();
        }
        case 'public-refresh': {
          const id = requireOwned(request.sessionId);
          await lifecycle.run(id, async (lease: { release(): Promise<void> }) => {
            await lease.release();
            const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' });
            try { if (observation.header.id !== id) throw new Error('Refresh identity mismatch'); void observation.events; }
            finally { observation[Symbol.dispose]?.(); }
            await ctx.get('sessionController').resolveAgent(id);
          });
          if (!ctx.get('agents').get(id) || !ctx.get('sessions').get(id)) throw new Error('Public refresh did not restore the target runtime');
          return metrics();
        }
        default: throw new Error('Unknown memory probe operation');
      }
    }
  }
  new Probe();
}
