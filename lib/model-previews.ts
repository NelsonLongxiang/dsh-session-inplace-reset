import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { evaluateConnection } from './decision-model.ts';
import type { EvaluationConnection } from './decision-model.ts';
import { previewHandoff, canonicalContinuationGoal, RUBRIC, SAMPLER, sourceDigest } from './handoff-eval.ts';
import type { PreviewProgress, SourceSnapshot } from './handoff-eval.ts';
import { MAX_EVALUATION_CALLS, MAX_PARALLEL_REQUESTS } from './handoff-batches.ts';
import { approvedModelHandoff } from './model-handoff.ts';
import type { CachedPreview, ModelChoice, ModelReport } from './model-handoff.ts';
import { snapshotFromObservation } from './source-snapshot.ts';
import { assertSessionId } from './session-id.ts';

type Observation = Parameters<typeof snapshotFromObservation>[1] & { [Symbol.dispose]?(): void };
interface Host { sessionQuery: { observeSession(id: string, options: object): Promise<Observation> }; get(name: 'sessions'): { messageProjections: unknown } }
interface Config { handoffTargetKB: number; handoffHardCapKB: number }
interface Settings { connection(): Promise<EvaluationConnection & { cacheKey: string }> }
export interface PreviewTaskRequest { sessionId: string; taskId: string }
export interface PreviewTaskView extends PreviewTaskRequest { startedAt: string; running: boolean; progress: PreviewProgress; report?: ModelReport; error?: string }
interface PreviewTask extends PreviewTaskView { pending: Promise<CachedPreview>; controller: AbortController }

export function assertPreviewTask(value: unknown): asserts value is PreviewTaskRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('preview task request required');
  const input = value as Record<string, unknown>;
  assertSessionId(input.sessionId);
  if (typeof input.taskId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.taskId)) throw new TypeError('invalid preview task ID');
}

export function createModelPreviews(ctx: Host, config: Config, loader: { resolve(name: string): string }, settings: Settings, evaluate = evaluateConnection, reportRoot = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs')) {
  const previews = new Map<string, PreviewTask>();
  const pendingTasks = new Set<Promise<CachedPreview>>();
  const activeTasks = new Set<PreviewTask>();
  let active = 0, closing = false;
  const targetBytes = config.handoffTargetKB * 1024;
  const keyFor = (snapshot: SourceSnapshot, connectionKey: string, goal: string) => createHash('sha256').update(JSON.stringify([RUBRIC, SAMPLER, targetBytes, goal, connectionKey, sourceDigest(snapshot)])).digest('hex');
  const snapshotOf = (id: string, observation: Observation) => snapshotFromObservation(id, observation, ctx.get('sessions').messageProjections, loader);
  const view = (task: PreviewTask): PreviewTaskView => structuredClone({ sessionId: task.sessionId, taskId: task.taskId, startedAt: task.startedAt, running: task.running, progress: task.progress, ...(task.report ? { report: task.report } : {}), ...(task.error ? { error: task.error } : {}) });
  const taskFor = async (sessionId: string, requestedGoal?: string) => {
    const goal = canonicalContinuationGoal(requestedGoal);
    if (closing) throw new Error('插件正在停止，未启动新的评估');
    assertSessionId(sessionId);
    const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
    let snapshot;
    try { snapshot = await snapshotOf(sessionId, observation); }
    finally { observation[Symbol.dispose]?.(); }
    const connection = await settings.connection();
    const key = keyFor(snapshot, connection.cacheKey, goal);
    const cached = previews.get(key);
    if (cached && !cached.error && cached.report?.status !== 'unavailable') return cached;
    if (closing) throw new Error('插件正在停止，未启动新的评估');
    if (active >= 2) throw new Error('已有模型预览正在评估，请稍后再试');
    active++;
    const task: PreviewTask = {
      sessionId, taskId: randomUUID(), startedAt: new Date().toISOString(), running: true,
      progress: { phase: 'preparing', completedBatches: 0, totalBatches: 0, running: 0, concurrency: MAX_PARALLEL_REQUESTS, requestCount: 0, requestLimit: MAX_EVALUATION_CALLS, assessed: 0, sourceTotal: 0 },
      pending: undefined!, controller: new AbortController(),
    };
    previews.set(key, task);
    activeTasks.add(task);
    if (previews.size > 8) {
      const oldest = [...previews].find(([, entry]) => !entry.running);
      if (oldest) previews.delete(oldest[0]);
    }
    task.pending = (async () => {
      try {
        const report = await previewHandoff(snapshot, (state, questions) => closing || task.controller.signal.aborted ? Promise.resolve({ error: '评估请求未完成' }) : evaluate(connection, state, questions, task.controller.signal), { targetBytes, continuationGoal: goal, onProgress: (value) => { task.progress = { ...value, phase: value.phase === 'complete' ? 'aggregation' : value.phase }; } });
        const reportId = randomUUID();
        const directory = join(reportRoot, `model-${reportId}`);
        await mkdir(directory, { recursive: true });
        const value = { ...report, evaluationApiBase: connection.apiBase, reportId, checkedAt: new Date().toISOString() };
        await writeFile(join(directory, 'result.json'), JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
        task.report = value;
        task.progress = { ...task.progress, phase: 'complete' };
        return { report: value, connectionKey: connection.cacheKey };
      } catch (error) { task.error = '模型预览未完成，请重新预览'; throw error; }
      finally { task.running = false; active--; pendingTasks.delete(task.pending); activeTasks.delete(task); }
    })();
    pendingTasks.add(task.pending);
    // A progress client observes errors through status; legacy callers can still await the same promise.
    void task.pending.catch(() => undefined);
    return task;
  };
  return {
    clear() { previews.clear(); },
    async invalidateSession(sessionId: string) {
      assertSessionId(sessionId);
      const running = [...activeTasks].filter((task) => task.sessionId === sessionId);
      for (const task of running) task.controller.abort();
      for (const [key, task] of previews) if (task.sessionId === sessionId) previews.delete(key);
      await Promise.allSettled(running.map((task) => task.pending));
    },
    async dispose() { closing = true; for (const task of activeTasks) task.controller.abort(); await Promise.allSettled(pendingTasks); },
    async start(sessionId: string, goal?: string): Promise<PreviewTaskView> { return view(await taskFor(sessionId, goal)); },
    status(request: PreviewTaskRequest): PreviewTaskView {
      assertPreviewTask(request);
      const task = [...previews.values()].find((entry) => entry.taskId === request.taskId && entry.sessionId === request.sessionId);
      if (!task) throw new Error('评估任务已失效或不属于所选会话，请重新预览');
      return view(task);
    },
    async preview(sessionId: string): Promise<ModelReport> { return structuredClone((await (await taskFor(sessionId)).pending).report); },
    async handoff(sessionId: string, observation: Observation, choice: ModelChoice) {
      const snapshot = await snapshotOf(sessionId, observation);
      const connection = await settings.connection();
      const pending = previews.get(keyFor(snapshot, connection.cacheKey, canonicalContinuationGoal(choice.continuationGoal)))?.pending;
      const entry = pending ? await pending : undefined;
      return approvedModelHandoff(entry, choice, { snapshot, connectionKey: connection.cacheKey, targetBytes, hardCapBytes: config.handoffHardCapKB * 1024 });
    },
  };
}
