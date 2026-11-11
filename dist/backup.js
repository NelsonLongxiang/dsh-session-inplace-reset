import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
        const fork = await ctx.get('sessionController').fork({ sessionId, atSeq: events.at(-1)?.seq });
        if (!fork.sessionId || fork.sessionId === sessionId)
            throw new Error('备份 ID 异常，原日志未替换');
        const forkId = fork.sessionId;
        record('FORK', { forkId });
        const persistence = ctx.get('sessionPersistence');
        await persistence.flush();
        const reader = await persistence.open(forkId, 'read');
        try {
            const saved = await reader.read(0);
            if (saved.events.length < events.length || !isDeepStrictEqual(saved.events.slice(0, events.length), events))
                throw new Error('备份事件前缀不完整，原日志未替换');
            record('VERIFY_F', { sourceCount: events.length, forkCount: saved.events.length });
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
        const row = ledger.append({ operationId, sessionId, step: 'LEDGER_COMMIT', state: 'BACKED_UP', forkId, sourceCount: events.length, sourceCwd: source.header.cwd, sidecar, handoffSize: size, handoffSha256: createHash('sha256').update(blob).digest('hex') });
        return { row, forkId, handoff, header: structuredClone(source.header), events, blob };
    }
    finally {
        source[Symbol.dispose]?.();
    }
}
