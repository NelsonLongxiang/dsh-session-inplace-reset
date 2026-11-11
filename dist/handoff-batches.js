export const MAX_BATCHES = 64;
export const MAX_BATCH_CANDIDATES = 32;
export const MAX_BATCH_BYTES = 48 * 1024;
export const MAX_EVALUATION_CALLS = 192;
/** Preserve source anchors in every context; score each candidate at most once and disclose everything outside the bound. */
export function candidateBatches(candidates, { quoted = [], maxBatches = MAX_BATCHES } = {}) {
    if (maxBatches <= 0)
        return [];
    const latestUser = candidates.findLast((row) => row.role === 'user' && row.sourceKind === 'user' && !row.historical);
    const latestUserStart = latestUser && candidates.find((row) => row.seq === latestUser.seq && row.origin === latestUser.origin);
    const anchors = [...new Map([candidates.at(-1), candidates[0], latestUser, latestUserStart].filter((row) => !!row).map((row) => [row.id, row])).values()];
    const anchored = new Set(anchors.map((row) => row.id));
    const queue = [...anchors, ...candidates.filter((row) => !anchored.has(row.id))];
    const contextFor = (rows) => [...new Map([...anchors, ...rows].map((row) => [row.id, row])).values()].sort((a, b) => a.order - b.order);
    const batches = [];
    let current = [];
    const fits = (rows) => {
        const context = contextFor(rows);
        const ids = new Set(context.map((row) => row.id));
        const matchingQuotes = quoted.filter((row) => ids.has(row.id));
        return context.length <= MAX_BATCH_CANDIDATES && Buffer.byteLength(JSON.stringify(context)) + Buffer.byteLength(JSON.stringify(matchingQuotes)) <= MAX_BATCH_BYTES - 1024;
    };
    for (const candidate of queue) {
        if (!fits([...current, candidate])) {
            if (current.length)
                batches.push({ candidates: current, context: contextFor(current) });
            current = [];
            if (batches.length >= maxBatches)
                break;
            if (!fits([candidate]))
                continue;
        }
        current.push(candidate);
    }
    if (current.length && batches.length < maxBatches)
        batches.push({ candidates: current, context: contextFor(current) });
    return batches;
}
