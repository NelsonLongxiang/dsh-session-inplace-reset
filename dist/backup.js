import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
// 超过该字节数的源日志，备份 fork 改为预算内的尾部快照：宿主 fork 对巨史会构建
// 超过 V8 字符串上限的单串（RangeError: Invalid string length，issue #1）。
// 完整原件始终由隔离区逐字节 SHA-256 指纹保全，不依赖 fork 快照。
const DEFAULT_FORK_SNAPSHOT_LIMIT_BYTES = 48 * 1024 * 1024;
/** 递归字节估算，不构造任何大字符串；只用于选择尾部边界，不作为完整性依据。 */
function estimateBytes(value) {
    if (typeof value === 'string')
        return value.length * 2 + 2;
    if (typeof value === 'number' || typeof value === 'boolean')
        return 8;
    if (value === null || value === undefined)
        return 4;
    if (Array.isArray(value)) {
        let sum = 2;
        for (const item of value)
            sum += estimateBytes(item) + 2;
        return sum;
    }
    if (typeof value === 'object') {
        let sum = 2;
        for (const [key, item] of Object.entries(value))
            sum += key.length * 2 + 4 + estimateBytes(item);
        return sum;
    }
    return 8;
}
/** 从头累计估算，返回不超过预算的最大含端前缀下标；首个事件超预算时取 0。 */
function tailBoundary(events, limitBytes) {
    let acc = 0;
    for (let i = 0; i < events.length; i++) {
        acc += estimateBytes(events[i]);
        if (acc > limitBytes && i > 0)
            return i - 1;
    }
    return events.length - 1;
}
export async function runBackupPhase(ctx, ledger, sessionId, opts) {
    const operationId = opts.operationId ?? randomUUID();
    const source = await ctx.sessionQuery.observeSession(sessionId);
    const record = (step, detail) => ledger.append({ operationId, sessionId, step, state: 'RUNNING', detail });
    try {
        const events = source.events;
        const handoff = await opts.buildHandoff(events, opts, source);
        const blob = JSON.stringify(handoff);
        const size = Buffer.byteLength(blob);
        if (size > opts.handoffHardCapKB * 1024)
            throw new Error('交接包超过体积上限，原日志未替换');
        record('HANDOFF_BUILD', { size, k: handoff.k, mode: opts.modelReportId ? 'model' : 'recent', ...(opts.modelReportId ? { reportId: opts.modelReportId, sourceHash: opts.modelSourceHash } : {}) });
        const limitBytes = Number.isSafeInteger(opts.forkSnapshotLimitKB) && opts.forkSnapshotLimitKB >= 1024 ? opts.forkSnapshotLimitKB * 1024 : DEFAULT_FORK_SNAPSHOT_LIMIT_BYTES;
        const stat = await ctx.get('sessionPersistence').stat(sessionId);
        let boundary = events.length - 1;
        if ((stat?.sizeBytes ?? 0) > limitBytes)
            boundary = tailBoundary(events, limitBytes);
        const trimmed = boundary < events.length - 1;
        const expected = trimmed ? events.slice(0, boundary + 1) : events;
        const fork = await ctx.get('sessionController').fork({ sessionId, atSeq: expected.at(-1)?.seq });
        if (!fork.sessionId || fork.sessionId === sessionId)
            throw new Error('备份 ID 异常，原日志未替换');
        const forkId = fork.sessionId;
        record('FORK', { forkId, ...(trimmed ? { trimmedToSeq: expected.at(-1)?.seq, skippedEvents: events.length - expected.length } : {}) });
        const persistence = ctx.get('sessionPersistence');
        await persistence.flush();
        const reader = await persistence.open(forkId, 'read');
        try {
            const saved = await reader.read(0);
            if (saved.events.length < expected.length || !isDeepStrictEqual(saved.events.slice(0, expected.length), expected))
                throw new Error('备份事件前缀不完整，原日志未替换');
            record('VERIFY_F', { sourceCount: events.length, verifiedCount: expected.length, forkCount: saved.events.length });
        }
        finally {
            await reader.close();
        }
        await ctx.get('workspaceRegistry').archiveSession(forkId);
        record('ARCHIVE_F', { forkId });
        const sidecar = `handoff-${operationId}.json`;
        const directory = join(opts.home, 'session-reset');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, sidecar), blob, { encoding: 'utf8', flag: 'wx' });
        const row = ledger.append({ operationId, sessionId, step: 'LEDGER_COMMIT', state: 'BACKED_UP', forkId, ...(trimmed ? { trimmedToSeq: expected.at(-1)?.seq } : {}), sourceCount: events.length, sourceCwd: source.header.cwd, sidecar, handoffSize: size, handoffSha256: createHash('sha256').update(blob).digest('hex') });
        return { row, forkId, ...(trimmed ? { trimmedToSeq: expected.at(-1)?.seq } : {}), handoff, header: structuredClone(source.header), events, blob };
    }
    finally {
        source[Symbol.dispose]?.();
    }
}
