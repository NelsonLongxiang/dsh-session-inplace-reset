import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { snapshotFromObservation } from './source-snapshot.ts';
import { sourceDigest } from './handoff-eval.ts';
import { assertSessionId } from './session-id.ts';
import { assertPreviewTask } from './model-previews.ts';
import type { PreviewTaskRequest } from './model-previews.ts';
import { sessionModel } from './session-model.ts';
import type { ModelObservation, SessionModelSelection } from './session-model.ts';
import { analyzeTopics, TOPIC_ANALYSIS_VERSION } from './topic-analysis.ts';
import type { TopicLlm, TopicProgress, TopicReport } from './topic-analysis.ts';

type Observation = Parameters<typeof snapshotFromObservation>[1] & ModelObservation & { [Symbol.dispose]?(): void };
interface Host { sessionQuery: { observeSession(id: string, options?: object): Promise<Observation> }; get(name: string): any }
export interface TopicTaskView extends PreviewTaskRequest { startedAt: string; running: boolean; model: SessionModelSelection; modelSource: 'session' | 'default'; progress: TopicProgress; report?: TopicReport; error?: string }
interface TopicTask extends TopicTaskView { cursor: number; selection: SessionModelSelection; controller: AbortController; pending: Promise<void> }

export function createTopicPreviews(ctx: Host, loader: { resolve(name: string): string }, reportRoot = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs')) {
  const tasks = new Map<string, TopicTask>();
  const pending = new Set<Promise<void>>();
  const activeTasks = new Set<TopicTask>();
  let active = 0, closing = false, generation = 0;
  const routeKey = (selection: SessionModelSelection) => JSON.stringify(selection);
  const view = (task: TopicTask): TopicTaskView => structuredClone({ taskId: task.taskId, sessionId: task.sessionId, startedAt: task.startedAt, running: task.running, model: task.report?.model ?? task.model, modelSource: task.modelSource, progress: task.progress, ...(task.report ? { report: task.report } : {}), ...(task.error ? { error: task.error } : {}) });
  const current = async (task: TopicTask) => {
    const observation = await ctx.sessionQuery.observeSession(task.sessionId, { projectionMode: 'all' });
    try {
      const selected = sessionModel(observation, ctx.get('agentDefaultModel'));
      if (observation.header.id !== task.sessionId || observation.cursor !== task.cursor || routeKey(selected.selection) !== routeKey(task.selection)) {
        task.error = '会话内容或模型已变化，请重新分析候选主题';
        task.controller.abort();
      }
    } finally { observation[Symbol.dispose]?.(); }
  };
  return {
    clear() { generation++; for (const task of tasks.values()) task.controller.abort(); tasks.clear(); },
    async invalidateSession(sessionId: string) {
      assertSessionId(sessionId);
      const running = [...activeTasks].filter((task) => task.sessionId === sessionId);
      for (const task of running) task.controller.abort();
      for (const [key, task] of tasks) if (task.sessionId === sessionId) tasks.delete(key);
      await Promise.allSettled(running.map((task) => task.pending));
    },
    async dispose() { closing = true; this.clear(); await Promise.allSettled(pending); },
    async start(sessionId: string): Promise<TopicTaskView> {
      assertSessionId(sessionId);
      if (closing) throw new Error('插件正在停止，未启动主题分析');
      const capturedGeneration = generation;
      const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all' });
      let snapshot, selected;
      try {
        selected = sessionModel(observation, ctx.get('agentDefaultModel'));
        snapshot = await snapshotFromObservation(sessionId, observation, ctx.get('sessions').messageProjections, loader);
      } finally { observation[Symbol.dispose]?.(); }
      const llm = ctx.get('llm') as TopicLlm | undefined;
      if (!llm || typeof llm.prepareCall !== 'function') throw new Error('宿主模型调用服务不可用，未改用其他模型');
      if (closing || generation !== capturedGeneration) throw new Error('模型服务已变化，请重新分析主题');
      const sourceHash = sourceDigest(snapshot);
      const key = createHash('sha256').update(JSON.stringify([TOPIC_ANALYSIS_VERSION, sourceHash, selected])).digest('hex');
      const cached = tasks.get(key);
      if (cached && !cached.error && cached.report?.status !== 'unavailable') return view(cached);
      if (active >= 2) throw new Error('已有主题分析正在进行，请稍后再试');
      const task: TopicTask = { taskId: randomUUID(), sessionId, cursor: snapshot.cursor, startedAt: new Date().toISOString(), running: true, model: selected.selection, selection: selected.selection, modelSource: selected.source, progress: { phase: 'preparing', completedBatches: 0, totalBatches: 0, running: 0, concurrency: 4, requests: 0 }, controller: new AbortController(), pending: undefined! };
      tasks.set(key, task);
      if (tasks.size > 8) { const oldest = [...tasks].find(([, value]) => !value.running); if (oldest) tasks.delete(oldest[0]); }
      active++;
      activeTasks.add(task);
      task.pending = (async () => {
        try {
          const directory = join(reportRoot, `topics-${task.taskId}`);
          await mkdir(directory, { recursive: true });
          const report = await analyzeTopics(snapshot, sourceHash, selected, llm, task.controller.signal, (value) => { task.progress = value; }, async (diagnostic) => { await writeFile(join(directory, `diagnostic-${randomUUID()}.json`), JSON.stringify(diagnostic, null, 2), { flag: 'wx' }); });
          await current(task);
          if (task.controller.signal.aborted) { task.error ??= '模型服务已变化，请重新分析候选主题'; return; }
          await writeFile(join(directory, 'result.json'), JSON.stringify({ ...report, taskId: task.taskId, checkedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
          task.report = report;
        } catch { task.error = '主题分析未完成，请检查会话模型后重试'; }
        finally { task.running = false; active--; pending.delete(task.pending); activeTasks.delete(task); }
      })();
      pending.add(task.pending);
      void task.pending.catch(() => undefined);
      return view(task);
    },
    async status(request: PreviewTaskRequest): Promise<TopicTaskView> {
      assertPreviewTask(request);
      const task = [...tasks.values()].find((value) => value.taskId === request.taskId && value.sessionId === request.sessionId);
      if (!task) throw new Error('主题分析已失效或不属于所选会话');
      await current(task);
      return view(task);
    },
  };
}
