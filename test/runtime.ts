import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const webUrl = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
export const cdpUrl = process.env.DSH_CDP_URL ?? 'http://127.0.0.1:18080';
export const testSourceSession = process.env.DSH_TEST_SOURCE_SESSION;
