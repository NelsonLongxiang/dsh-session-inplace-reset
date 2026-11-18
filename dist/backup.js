import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
// 源日志按压缩后体积×该系数估算原始 JSON 体积，超过 fork 快照预算（默认 48MiB）即走
// 超大路径：宿主对巨史 fork 会构建超过 V8 字符串上限的单串，而 observeSession 的全量
// 事件数组与宿主 fork 的内部物化并存会把堆打爆（.88 事故：42MiB 压缩日志 OOM 3.5GB）。
// 估算只用于选择边界与分流，不作为完整性依据；完整原件始终由隔离区逐字节保全。
const DEFAULT_FORK_SNAPSHOT_LIMIT_BYTES = 48 * 1024 * 1024;
const ZSTD_RAW_RATIO = 5;
const HANDOFF_TAIL_EVENTS = 4096;
export function forkSnapshotLimitBytes(opts) {
    const kb = Number.isSafeInteger(opts?.forkSnapshotLimitKB) && opts.forkSnapshotLimitKB >= 1024 ? opts.forkSnapshotLimitKB : undefined;
    return kb ? kb * 1024 : DEFAULT_FORK_SNAPSHOT_LIMIT_BYTES;
}
export function isOversized(sizeBytes, limitBytes) {
    return (sizeBytes ?? 0) * ZSTD_RAW_RATIO > limitBytes;
}
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
/**
 * 超大会话的无 observe 快照：projections 取精确事件数与投影值，persistence 只读尾部窗口。
 * 返回的伪 observation 仅含小对象，供交接构建与模型主题读取使用。
 */
