import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
/** Historical damaged tails stay untouched; each process writes a fresh, fsynced generation. */
export class Ledger {
    rows = [];
    warnings = [];
    path;
    constructor(home) {
        const root = join(home, 'session-reset');
        mkdirSync(root, { recursive: true });
        const legacy = join(root, 'ledger.json');
        if (existsSync(legacy)) {
            try {
                if (lstatSync(legacy).isSymbolicLink())
                    throw new Error('linked file');
                const values = JSON.parse(readFileSync(legacy, 'utf8'));
                if (!Array.isArray(values))
                    throw new Error('not an array');
                this.rows.push(...values);
            }
            catch {
                this.warnings.push('旧账本 ledger.json 无法完整读取，原文件保留');
            }
        }
        for (const name of readdirSync(root).filter((name) => /^operations(?:-[a-f0-9-]+)?\.jsonl$/.test(name)).sort()) {
            if (lstatSync(join(root, name)).isSymbolicLink()) {
                this.warnings.push(`${name} 是链接，未读取`);
                continue;
            }
            const lines = readFileSync(join(root, name), 'utf8').split('\n');
            for (const [index, line] of lines.entries())
                if (line.trim()) {
                    try {
                        const row = JSON.parse(line);
                        if (!row || typeof row !== 'object' || Array.isArray(row))
                            throw new Error('not a record');
                        this.rows.push(row);
                    }
                    catch {
                        this.warnings.push(`${name} 第${index + 1}行不可读，原文件保留`);
                    }
                }
        }
        this.path = join(root, `operations-${randomUUID()}.jsonl`);
    }
    append(record) {
        const row = { at: Date.now(), ...record };
        const descriptor = openSync(this.path, 'a', 0o600);
        try {
            appendFileSync(descriptor, `${JSON.stringify(row)}\n`, 'utf8');
            fsyncSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
        this.rows.push(row);
        return row;
    }
}
