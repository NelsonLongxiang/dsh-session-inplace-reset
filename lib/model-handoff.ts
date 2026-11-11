import { isDeepStrictEqual } from 'node:util';
import { candidatesFrom, outcome, RUBRIC, SAMPLER, sourceDigest } from './handoff-eval.ts';
import type { PreviewReport, SourceSnapshot } from './handoff-eval.ts';

export interface ModelChoice { modelReportId: string; sourceHash: string }
export type ModelReport = PreviewReport & { reportId: string; evaluationApiBase?: string; checkedAt?: string };
export interface CachedPreview { report: ModelReport; connectionKey: string }
export function assertModelChoice(value: unknown): asserts value is ModelChoice {
  const input = value as Partial<ModelChoice> | null;
  if (!input || typeof input.modelReportId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.modelReportId) || typeof input.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.sourceHash)) throw new Error('请选择当前模型候选报告；缺少报告ID或源摘要');
}

/** Execution accepts only the cached report, current source and current connection; no client-supplied seed is trusted. */
export function approvedModelHandoff(entry: CachedPreview | undefined, choice: ModelChoice, current: { snapshot: SourceSnapshot; connectionKey: string; targetBytes: number; hardCapBytes: number }) {
  assertModelChoice(choice);
  if (!entry || entry.connectionKey !== current.connectionKey) throw new Error('候选已失效或评估配置已更改，请重新预览');
  const report = entry.report;
  const digest = sourceDigest(current.snapshot);
  if (report.reportId !== choice.modelReportId || report.sourceHash !== choice.sourceHash || digest !== report.sourceHash || report.sessionId !== current.snapshot.sessionId || report.cursor !== current.snapshot.cursor || report.rubric !== RUBRIC || report.sampler !== SAMPLER || report.targetBytes !== current.targetBytes) throw new Error('会话或候选版本已变化，请重新预览');
  const { candidates, coverage } = candidatesFrom(current.snapshot.messages);
  const expectedChecks = ['constraints', 'state', 'faithful'];
  if (report.mode !== 'shadow' || report.applied !== false || report.status !== 'pass' || !coverage.complete || !report.coverage.complete || report.coverage.total !== coverage.total || report.coverage.assessed !== coverage.assessed || report.budgetOmissions !== 0 || !report.selected.length || report.checks.length !== 3 || !expectedChecks.every((key) => report.checks.filter((check) => check.key === key && check.outcome === 'pass' && Number.isFinite(check.probability) && check.probability >= 0.7 && check.probability <= 1).length === 1)) throw new Error('候选未完整通过核对，未用于重置');
  const conservative = report.strategy === 'conservative';
  if (conservative && report.selected.length !== candidates.length) throw new Error('保守候选必须保留完整原文，未用于重置');
  const identities = new Set<string>();
  for (const row of report.selected) {
    const original = candidates.find((candidate) => candidate.id === row.id);
    if (!original || identities.has(row.id) || !Object.entries(original).every(([key, value]) => row[key as keyof typeof row] === value) || row.retention === 'pending' || !Number.isFinite(row.retainProbability) || row.retainProbability < 0 || row.retainProbability > 1 || outcome(row.retainProbability) !== row.retention || !conservative && row.retention !== 'pass' || !Number.isFinite(row.supersededProbability) || row.supersededProbability < 0 || row.supersededProbability > 1 || !['pass', 'fail'].includes(row.superseded) || outcome(row.supersededProbability) !== row.superseded) throw new Error('候选原文、来源或保留判定不可校验，未用于重置');
    identities.add(row.id);
  }
  const handoff = report.handoff;
  if (!handoff || handoff.kind !== 'handoff-seed' || handoff.version !== 3 || handoff.sourceSessionId !== current.snapshot.sessionId || handoff.capturedThroughSeq !== current.snapshot.cursor || handoff.historicalOnly !== true || !isDeepStrictEqual(handoff.selected_messages, report.selected.map((row) => candidates.find((candidate) => candidate.id === row.id)!))) throw new Error('候选交接包与报告不一致，未用于重置');
  const size = Buffer.byteLength(JSON.stringify(handoff));
  if (!Number.isSafeInteger(current.hardCapBytes) || size !== report.size || size > current.targetBytes || size > current.hardCapBytes) throw new Error('候选交接包超出执行预算，未截断或替换为其他采样');
  return structuredClone(handoff);
}