export async function observeFreeSnapshot(ctx, sessionId, limitBytes) {
    const persistence = ctx.get('sessionPersistence');
    const stat = await persistence.stat(sessionId);
    if (!isOversized(stat?.sizeBytes, limitBytes))
        return null;
    const projections = await ctx.get('sessionController').projections({ sessionId });
    if (!projections || projections.kind !== 'sequenced')
        throw new Error('超大会话的投影暂不可用（迁移中），未执行重置');
    const lastSeq = projections.asOfSeq;
    if (!(Number.isSafeInteger(lastSeq) && lastSeq >= 0))
        throw new Error('超大会话的事件游标不可读，未执行重置');
    const reader = await persistence.open(sessionId, 'read');
    let header;
    let tail;
    try {
        header = structuredClone(reader.header);
        tail = (await reader.read(Math.max(0, lastSeq - HANDOFF_TAIL_EVENTS + 1))).events;
    }
    finally {
        await reader.close();
    }
    return {
        oversized: true,
        sizeBytes: stat.sizeBytes,
        lastSeq,
        totalEvents: lastSeq + 1,
        header,
        tail,
        values: projections.values ?? {},
        pseudo: { header, cursor: lastSeq, projections: { asOfSeq: lastSeq, values: projections.values ?? {} } },
    };
}
export async function runBackupPhase(ctx, ledger, sessionId, opts) {
    const operationId = opts.operationId ?? randomUUID();
    const record = (step, detail) => ledger.append({ operationId, sessionId, step, state: 'RUNNING', detail });
    const limitBytes = forkSnapshotLimitBytes(opts);
    const persistence = ctx.get('sessionPersistence');
    const snapshot = await observeFreeSnapshot(ctx, sessionId, limitBytes);
    if (snapshot) {
        // 超大路径：不物化全量事件；边界按预算/估算体积比例截取前缀，核验为结构化校验，
        // 完整性由隔离区逐字节原件担保（恢复入口始终回迁原件）。
        const handoff = await opts.buildHandoff(snapshot.tail, opts, snapshot.pseudo);
        const blob = JSON.stringify(handoff);
        const size = Buffer.byteLength(blob);
        if (size > opts.handoffHardCapKB * 1024)
            throw new Error('交接包超过体积上限，原日志未替换');
        record('HANDOFF_BUILD', { size, k: handoff.k, mode: opts.modelReportId ? 'model' : 'recent', tailEvents: snapshot.tail.length, ...(opts.modelReportId ? { reportId: opts.modelReportId, sourceHash: opts.modelSourceHash } : {}) });
        const coverage = Math.min(1, limitBytes / (snapshot.sizeBytes * ZSTD_RAW_RATIO));
        const boundary = Math.max(0, Math.floor((snapshot.totalEvents - 1) * coverage * 0.85));
        const fork = await ctx.get('sessionController').fork({ sessionId, atSeq: boundary });
        if (!fork.sessionId || fork.sessionId === sessionId)
            throw new Error('备份 ID 异常，原日志未替换');
        const forkId = fork.sessionId;
        record('FORK', { forkId, trimmedToSeq: boundary, skippedEvents: snapshot.totalEvents - boundary - 1, boundaryBasis: 'estimated' });
        await persistence.flush();
        const forkReader = await persistence.open(forkId, 'read');
        try {
            const saved = await forkReader.read(0);
            if (saved.events.length < boundary + 1)
                throw new Error('备份快照事件数不足，原日志未替换');
            for (let i = 0; i <= boundary; i++)
                if (saved.events[i].seq !== i)
                    throw new Error('备份快照事件序号不连续，原日志未替换');
            record('VERIFY_F', { mode: 'structural', sourceCount: snapshot.totalEvents, verifiedCount: boundary + 1, forkCount: saved.events.length });
        }
        finally {
            await forkReader.close();
        }
        await ctx.get('workspaceRegistry').archiveSession(forkId);
        record('ARCHIVE_F', { forkId });
        const sidecar = `handoff-${operationId}.json`;
        const directory = join(opts.home, 'session-reset');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, sidecar), blob, { encoding: 'utf8', flag: 'wx' });
        const row = ledger.append({ operationId, sessionId, step: 'LEDGER_COMMIT', state: 'BACKED_UP', forkId, trimmedToSeq: boundary, skippedEvents: snapshot.totalEvents - boundary - 1, sourceCount: snapshot.totalEvents, sourceCwd: snapshot.header.cwd, sidecar, handoffSize: size, handoffSha256: createHash('sha256').update(blob).digest('hex') });
        return { row, forkId, trimmedToSeq: boundary, skippedEvents: snapshot.totalEvents - boundary - 1, handoff, header: snapshot.header, blob, title: snapshot.values.title, sourceCount: snapshot.totalEvents };
    }
    const source = await ctx.sessionQuery.observeSession(sessionId);
    try {
        const events = source.events;
        let title;
        for (let i = events.length - 1; i >= 0; i--)
            if (events[i].type === 'session/title') {
                title = events[i].data?.title;
                break;
            }
        const handoff = await opts.buildHandoff(events, opts, source);
        const blob = JSON.stringify(handoff);
        const size = Buffer.byteLength(blob);
        if (size > opts.handoffHardCapKB * 1024)
            throw new Error('交接包超过体积上限，原日志未替换');
        record('HANDOFF_BUILD', { size, k: handoff.k, mode: opts.modelReportId ? 'model' : 'recent', ...(opts.modelReportId ? { reportId: opts.modelReportId, sourceHash: opts.modelSourceHash } : {}) });
        const stat = await persistence.stat(sessionId);
        let boundary = events.length - 1;
        if (isOversized(stat?.sizeBytes, limitBytes))
            boundary = tailBoundary(events, limitBytes);
        const trimmed = boundary < events.length - 1;
        const expected = trimmed ? events.slice(0, boundary + 1) : events;
        const fork = await ctx.get('sessionController').fork({ sessionId, atSeq: expected.at(-1)?.seq });
        if (!fork.sessionId || fork.sessionId === sessionId)
            throw new Error('备份 ID 异常，原日志未替换');
        const forkId = fork.sessionId;
        record('FORK', { forkId, ...(trimmed ? { trimmedToSeq: expected.at(-1)?.seq, skippedEvents: events.length - expected.length } : {}) });
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
        return { row, forkId, ...(trimmed ? { trimmedToSeq: expected.at(-1)?.seq } : {}), handoff, header: structuredClone(source.header), blob, title, sourceCount: events.length };
    }
    finally {
        source[Symbol.dispose]?.();
    }
}
