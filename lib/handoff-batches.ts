import type { Candidate } from './handoff-eval.ts';

export const MAX_BATCHES = 64;
export const MAX_BATCH_CANDIDATES = 32;
export const MAX_BATCH_BYTES = 48 * 1024;
export const MAX_EVALUATION_CALLS = 192;
export const MAX_PARALLEL_REQUESTS = 4;
export interface CandidateBatch { candidates: Candidate[]; context: Candidate[] }

/** Stop scheduling after an error, drain in-flight requests, and retain source batch order. */
export async function runBatches<T>(batches: CandidateBatch[], run: (batch: CandidateBatch, index: number) => Promise<T>) {
  const results = Array.from<T | undefined>({ length: batches.length });
  let next = 0, failed = false;
  let error: unknown;
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_REQUESTS, batches.length) }, async () => {
    while (!failed && next < batches.length) {
      const index = next++;
      try { results[index] = await run(batches[index], index); }
      catch (reason) { if (!failed) error = reason; failed = true; }
    }
  }));
  return { results, failed, error };
}

/** Preserve source anchors in every context; score each candidate at most once and disclose everything outside the bound. */
export function candidateBatches(candidates: Candidate[], { quoted = [] as Candidate[], maxBatches = MAX_BATCHES, reservedBytes = 0 } = {}) {
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) throw new Error('invalid shared context budget');
  if (maxBatches <= 0) return [] as CandidateBatch[];
  const latestUser = candidates.findLast((row) => row.role === 'user' && row.sourceKind === 'user' && !row.historical);
  const latestUserStart = latestUser && candidates.find((row) => row.seq === latestUser.seq && row.origin === latestUser.origin);
  const anchors = [...new Map([candidates.at(-1), candidates[0], latestUser, latestUserStart].filter((row): row is Candidate => !!row).map((row) => [row.id, row])).values()];
  const anchored = new Set(anchors.map((row) => row.id));
  const queue = [...anchors, ...candidates.filter((row) => !anchored.has(row.id))];
  const contextFor = (rows: Candidate[]) => [...new Map([...anchors, ...rows].map((row) => [row.id, row])).values()].sort((a, b) => a.order - b.order);
  const batches: CandidateBatch[] = [];
  let current: Candidate[] = [];
  const fits = (rows: Candidate[]) => {
    const context = contextFor(rows);
    const ids = new Set(context.map((row) => row.id));
    const matchingQuotes = quoted.filter((row) => ids.has(row.id));
    return context.length <= MAX_BATCH_CANDIDATES && Buffer.byteLength(JSON.stringify(context)) + Buffer.byteLength(JSON.stringify(matchingQuotes)) + reservedBytes <= MAX_BATCH_BYTES - 1024;
  };
  for (const candidate of queue) {
    if (!fits([...current, candidate])) {
      if (current.length) batches.push({ candidates: current, context: contextFor(current) });
      current = [];
      if (batches.length >= maxBatches) break;
      if (!fits([candidate])) continue;
    }
    current.push(candidate);
  }
  if (current.length && batches.length < maxBatches) batches.push({ candidates: current, context: contextFor(current) });
  return batches;
}
