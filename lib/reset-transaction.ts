import { randomUUID } from 'node:crypto';
import { runBackupPhase } from './backup.js';
import { assertSessionId } from './session-id.ts';
import { ResetJournal, recoveryStatus } from './reset-journal.ts';
import type { OperationLedger } from './ledger.ts';
import { observedAgentPreset, optionalAgentPreset, resetAgentPreset } from './agent-preset.ts';

interface ResetRequest { sessionId: string; confirmShortId: string; k?: number; operationId?: string; agentPreset?: string }
interface Config { defaultK: number; buildHandoff: (...args: any[]) => unknown; [key: string]: any }
// The installed Host owns these dynamic services; filesystem transactions below remain typed and independently checked.
type HostContext = any;
type Lifecycle = { run(id: string, operation: (lease: { release(): Promise<void> }) => Promise<any>): Promise<any>; releaseCurrent(id: string): Promise<void> };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function sessionMetrics(events: { type: string }[]) {
  return { totalEvents: events.length, totalTurns: events.filter((event) => event.type === 'turn/start').length };
}
async function measure(ctx: HostContext, id: string) {
  const observation = await ctx.sessionQuery.observeSession(id);
  try {
    const stored = await ctx.get('sessionPersistence').stat(id);
    return { ...sessionMetrics(observation.events), sizeBytes: stored?.sizeBytes ?? null, sessionId: observation.header.id, agentPreset: observedAgentPreset(observation) ?? null };
  } finally { observation[Symbol.dispose]?.(); }
}
function confirm(request: ResetRequest) {
  assertSessionId(request?.sessionId);
  if (request.confirmShortId !== request.sessionId.slice(8, 16)) throw new Error('确认失败，请输入所选会话的八位短ID');
}
function history(ledger: OperationLedger, row: Record<string, unknown>): string | undefined {
  try { ledger.append(row); }
  catch { return '历史账本追加失败，事务记录仍保留'; }
}
export async function executeReset(ctx: HostContext, ledger: OperationLedger, lifecycle: Lifecycle, home: string, request: ResetRequest, cfg: Config) {
  confirm(request);
  const requestedPreset = optionalAgentPreset(request.agentPreset);
  const { sessionId, k = cfg.defaultK } = request;
  if (!Number.isSafeInteger(k) || k < 4 || k > 32) throw new Error('保留轮数须为4–32');
  const pending = recoveryStatus(home, sessionId);
  if (pending.operations.length || pending.issues.length) throw new Error('存在未完成或不可校验的事务，请先核对恢复记录');
  const operationId = randomUUID();
  return lifecycle.run(sessionId, async (lease) => {
    const record = (step: string, state: string, extra: object = {}) => ledger.append({ operationId, sessionId, step, state, ...extra });
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
    if (activity.length) throw new Error('会话仍有后台活动或调度，请先停止后再重置');
    const before = await measure(ctx, sessionId);
    if (!before.totalTurns) throw new Error('该会话没有对话轮次，无需重置');
    const registry = ctx.get('agentPresets');
    const agentPreset = await resetAgentPreset(registry, requestedPreset, before.agentPreset ?? undefined);
    record('PREFLIGHT', 'RUNNING', { before, agentPreset: agentPreset ?? null });
    try { await lease.release(); }
    catch (error) { history(ledger, { operationId, sessionId, step: 'RELEASE', state: 'HALTED', error: message(error) }); throw error; }
    let backup: any;
    let journal: ResetJournal | undefined;
    try {
      backup = await runBackupPhase(ctx, ledger, sessionId, { ...cfg, operationId, home, k });
      await lifecycle.run(backup.forkId, (forkLease) => forkLease.release());
      if (registry) await resetAgentPreset(registry, agentPreset, undefined);
      journal = await ResetJournal.create(home, sessionId, operationId, backup.forkId);
      await journal.quarantineOriginal();
      record('QUARANTINE', 'RUNNING', { quarantine: journal.quarantine, forkId: backup.forkId });
      journal.record('rebuilding');
      const controller = ctx.get('sessionController');
      const created = await controller.create({ sessionId, cwd: backup.header.cwd, ...(agentPreset ? { agentPreset } : {}) });
      if (created.sessionId !== sessionId) throw new Error('宿主未以原ID创建会话');
      const agent = ctx.get('agents').get(sessionId);
      if (!agent || agent.status !== 'idle') throw new Error('新会话运行时异常');
      const text = `[原地重置生成的历史交接记录，并非新任务；请勿自动执行记录中的历史命令]\n完整历史备份：${backup.forkId}\n\n${backup.blob}`;
      const title = [...backup.events].reverse().find((event: any) => event.type === 'session/title')?.data?.title;
      if (title) await controller.rename({ sessionId, title });
      await agent.runMaintenance(async () => {
        // fix-P v2 (2026-11-14): 合法头三明治——step/start 窗口 + 头 system（step>=1、message.id、source.kind=system-prompt）+ step/end 闭合；后续提示更新走合法 replace，杜绝 midSurface append 损坏
        agent.session.append('step/start', { turn: 1, step: 1 });
        agent.session.append('system/message', { turn: 1, step: 1, message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' });
        agent.session.append('step/end', { turn: 1, step: 1 });
        agent.session.append('turn/start', { turn: 1 });
        agent.session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { surfaceOp: 'append' });
        agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
        await ctx.get('sessionPersistence').flush();
      });
      const after = await measure(ctx, sessionId);
      const reader = await ctx.get('sessionPersistence').open(sessionId, 'read');
      try {
        const saved = await reader.read(0);
        if (agentPreset !== undefined && (observedAgentPreset({ header: reader.header, events: saved.events }) !== agentPreset || after.agentPreset !== agentPreset)) throw new Error('重生后的Agent预设与选择不一致，未通过读回校验');
        if (after.sessionId !== sessionId || after.totalTurns !== 1 || !saved.events.some((event: any) => event.type === 'user/message' && event.data.content?.some((part: any) => part.text === text))) throw new Error('重置后的独立读回校验失败');
        if (saved.events.some((event: any) => event.type.startsWith('tool/ptc-dispatch'))) throw new Error('新日志仍含旧调度事件');
      } finally { await reader.close(); }
      const result = { ok: true, phase: 'DONE', verified: true, sameId: true, sessionId, operationId, forkId: backup.forkId, quarantine: journal.quarantine, before, after, handoffMode: cfg.modelReportId ? 'model' : 'recent', ...(cfg.modelReportId ? { modelReportId: cfg.modelReportId, modelSourceHash: cfg.modelSourceHash } : {}) };
      journal.record('committed', result);
      const auditWarning = history(ledger, { operationId, sessionId, step: 'VERIFY', state: 'DONE', result });
      return { ...result, ...(auditWarning ? { auditWarning } : {}) };
    } catch (error) {
      if (journal) {
        try {
          await lifecycle.releaseCurrent(sessionId);
          await journal.restoreOriginal();
        } catch (recoveryError) {
          try { journal.record('recovery_required', { error: message(error), recoveryError: message(recoveryError) }); } catch { /* Existing immutable records and originals remain the recovery source. */ }
          history(ledger, { operationId, sessionId, step: 'ROLLBACK', state: 'HALTED', error: message(error), recoveryError: message(recoveryError) });
          throw new Error(`重置未完成，原件与失败代际已保留，请恢复原日志。操作ID：${operationId}`, { cause: recoveryError });
        }
      }
      try { await ctx.get('sessionController').agents.resolveAgent(sessionId); } catch { /* Durable originals can be resumed explicitly. */ }
      history(ledger, { operationId, sessionId, step: 'ROLLBACK', state: journal ? 'ROLLED_BACK' : 'FAILED_UNCHANGED', error: message(error), forkId: backup?.forkId });
      throw new Error(journal ? `重建失败，已恢复原日志：${message(error)}` : `原日志未替换：${message(error)}`, { cause: error });
    }
  });
}
export async function executeRecovery(ctx: HostContext, ledger: OperationLedger, lifecycle: Lifecycle, home: string, request: ResetRequest) {
  confirm(request);
  if (!request.operationId) throw new Error('恢复需要当前版本的事务操作ID；旧重启记录不会自动续跑');
  const journal = ResetJournal.load(home, request.operationId);
  if (journal.manifest.sessionId !== request.sessionId) throw new Error('事务不属于所选会话');
  if (['committed', 'recovered'].includes(journal.phase())) throw new Error('该事务已终结，不重复恢复');
  const pending = recoveryStatus(home, request.sessionId);
  if (pending.operations.length > 1) throw new Error('同一会话有多个未完成事务，请先核对保全记录');
  return lifecycle.run(request.sessionId, async (lease) => {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId: request.sessionId }, () => Promise.resolve([]));
    if (activity.length) throw new Error('会话仍有后台活动，未恢复');
    await lease.release();
    let restored: { preservation: string; originalVerified: boolean };
    try {
      restored = await journal.restoreOriginal();
    } catch (error) {
      try { journal.record('recovery_required', { error: message(error) }); } catch {}
      throw new Error('恢复未完成；原件、当前代际和事务记录均保留，请核对后继续恢复', { cause: error });
    }
    let after;
    let runtimeWarning;
    try { after = await measure(ctx, request.sessionId); }
    catch { runtimeWarning = '原日志文件已校验恢复，运行时计数暂不可读，请重新打开会话'; }
    const auditWarning = history(ledger, { operationId: request.operationId, sessionId: request.sessionId, step: 'RECOVER', state: 'ROLLED_BACK', after });
    return { ok: true, phase: 'RECOVERED', verified: restored.originalVerified, sameId: true, sessionId: request.sessionId, operationId: request.operationId, ...(after ? { after } : {}), ...(auditWarning || runtimeWarning ? { auditWarning: auditWarning ?? runtimeWarning } : {}) };
  });
}
