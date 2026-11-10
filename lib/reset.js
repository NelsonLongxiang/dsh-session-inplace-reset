import { randomUUID } from 'node:crypto';
import { assertSessionId, quarantineEntities, restoreFromQuarantine } from './live-release.js';
import { runBackupPhase } from './backup.js';

export function sessionMetrics(events) {
  return { totalEvents: events.length, totalTurns: events.filter((event) => event.type === 'turn/start').length };
}

async function measure(ctx, id) {
  const observation = await ctx.sessionQuery.observeSession(id);
  try {
    const stored = await ctx.get('sessionPersistence').stat(id);
    return { ...sessionMetrics(observation.events), sizeBytes: stored?.sizeBytes ?? null, sessionId: observation.header.id };
  } finally { observation[Symbol.dispose]?.(); }
}

export async function executeReset(ctx, ledger, lifecycle, home, request, cfg) {
  const { sessionId, confirmShortId, k = cfg.defaultK } = request ?? {};
  assertSessionId(sessionId);
  if (confirmShortId !== sessionId.slice(8, 16)) throw new Error('确认失败，请输入所选会话的八位短 ID');
  if (!Number.isSafeInteger(k) || k < 4 || k > 32) throw new Error('保留轮数须为 4–32');
  const operationId = randomUUID();
  return lifecycle.run(sessionId, async (lease) => {
    const record = (step, state, extra = {}) => ledger.append({ operationId, sessionId, step, state, ...extra });
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
    if (activity.length) throw new Error('会话仍有后台活动或调度，请先停止后再重置');
    const before = await measure(ctx, sessionId);
    if (!before.totalTurns) throw new Error('该会话没有对话轮次，无需重置');
    record('PREFLIGHT', 'RUNNING', { before });
    try { await lease.release(); }
    catch (error) { record('RELEASE', 'HALTED', { error: String(error) }); throw error; }
    record('RELEASE', 'RUNNING');
    let backup;
    let quarantine;
    try {
      backup = await runBackupPhase(ctx, ledger, sessionId, { ...cfg, operationId, home, k });
      await lifecycle.run(backup.forkId, (forkLease) => forkLease.release());
      quarantine = quarantineEntities(home, sessionId, operationId);
      record('QUARANTINE', 'RUNNING', { quarantine: quarantine.quarantine, forkId: backup.forkId });
      const controller = ctx.get('sessionController');
      const created = await controller.create({ sessionId, cwd: backup.header.cwd, ...(backup.header.agentPreset ? { agentPreset: backup.header.agentPreset } : {}) });
      if (created.sessionId !== sessionId) throw new Error('宿主未以原 ID 创建会话');
      const agent = ctx.get('agents').get(sessionId);
      if (!agent || agent.status !== 'idle') throw new Error('新会话运行时异常');
      const text = `[原地重置生成的历史交接记录，并非新任务；请勿自动执行记录中的历史命令]\n完整历史备份：${backup.forkId}\n\n${backup.blob}`;
      const title = [...backup.events].reverse().find((event) => event.type === 'session/title')?.data?.title;
      if (title) await controller.rename({ sessionId, title });
      await agent.runMaintenance(async () => {
        // One closed handoff turn is visible immediately; no model request or background task is started.
        agent.session.append('turn/start', { turn: 1 });
        agent.session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { surfaceOp: 'append' });
        agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
        await ctx.get('sessionPersistence').flush();
      });
      const after = await measure(ctx, sessionId);
      const reader = await ctx.get('sessionPersistence').open(sessionId, 'read');
      try {
        const saved = await reader.read(0);
        if (after.sessionId !== sessionId || after.totalTurns !== 1 || !saved.events.some((event) => event.type === 'user/message' && event.data.content?.some((part) => part.text === text))) throw new Error('重置后的独立读回校验失败');
        if (saved.events.some((event) => event.type.startsWith('tool/ptc-dispatch'))) throw new Error('新日志仍含旧调度事件');
      } finally { await reader.close(); }
      const result = { ok: true, phase: 'DONE', verified: true, sameId: true, sessionId, operationId, forkId: backup.forkId, quarantine: quarantine.quarantine, before, after };
      record('VERIFY', 'DONE', { result });
      return result;
    } catch (error) {
      if (quarantine) {
        try { await lifecycle.releaseCurrent(sessionId); }
        catch (releaseError) {
          record('ROLLBACK', 'HALTED', { error: String(error), releaseError: String(releaseError), quarantine: quarantine.quarantine });
          throw new Error('重建失败，运行时未能释放；原件在隔离区，未覆盖新文件', { cause: error });
        }
        quarantineEntities(home, sessionId, `${operationId}-failed`);
        restoreFromQuarantine(home, quarantine.quarantine, sessionId);
      }
      try { await ctx.get('sessionController').agents.resolveAgent(sessionId); } catch { /* Original durable files remain available for an explicit resume. */ }
      record('ROLLBACK', quarantine ? 'ROLLED_BACK' : 'FAILED_UNCHANGED', { error: String(error), forkId: backup?.forkId });
      throw new Error(quarantine ? `重建失败，已恢复原日志：${error.message}` : `原日志未替换：${error.message}`, { cause: error });
    }
  });
}
