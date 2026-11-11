import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { evaluateConnection } from './decision-model.ts';
import type { EvaluationConnection } from './decision-model.ts';
import { previewHandoff, RUBRIC, SAMPLER, sourceDigest } from './handoff-eval.ts';
import type { SourceSnapshot } from './handoff-eval.ts';
import { approvedModelHandoff } from './model-handoff.ts';
import type { CachedPreview, ModelChoice, ModelReport } from './model-handoff.ts';
import { snapshotFromObservation } from './source-snapshot.ts';

type Observation = Parameters<typeof snapshotFromObservation>[1] & { [Symbol.dispose]?(): void };
interface Host { sessionQuery: { observeSession(id: string, options: object): Promise<Observation> }; get(name: 'sessions'): { messageProjections: unknown } }
interface Config { handoffTargetKB: number; handoffHardCapKB: number }
interface Settings { connection(): Promise<EvaluationConnection & { cacheKey: string }> }

export function createModelPreviews(ctx: Host, config: Config, loader: { resolve(name: string): string }, settings: Settings, evaluate = evaluateConnection, reportRoot = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs')) {
  const previews = new Map<string, Promise<CachedPreview>>();
  let active = 0;
  const targetBytes = config.handoffTargetKB * 1024;
  const keyFor = (snapshot: SourceSnapshot, connectionKey: string) => createHash('sha256').update(JSON.stringify([RUBRIC, SAMPLER, targetBytes, connectionKey, sourceDigest(snapshot)])).digest('hex');
  const snapshotOf = (id: string, observation: Observation) => snapshotFromObservation(id, observation, ctx.get('sessions').messageProjections, loader);
  return {
    clear() { previews.clear(); },
    async preview(sessionId: string): Promise<ModelReport> {
      const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
      let snapshot;
      try { snapshot = await snapshotOf(sessionId, observation); }
      finally { observation[Symbol.dispose]?.(); }
      const connection = await settings.connection();
      const key = keyFor(snapshot, connection.cacheKey);
      const cached = previews.get(key);
      if (cached) return structuredClone((await cached).report);
      if (active >= 2) throw new Error('已有模型预览正在评估，请稍后再试');
      active++;
      let pending!: Promise<CachedPreview>;
      pending = (async () => {
        try {
          const report = await previewHandoff(snapshot, (state, questions) => evaluate(connection, state, questions), { targetBytes });
          const reportId = randomUUID();
          const directory = join(reportRoot, `model-${reportId}`);
          await mkdir(directory, { recursive: true });
          const value = { ...report, evaluationApiBase: connection.apiBase, reportId, checkedAt: new Date().toISOString() };
          await writeFile(join(directory, 'result.json'), JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
          if (report.status === 'unavailable' && previews.get(key) === pending) previews.delete(key);
          return { report: value, connectionKey: connection.cacheKey };
        } catch (error) { if (previews.get(key) === pending) previews.delete(key); throw error; }
        finally { active--; }
      })();
      previews.set(key, pending);
      if (previews.size > 8) previews.delete(previews.keys().next().value!);
      return structuredClone((await pending).report);
    },
    async handoff(sessionId: string, observation: Observation, choice: ModelChoice) {
      const snapshot = await snapshotOf(sessionId, observation);
      const connection = await settings.connection();
      const pending = previews.get(keyFor(snapshot, connection.cacheKey));
      const entry = pending ? await pending : undefined;
      return approvedModelHandoff(entry, choice, { snapshot, connectionKey: connection.cacheKey, targetBytes, hardCapBytes: config.handoffHardCapKB * 1024 });
    },
  };
}
