// Uses its own target on the owner's CDP endpoint; destructive mode requires an explicitly labelled test session.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { webUrl, cdpUrl } from './runtime.ts';
import { Ledger } from '../lib/ledger.ts';
import { ResetJournal } from '../lib/reset-journal.ts';
import { canonicalContinuationGoal } from '../lib/handoff-eval.ts';
import { sealContinuation, CONTINUATION_VERSION } from '../lib/continuation-context.ts';

const cdp = cdpUrl;
const base = webUrl.replace(/\/$/, '');
const run = new Date().toISOString().replace(/[:.]/g, '-');
const out = join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `menu-${run}`);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

await mkdir(out, { recursive: true });
const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
try { await writeFile(join(out, 'target.json'), JSON.stringify({ id: target.id, createdBy: 'browser-menu.mjs', run }, null, 2), { flag: 'wx' }); }
catch (error) { await fetch(`${cdp}/json/close/${target.id}`); throw error; }
const browserUrl = `${base}/?reset-preview-test=${encodeURIComponent(run)}`;
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const requests = [];
const diagnostics = [];
let nextId = 0;
let rejectPreview = false;
let simulatedExecute = null;
let simulatedModel = null;
let simulatedTask = null;
let wrongProgressSession = false;
let simulatedTopics = false;
let simulatedTopicUnavailable = false;
let simulatedTopicTask = null;
let staleTopic = false;
const realModelAllowed = process.argv.includes('--model-preview') || process.argv.includes('--use-model');
const evaluationSettingsMode = process.argv.includes('--evaluation-settings');
const recoveryMode = process.argv.includes('--recovery-list');
const recoveryFixture = { operationId: crypto.randomUUID(), sessionId: `session-${crypto.randomUUID()}`, backupId: `session-${crypto.randomUUID()}`, phase: 'quarantined', createdAt: new Date().toISOString() };
let savedEvaluationSettings = null;
const settingsWrites = [];
const executionOption = process.argv.indexOf('--execute-test-session');
const permittedExecutionId = executionOption === -1 ? null : process.argv[executionOption + 1];
const topicOption = process.argv.indexOf('--topics-session');
const permittedTopicId = topicOption < 0 ? null : process.argv[topicOption + 1];

function send(method, params = {}, timeout = 15_000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const promise = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) promise?.reject(new Error(message.error.message));
    else promise?.resolve(message.result);
  } else if (message.method === 'Runtime.consoleAPICalled') {
    const text = message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
    if (text.includes('[session-reset]')) diagnostics.push(text.slice(0, 900));
  } else if (message.method === 'Fetch.requestPaused') {
    const { requestId, request } = message.params;
    const body = JSON.parse(request.postData);
    requests.push({ method: body.method, sessionId: body.payload.args.sessionId ?? body.payload.args.request?.sessionId, modelReportId: body.payload.args.request?.modelReportId, sourceHash: body.payload.args.request?.sourceHash, agentPreset: body.payload.args.request?.agentPreset, taskId: body.payload.args.request?.taskId, continuationGoal: body.payload.args.request?.continuationGoal });
    if (recoveryMode && (body.method.endsWith('/sessionResetRecoveries') || body.method.endsWith('/sessionResetRecoveryStatus'))) {
      const value = { ...(body.payload.args.sessionId ? { sessionId: body.payload.args.sessionId } : {}), operations: [recoveryFixture], issues: [], warnings: [] };
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (body.method.endsWith('/sessionResetResume')) {
      const input = body.payload.args.request;
      const allowed = recoveryMode && input.sessionId === recoveryFixture.sessionId && input.operationId === recoveryFixture.operationId && input.confirmShortId === recoveryFixture.sessionId.slice(8, 16);
      const response = JSON.stringify({ rpcId: body.rpcId, result: allowed ? { ok: true, value: { ok: true, phase: 'RECOVERED', verified: true, sameId: true, sessionId: input.sessionId, operationId: input.operationId } } : { ok: false, error: { message: 'Browser test blocked a recovery write' } } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (body.method.endsWith('/sessionResetSaveEvaluationSettings')) {
      const input = body.payload.args.request;
      settingsWrites.push({ apiBase: input.apiBase, suppliedKey: !!input.apiKey });
      const value = evaluationSettingsMode ? { apiBase: input.apiBase === 'https://eval.example.test' ? 'https://eval.example.test/v4/ai/evaluation-model' : input.apiBase, configured: true, hasSavedKey: true, usingDefault: false, writable: true } : null;
      if (value) savedEvaluationSettings = value;
      const response = JSON.stringify({ rpcId: body.rpcId, result: value ? { ok: true, value } : { ok: false, error: { message: 'Browser test blocked a credential write' } } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (body.method.endsWith('/sessionResetEvaluationSettings') && savedEvaluationSettings) {
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: savedEvaluationSettings } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (body.method.endsWith('/sessionResetTopicPreviewStart') && simulatedTopics) {
      simulatedTopicTask = { taskId: crypto.randomUUID(), sessionId: body.payload.args.sessionId, startedAt: new Date().toISOString(), model: { provider: 'session-fixture-provider', model: 'current-session-model', reasoningEffort: 'high' }, modelSource: 'session', progress: { phase: 'topics', completedBatches: 0, totalBatches: 2, running: 2, concurrency: 4, requests: 2 } };
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { ...simulatedTopicTask, running: true } } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (body.method.endsWith('/sessionResetTopicPreviewStatus') && simulatedTopicTask?.taskId === body.payload.args.request?.taskId) {
      const value = { ...simulatedTopicTask, running: false, progress: { ...simulatedTopicTask.progress, phase: 'complete', completedBatches: 2, running: 0 }, ...(staleTopic ? { error: '会话内容或模型已变化，请重新分析候选主题' } : { report: { sessionId: simulatedTopicTask.sessionId, cursor: 2, sourceHash: 'b'.repeat(64), model: simulatedTopicTask.model, modelSource: 'session', status: simulatedTopicUnavailable ? 'unavailable' : 'ready', note: '浏览器模拟主题；原文引用仅用于UI验收。', coverage: { total: 2, assessed: 2, complete: true, materialMessages: 2, sourceMessages: 10 }, requests: 2, peakConcurrency: 2, topics: simulatedTopicUnavailable ? [] : [{ id: 'topic-1', title: '上下文重置与主题分析', goal: '继续实现上下文重置与候选主题分析', evidence: [{ id: 'c0', seq: 0, role: 'user', historical: false, quote: '继续实现上下文重置' }] }, { id: 'topic-2', title: '库存差异核对', goal: '继续库存差异核对并保留业务边界', evidence: [{ id: 'c1', seq: 1, role: 'user', historical: false, quote: '库存差异仍待核对' }] }] } }) };
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (/\/sessionResetTopicPreview/.test(body.method) && permittedTopicId && (body.payload.args.sessionId ?? body.payload.args.request?.sessionId) === permittedTopicId) {
      void send('Fetch.continueRequest', { requestId });
    } else if (/\/sessionResetTopicPreview/.test(body.method)) {
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: false, error: { message: 'Browser test blocked an unexpected paid topic analysis' } } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (/\/sessionResetModelPreviewStart(?:WithGoal)?$/.test(body.method) && simulatedModel) {
      const input = body.payload.args.request ?? body.payload.args;
      const original = simulatedModel.selected[0];
      const entries = original ? [{ candidate: { id: original.id, seq: original.seq, role: original.role, sourceKind: original.sourceKind, text: original.text, origin: String(original.seq), historical: false, offset: 0, order: 0 }, kinds: ['task', 'constraint'], probabilities: { task: 0.95, constraint: 0.95, change: 0.05 }, resolved: { probability: 0.05, outcome: 'fail' } }] : [];
      const context = sealContinuation({ version: CONTINUATION_VERSION, goal: canonicalContinuationGoal(input.continuationGoal), scopeOnly: true, sourceHash: simulatedModel.sourceHash, hash: '', entries, coverage: simulatedModel.coverage, resolutionComplete: true, uncertain: false, overflow: false });
      simulatedTask = { taskId: crypto.randomUUID(), sessionId: input.sessionId, startedAt: new Date().toISOString(), report: { ...simulatedModel, sessionId: input.sessionId, continuation: context, concurrency: 4, peakConcurrency: 4 }, step: 0, hold: simulatedModel.status === 'pass' };
      simulatedModel = null;
      const value = { ...simulatedTask, report: undefined, running: true, progress: { phase: 'inventory', completedBatches: 0, totalBatches: 5, running: 4, concurrency: 4, requestCount: 4, requestLimit: 192, assessed: 0, sourceTotal: simulatedTask.report.coverage.total } };
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (body.method.endsWith('/sessionResetModelPreviewStatus') && simulatedTask?.taskId === body.payload.args.request?.taskId) {
      simulatedTask.step = Math.min(simulatedTask.step + 1, simulatedTask.hold ? 2 : 3);
      const step = simulatedTask.step;
      const value = { sessionId: wrongProgressSession ? `session-${crypto.randomUUID()}` : simulatedTask.sessionId, taskId: simulatedTask.taskId, startedAt: simulatedTask.startedAt, running: step < 3, progress: { phase: step < 2 ? 'resolution' : step === 2 ? 'audit' : 'complete', completedBatches: step === 3 ? 1 : 2, totalBatches: step === 3 ? 1 : 5, running: step < 3 ? 3 : 0, concurrency: 4, requestCount: step === 1 ? 4 : step === 2 ? 8 : 10, requestLimit: 192, catalogued: simulatedTask.report.coverage.assessed, assessed: step < 2 ? Math.min(60, simulatedTask.report.coverage.total) : simulatedTask.report.coverage.assessed, sourceTotal: simulatedTask.report.coverage.total }, ...(step === 3 ? { report: simulatedTask.report } : {}) };
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (/\/sessionResetModelPreview(?:Start(?:WithGoal)?|Status)?$/.test(body.method) && !realModelAllowed && !process.argv.includes('--model-api-probe')) {
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: false, error: { message: 'Browser test blocked an unexpected model request' } } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if ((body.method.endsWith('/sessionResetExecute') || body.method.endsWith('/sessionResetExecuteModel')) && (!permittedExecutionId || body.payload.args.request?.sessionId !== permittedExecutionId)) {
      const value = simulatedExecute ?? { ok: false, phase: 'HALTED', reason: 'Browser test blocked an unexpected execute request' };
      simulatedExecute = null;
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else if (rejectPreview && body.method.endsWith('/sessionResetDryRun')) {
      rejectPreview = false;
      const response = JSON.stringify({ rpcId: body.rpcId, result: { ok: false, error: { message: '预览失败验证' } } });
      void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(response).toString('base64') });
    } else {
      void send('Fetch.continueRequest', { requestId });
    }
  } else if (message.method === 'Page.javascriptDialogOpening') {
    void send('Page.handleJavaScriptDialog', { accept: false });
  }
});

async function evaluate(expression) {
  const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result?.value;
}

async function until(expression, description, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let value;
    try { value = await evaluate(expression); }
    catch (error) {
      if (!/Execution context|execution context|Cannot find context|target navigated/.test(error.message)) throw error;
    }
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Not observed: ${description}`);
}

async function ensureRowVisible(sessionId) {
  if (await evaluate(`!!document.querySelector('[data-row-key="session:${sessionId}"]')`)) return;
  await evaluate(`document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]').forEach(row => row.click())`);
  await until(`(() => { document.querySelectorAll('button').forEach(button => { if (/^展开其余 \\d+ 个会话$|^Show \\d+ more sessions$/.test(button.textContent.trim())) button.click(); }); return !!document.querySelector('[data-row-key="session:${sessionId}"]'); })()`, 'target session visible after expanding groups', 15000);
}

async function openMenu(sessionId) {
  await ensureRowVisible(sessionId);
  return evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-row-key]')].find(row => row.dataset.rowKey === ${JSON.stringify(`session:${sessionId}`)});
    if (!row) throw new Error('Session row missing');
    row.scrollIntoView({ block: 'nearest' });
    const trigger = row.querySelector('[class*="rowActions"] button');
    if (!trigger) throw new Error('Session menu trigger missing');
    trigger.click();
    return true;
  })()`);
}

async function openPreview(sessionId) {
  await openMenu(sessionId);
  await until(`(() => { const entries = [...document.querySelectorAll('[role="menuitem"]')].filter(el => el.textContent.trim().endsWith('原地重置…')); return entries.length === 1; })()`, 'single reset menu item');
  await evaluate(`document.querySelector('[role="menuitem"]') && [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.trim().endsWith('原地重置…')).click()`);
  await until(`document.querySelector('[data-inplace-reset-session]')?.getAttribute('data-inplace-reset-session') === ${JSON.stringify(sessionId)}`, 'dialog for the chosen row');
}

async function closePreview() {
  await evaluate(`(() => { const button = [...document.querySelectorAll('[role="dialog"] button')].find(el => el.textContent.trim() === '关闭'); if (!button) throw new Error('Close button missing'); button.click(); })()`);
  await until(`!document.querySelector('[data-inplace-reset-session]')`, 'dialog closed');
}

async function captureTopicOptions(required, name) {
  await evaluate(`document.querySelector('[data-inplace-reset-topic-options]').scrollIntoView({ block: 'center' })`);
  const options = await evaluate(`(() => {
    const frame = document.querySelector('[data-inplace-reset-session]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-inplace-reset-topic-option]')].map(row => {
      const box = row.getBoundingClientRect(), input = row.querySelector('input');
      return { id: row.dataset.inplaceResetTopicOption, title: row.textContent.trim(), checked: input.checked, top: box.top, bottom: box.bottom, visible: box.width > 0 && box.height > 0 && box.top >= Math.max(0, frame.top) && box.bottom <= Math.min(innerHeight, frame.bottom) && getComputedStyle(row).visibility !== 'hidden' };
    });
  })()`);
  assert.ok(options.length >= required, `Expected at least ${required} topic choices`);
  assert.equal(await evaluate(`Number(document.querySelector('[data-inplace-reset-topic-count]').dataset.inplaceResetTopicCount)`), options.length);
  assert.ok(options.every((option) => option.visible), 'Every topic choice must be simultaneously inside the visible dialog viewport');
  const clip = await evaluate(`(() => { const b = document.querySelector('[role="dialog"]').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 }; })()`);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', clip });
  await writeFile(join(out, `${name}.png`), Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
  await writeFile(join(out, `${name}.json`), JSON.stringify(options, null, 2), { flag: 'wx' });
  return options;
}

try {
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: browserUrl });
  await until(`document.readyState === 'complete'`, 'page ready');
  assert.equal(await evaluate(`document.body.innerText.includes('authentication required')`), false, 'The specified shared CDP browser must already be authenticated; its login state was not changed');
  await until(`document.querySelectorAll('[data-row-key^="session:"]').length >= 2`, 'two session rows', 40_000);
  assert.equal(await evaluate(`document.body.innerText.includes('Failed to load plugins')`), false);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*sessionReset/sessionResetEvaluationSettings', requestStage: 'Request' }, { urlPattern: '*sessionReset/sessionResetSaveEvaluationSettings', requestStage: 'Request' }, { urlPattern: '*sessionReset/sessionResetDryRun', requestStage: 'Request' }, { urlPattern: '*sessionReset/sessionResetTopicPreview*', requestStage: 'Request' }, { urlPattern: '*sessionReset/sessionResetModelPreview*', requestStage: 'Request' }, { urlPattern: '*sessionReset/sessionResetExecute', requestStage: 'Request' }, { urlPattern: '*sessionReset/sessionResetExecuteModel', requestStage: 'Request' }, { urlPattern: '*sessionReset/sessionResetRecoveries', requestStage: 'Request' }, { urlPattern: '*sessionReset/sessionResetRecoveryStatus', requestStage: 'Request' }, { urlPattern: '*sessionReset/sessionResetResume', requestStage: 'Request' }] });
  const testOption = executionOption;
  const restoreOption = process.argv.indexOf('--restore-operation');
  if (recoveryMode) {
    const sessionId = recoveryFixture.sessionId;
    assert.equal(await evaluate(`!!document.querySelector('[data-row-key="session:${sessionId}"]')`), false);
    await until(`!!document.querySelector('[data-reset-recoveries-entry]')`, 'global recovery entry');
    await evaluate(`document.querySelector('[data-reset-recoveries-entry]').click()`);
    await until(`document.querySelector('[data-reset-recoveries-list]')?.textContent.includes(${JSON.stringify(sessionId)})`, 'missing session listed by transaction');
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(out, 'recovery-list-simulated.png'), Buffer.from(screenshot.data, 'base64'));
    await evaluate(`[...document.querySelectorAll('[data-reset-recoveries-list] button')].find(button => button.textContent === '核对并恢复…').click()`);
    await until(`document.querySelector('[data-inplace-reset-session]')?.dataset.inplaceResetSession === ${JSON.stringify(sessionId)} && !!document.querySelector('[data-reset-recovery]')`, 'recovery-only confirmation dialog');
    assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
    assert.equal(await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '恢复原日志').disabled`), true);
    assert.equal(await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent === '备份并重置')`), false);
    assert.ok(!requests.some((request) => /sessionReset(?:Execute(?:Model)?|Resume|ModelPreview)$/.test(request.method)));
    await evaluate(`(() => { const input = document.getElementById('inplace-reset-confirm'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(sessionId.slice(8, 16))}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(`[...document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent === '恢复原日志' && !button.disabled)`, 'explicit recovery confirmation');
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '恢复原日志').click()`);
    await until(`document.querySelector('[data-inplace-reset-result]')?.dataset.inplaceResetResult === 'RECOVERED'`, 'verified simulated recovery restored after reload', 40000);
    assert.equal(requests.filter((request) => request.method.endsWith('/sessionResetResume')).length, 1);
    await writeFile(join(out, 'result.json'), JSON.stringify({ mode: 'simulated-recovery', sessionId, requests, checks: ['global entry independent of session row', 'missing session reaches confirmation', 'empty confirmation blocks recovery', 'no reset or model request', 'only explicit confirmed recovery sent', 'verified recovery receipt survives reload', 'all recovery writes simulated; real sessions unchanged'] }, null, 2));
    console.log(`PASS global recovery UI; writes simulated; evidence: ${out}`);
  } else if (evaluationSettingsMode) {
    await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '更多' || el.getAttribute('aria-label') === '更多'); if (!button) throw new Error('More menu missing'); button.click(); })()`);
    await until(`[...document.querySelectorAll('[role="menuitem"]')].some(el => el.textContent.includes('设置'))`, 'settings menu entry');
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('设置')).click()`);
    await until(`[...document.querySelectorAll('button, [role="tab"]')].some(el => el.textContent.trim() === '模型')`, 'Models settings tab');
    await evaluate(`[...document.querySelectorAll('button, [role="tab"]')].find(el => el.textContent.trim() === '模型').click()`);
    await until(`!!document.getElementById('evaluation-api-base') || !!document.querySelector('[data-evaluation-settings] [role="alert"]')`, 'evaluation model configuration');
    const failure = await evaluate(`document.querySelector('[data-evaluation-settings] [role="alert"]')?.textContent`);
    assert.equal(failure, undefined, failure);
    const readFields = await evaluate(`(async () => { const rpcId = crypto.randomUUID(); const response = await fetch('/api/sessionReset/sessionResetEvaluationSettings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'sessionReset/sessionResetEvaluationSettings', payload: { args: {} } }) }); const full = await response.json(); if (!full.result?.ok) throw new Error('Configuration read rejected'); return Object.keys(full.result.value).sort(); })()`);
    assert.deepEqual(readFields, ['apiBase', 'configured', 'hasSavedKey', 'usingDefault', 'writable'].sort());
    assert.equal(await evaluate(`document.getElementById('evaluation-api-key').type`), 'password');
    assert.equal(await evaluate(`document.getElementById('evaluation-api-key').value`), '');
    assert.equal(await evaluate(`document.getElementById('evaluation-api-base').disabled`), false, 'Credential provider must permit settings writes');
    const fill = async (id, value) => evaluate(`(() => { const input = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await fill('evaluation-api-base', 'https://eval.example.test');
    await fill('evaluation-api-key', 'synthetic-browser-key');
    await until(`!document.querySelector('[data-evaluation-settings] button[type="submit"]').disabled`, 'settings save enabled');
    await evaluate(`document.querySelector('[data-evaluation-settings] button[type="submit"]').click()`);
    await until(`!!document.querySelector('[data-evaluation-saved]')`, 'saved state');
    assert.equal(await evaluate(`document.getElementById('evaluation-api-key').value`), '');
    assert.equal(await evaluate(`document.querySelector('[data-evaluation-settings]').innerText.includes('synthetic-browser-key')`), false);
    await fill('evaluation-api-base', 'https://eval.example.test/custom-evaluation');
    await evaluate(`document.querySelector('[data-evaluation-settings] button[type="submit"]').click()`);
    await until(`!!document.querySelector('[data-evaluation-saved]') && document.getElementById('evaluation-api-base').value.endsWith('/custom-evaluation')`, 'blank-key preservation flow');
    assert.deepEqual(settingsWrites.map((item) => item.suppliedKey), [true, false]);
    await evaluate(`document.querySelector('[data-evaluation-settings]').scrollIntoView({ block: 'center' })`);
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(out, 'evaluation-model-settings.png'), Buffer.from(screenshot.data, 'base64'));
    await writeFile(join(out, 'result.json'), JSON.stringify({ checks: ['native Settings → Models navigation', 'live safe configuration read', 'key never returned or prefilled', 'masked key input', 'save and preserve-key UI flow', 'all credential writes simulated; real store unchanged'], requests, settingsWrites }, null, 2));
    console.log(`PASS evaluation model settings view; credential writes simulated; evidence: ${out}`);
  } else if (process.argv.includes('--model-api-probe')) {
    const value = await evaluate(`(async () => { const rpcId = crypto.randomUUID(); const response = await fetch('/api/sessionReset/sessionResetModelPreview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'sessionReset/sessionResetModelPreview', payload: { args: { sessionId: 'invalid' } } }) }); return { status: response.status, body: await response.text() }; })()`);
    await writeFile(join(out, 'probe.json'), JSON.stringify(value, null, 2));
    console.log(JSON.stringify(value));
  } else if (topicOption >= 0) {
    assert.match(permittedTopicId, /^session-[a-f0-9-]{36}$/);
    await ensureRowVisible(permittedTopicId);
    if (!process.argv.includes('--read-only-source')) assert.equal(await evaluate(`document.querySelector('[data-row-key="session:${permittedTopicId}"]')?.innerText.includes('[reset-test]')`), true, 'Live topic UI verification uses a labelled test source');
    await openPreview(permittedTopicId);
    await until(`!!document.querySelector('[data-inplace-reset-stats]')`, 'topic source baseline');
    const before = await evaluate(`document.querySelector('[data-inplace-reset-stats]').textContent`);
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '使用本会话模型分析主题').click()`);
    const required = process.argv.includes('--require-multiple-topics') ? 2 : 1;
    await until(`document.querySelectorAll('[data-inplace-reset-topic-option]').length >= ${required} || !!document.querySelector('[data-inplace-reset-topics] [role="alert"]')`, 'real session-model topics', 160000);
    assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-topics] [role="alert"]')?.textContent`), undefined);
    const badge = await evaluate(`document.querySelector('[data-inplace-reset-topic-model]').textContent`);
    const options = await captureTopicOptions(required, 'multiple-topic-options');
    const chosen = options[required > 1 ? 1 : 0].id;
    await evaluate(`document.querySelector('[data-inplace-reset-topic-option="${chosen}"] input').click()`);
    await until(`!!document.querySelector('[data-inplace-reset-topic="${chosen}"]') && document.getElementById('inplace-reset-continuation-goal').value.length > 0`, 'requested real topic adopted into goal');
    assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-topic-option="${chosen}"] input').checked`), true);
    await captureTopicOptions(required, 'second-topic-selected');
    let selectedIds = [chosen];
    let mergedGoal = await evaluate(`document.getElementById('inplace-reset-continuation-goal').value`);
    if (required > 1) {
      for (const option of options.filter((item) => item.id !== chosen)) {
        await evaluate(`document.querySelector('[data-inplace-reset-topic-option="${option.id}"] input').click()`);
        await until(`!!document.querySelector('[data-inplace-reset-topic="${option.id}"]') && [...document.querySelectorAll('[data-inplace-reset-topic-option] input:checked')].length === ${selectedIds.length + 1}`, 'additional topic remains selected with previous topics');
        selectedIds.push(option.id);
      }
      const selected = await captureTopicOptions(required, 'multiple-topics-selected');
      assert.equal(selected.filter((item) => item.checked).length, options.length);
      selectedIds = selected.filter((item) => item.checked).map((item) => item.id);
      mergedGoal = await evaluate(`document.getElementById('inplace-reset-continuation-goal').value`);
      assert.ok(mergedGoal.length <= 2000);
      const titles = options.map((option) => option.title.replace(/^\d+\.\s*/, ''));
      assert.ok(titles.every((title) => mergedGoal.includes(title)));
      assert.ok(titles.slice(1).every((title, index) => mergedGoal.indexOf(titles[index]) < mergedGoal.indexOf(title)), 'Merged goal follows display order rather than click order');
      await evaluate(`document.querySelector('[data-inplace-reset-topic-option="${chosen}"] input').click()`);
      await until(`!document.querySelector('[data-inplace-reset-topic="${chosen}"]') && [...document.querySelectorAll('[data-inplace-reset-topic-option] input:checked')].length === ${options.length - 1}`, 'deselecting one topic preserves the remaining selection');
      const afterRemoval = await evaluate(`document.getElementById('inplace-reset-continuation-goal').value`);
      assert.ok(!afterRemoval.includes(titles[required > 1 ? 1 : 0]));
      await captureTopicOptions(required, 'one-topic-deselected');
    }
    assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
    assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-stats]').textContent`), before);
    assert.equal(requests.some((request) => /\/sessionResetExecute(?:Model)?$/.test(request.method)), false);
    await writeFile(join(out, 'result.json'), JSON.stringify({ sessionId: permittedTopicId, badge, options, chosenTopic: chosen, selectedTopicIds: selectedIds, mergedGoal, requests, checks: ['all required real topic options simultaneously visible', 'multiple topics remain checked together', 'merged goals preserve all selected topics in display order', 'deselecting one preserves the remaining topics', 'adoption only fills editable goal', 'confirmation remains empty', 'source statistics unchanged', 'no reset requested'] }, null, 2), { flag: 'wx' });
    console.log(`PASS real session-model topic UI: ${options.length} visible options, selected together ${selectedIds.join(',')}; ${badge}; evidence: ${out}`);
  } else if (process.argv.includes('--model-preview')) {
    await evaluate(`document.querySelectorAll('button').forEach(button => { if (/^展开其余 \\d+ 个会话$|^Show \\d+ more sessions$/.test(button.textContent.trim())) button.click(); })`);
    await until(`[...document.querySelectorAll('[data-row-key^="session:"]')].some(row => row.innerText.includes('[reset-test]'))`, 'labelled test session after expanding the list', 5_000);
    const sessionId = await evaluate(`[...document.querySelectorAll('[data-row-key^="session:"]')].find(row => row.innerText.includes('[reset-test]'))?.dataset.rowKey.slice(8)`);
    assert.ok(sessionId, 'A labelled test session is required');
    await openPreview(sessionId);
    await until(`document.querySelector('[data-inplace-reset-stats]')?.textContent`, 'baseline before model preview');
    const before = await evaluate(`document.querySelector('[data-inplace-reset-stats]').innerText`);
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '模型筛选预览').click()`);
    await until(`!!(document.querySelector('[data-inplace-reset-model-status]') || document.querySelector('[data-inplace-reset-model] [role="alert"]'))`, 'live decision-model preview', 50_000);
    const failure = await evaluate(`document.querySelector('[data-inplace-reset-model] [role="alert"]')?.textContent`);
    assert.equal(failure, undefined, failure);
    const status = await evaluate(`document.querySelector('[data-inplace-reset-model-status]').dataset.inplaceResetModelStatus`);
    assert.notEqual(status, 'unavailable', 'Decision-model preview was unavailable');
    const reportId = await evaluate(`document.querySelector('[data-inplace-reset-model-status]').dataset.inplaceResetModelReport`);
    assert.match(reportId, /^[a-f0-9-]{36}$/);
    const report = JSON.parse(await readFile(join(homedir(), '.expert-teams/data/dsh-session-inplace-reset/runs', `model-${reportId}`, 'result.json'), 'utf8'));
    assert.equal(report.applied, false);
    assert.equal(report.sessionId, sessionId);
    assert.ok(report.coverage.assessed > 0);
    assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
    assert.equal(await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '备份并重置').disabled`), true);
    await evaluate(`document.querySelector('[data-inplace-reset-model] details').open = true`);
    const closeBounds = await evaluate(`(() => { const button = [...document.querySelectorAll('[role="dialog"] button')].find(el => el.textContent.trim() === '关闭'); const bounds = button.getBoundingClientRect(); return { top: bounds.top, bottom: bounds.bottom, viewport: innerHeight }; })()`);
    assert.ok(closeBounds.top >= 0 && closeBounds.bottom <= closeBounds.viewport, 'Close action must remain visible for a long model report');
    await mkdir(out, { recursive: true });
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(out, 'model-preview.png'), Buffer.from(screenshot.data, 'base64'));
    await closePreview();
    await openPreview(sessionId);
    await until(`document.querySelector('[data-inplace-reset-stats]')?.textContent`, 'source after model preview');
    assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-stats]').innerText`), before);
    assert.ok(requests.every((request) => !request.method.endsWith('/sessionResetExecute') && !request.method.endsWith('/sessionResetExecuteModel')));
    await writeFile(join(out, 'result.json'), JSON.stringify({ sessionId, reportId, status, requests, checks: ['real model through row menu', 'readable sources', 'baseline unchanged', 'confirmation remains empty', 'no reset requested'] }, null, 2));
    console.log(`PASS live model preview: ${status}; assessed ${report.coverage.assessed}/${report.coverage.total}; report ${reportId}; browser evidence: ${out}`);
  } else if (restoreOption !== -1) {
    const operationId = process.argv[restoreOption + 1];
    const home = join(homedir(), '.dsh');
    const records = new Ledger(home).rows;
    let value = records.find((row) => row.operationId === operationId && row.state === 'DONE')?.result;
    if (!value) { const journal = ResetJournal.load(home, operationId); if (journal.phase() === 'committed') value = journal.events().at(-1)?.detail; }
    assert.ok(value?.verified && value.sessionId, 'Verified operation missing from local ledger');
    await evaluate(`window.sessionStorage.setItem('@local/dsh-session-inplace-reset/completed', ${JSON.stringify(JSON.stringify({ sessionId: value.sessionId, displayTitle: '[reset-test] restored completion', completed: value }))})`);
    await send('Page.reload');
    await until(`document.querySelector('[data-inplace-reset-result]')?.getAttribute('data-inplace-reset-result') === 'DONE'`, 'completion recovered');
    await until(`!!document.querySelector('[contenteditable="true"]')`, 'restored page composer usable');
    assert.equal(await evaluate(`document.body.innerText.includes('Failed to load plugins')`), false);
    await mkdir(out, { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(out, 'restored-generation.png'), Buffer.from(shot.data, 'base64'));
    await writeFile(join(out, 'result.json'), JSON.stringify({ operationId, sessionId: value.sessionId, checks: ['verified result recovered', 'host navigation left unchanged', 'composer usable', 'no server mutation'] }, null, 2));
    console.log(`PASS read-only completion restoration; composer usable; evidence: ${out}`);
  } else if (testOption !== -1) {
    const sessionId = process.argv[testOption + 1];
    assert.match(sessionId, /^session-[0-9a-f-]{36}$/);
    await ensureRowVisible(sessionId);
    const label = await evaluate(`(() => { const row = [...document.querySelectorAll('[data-row-key]')].find(el => el.dataset.rowKey === ${JSON.stringify(`session:${sessionId}`)}); if (!row) throw new Error('Test session row missing'); const title = row.querySelector('[class*="title"]')?.textContent ?? ''; if (title.startsWith('[reset-test]')) row.click(); return title; })()`);
    assert.ok(label.startsWith('[reset-test]'), 'Refusing to reset an unlabelled conversation');
    await openPreview(sessionId);
    await until(`document.querySelector('[data-inplace-reset-stats]')?.textContent`, 'test-session preview');
    const useModel = process.argv.includes('--use-model');
    let chosenReportId;
    if (useModel) {
      await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '模型筛选预览').click()`);
      await until(`!!document.querySelector('[data-inplace-reset-model-status]') || !!document.querySelector('[data-inplace-reset-model] [role="alert"]')`, 'real candidate evaluated', 60000);
      const state = await evaluate(`({ status: document.querySelector('[data-inplace-reset-model-status]')?.dataset.inplaceResetModelStatus, error: document.querySelector('[data-inplace-reset-model] [role="alert"]')?.textContent })`);
      assert.equal(state.status, 'pass', state.error ?? `Candidate was ${state.status}; no reset requested`);
      chosenReportId = await evaluate(`document.querySelector('[data-inplace-reset-model-status]').dataset.inplaceResetModelReport`);
      await evaluate(`document.querySelector('[data-inplace-reset-use-model]').click()`);
      await until(`document.querySelector('[data-inplace-reset-selected-model]')?.dataset.inplaceResetSelectedModel === ${JSON.stringify(chosenReportId)}`, 'explicit model selection');
      assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
    }
    const presetOption = process.argv.indexOf('--agent-preset');
    const requestedPreset = presetOption < 0 ? undefined : process.argv[presetOption + 1];
    if (requestedPreset) {
      await until(`!!document.querySelector('#inplace-reset-agent-preset option[value="${requestedPreset}"]:not([disabled])')`, 'requested preset available');
      await evaluate(`(() => { const select = document.getElementById('inplace-reset-agent-preset'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(requestedPreset)}); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await until(`document.querySelector('[data-inplace-reset-preset-choice]')?.dataset.inplaceResetPresetChoice === ${JSON.stringify(requestedPreset)}`, 'new preset selected');
      assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
    }
    const actionLabel = useModel ? '应用候选并重置' : '备份并重置';
    await evaluate(`(() => { const input = document.getElementById('inplace-reset-confirm'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(sessionId.slice(8, 16))}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(`[...document.querySelectorAll('[role="dialog"] button')].some(el => el.textContent === ${JSON.stringify(actionLabel)} && !el.disabled)`, 'confirmation enables test action');
    const documentEpoch = await evaluate('performance.timeOrigin');
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(el => el.textContent === ${JSON.stringify(actionLabel)}).click()`);
    await until(`performance.timeOrigin > ${documentEpoch}`, 'browser page renewed without restarting DSH', 35_000);
    await until(`['DONE', 'NOT_RESET'].includes(document.querySelector('[data-inplace-reset-result]')?.getAttribute('data-inplace-reset-result'))`, 'reset operation settled', 70_000);
    const settled = await evaluate(`({ phase: document.querySelector('[data-inplace-reset-result]')?.getAttribute('data-inplace-reset-result'), text: document.querySelector('[data-inplace-reset-result]')?.innerText })`);
    assert.equal(settled.phase, 'DONE', settled.text);
    const memoryObservation = await evaluate(`document.querySelector('[data-inplace-reset-memory]')?.innerText`);
    assert.match(memoryObservation ?? '', /同进程内存观测：堆/);
    if (requestedPreset) {
      assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-after-preset]')?.dataset.inplaceResetAfterPreset`), requestedPreset);
      assert.equal(requests.find((request) => /\/sessionResetExecute(?:Model)?$/.test(request.method))?.agentPreset, requestedPreset);
    }
    if (useModel) {
      assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-applied-model]')?.dataset.inplaceResetAppliedModel`), chosenReportId);
      assert.equal(requests.filter((request) => request.method.endsWith('/sessionResetExecuteModel') && request.modelReportId === chosenReportId).length, 1);
    }
    await until(`[...document.querySelectorAll('[aria-selected="true"][data-row-key^="session:"]')].some(row => row.dataset.rowKey === ${JSON.stringify(`session:${sessionId}`)})`, 'host restores selected test conversation');
    const result = await evaluate(`document.querySelector('[data-inplace-reset-after]').innerText`);
    assert.match(result, /→ 1；/);
    await until(`document.body.innerText.includes('原地重置生成的历史交接记录')`, 'active conversation reloaded from the new log');
    await until(`!!document.querySelector('[contenteditable="true"]')`, 'composer usable after generation change');
    assert.equal(await evaluate(`!!document.querySelector('[data-composer-stat="activity"]')`), false, 'Old whole-log turn/step pill must disappear when the new log has no model steps');
    assert.equal(await evaluate(`!!document.querySelector('[data-composer-stat="usage"]')`), false, 'Old token usage must not survive reset');
    await mkdir(out, { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(out, 'verified-live-reset.png'), Buffer.from(shot.data, 'base64'));
    await writeFile(join(out, 'result.json'), JSON.stringify({ sessionId, result, memoryObservation, chosenReportId, requestedPreset, requests, checks: ['verified DONE restored after browser reload', 'memory observation retained after reload', 'old history window replaced', 'composer usable', 'old turn/step and token counters cleared', 'no DSH restart requested'] }, null, 2));
    console.log(`PASS actual menu reset ${sessionId}: ${result}; active history refreshed; evidence: ${out}`);
  } else {
  const rows = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-row-key^="session:"]')].filter(row => row.querySelector('[class*="rowActions"] button')).slice(0, 2).map(row => ({ id: row.dataset.rowKey.slice(8), title: row.querySelector('[class*="title"]')?.textContent ?? '' })))`);
  const [first, second] = JSON.parse(rows);
  assert.ok(first && second, 'Two nonblank session rows required');
  await evaluate(`(() => { const row = [...document.querySelectorAll('[data-row-key]')].find(el => el.dataset.rowKey === ${JSON.stringify(`session:${first.id}`)}); row.click(); })()`);
  await until(`document.querySelector('[aria-selected="true"][data-row-key]')?.getAttribute('data-row-key') === ${JSON.stringify(`session:${first.id}`)}`, 'first session selected');

  const evidence = { origin: base, checks: [], targets: [], requests };
  for (const row of [second, first]) {
    await openPreview(row.id);
    await until(`document.querySelector('[data-inplace-reset-stats]')?.textContent`, 'preview statistics', 40_000);
    const text = await evaluate(`document.querySelector('[data-inplace-reset-stats]').innerText`);
    assert.match(text, /事件数：\S/);
    assert.match(text, /消息数：\S/);
    assert.match(text, /交接包大小：\d/);
    assert.equal(requests.at(-1)?.sessionId, row.id);
    assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
    await until(`!!document.querySelector('#inplace-reset-agent-preset option[value="minimal"]')`, 'live preset roster');
    assert.equal(await evaluate(`document.getElementById('inplace-reset-agent-preset').value`), '');
    if (row.id === second.id) {
      await evaluate(`(() => { const input = document.getElementById('inplace-reset-confirm'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '12345678'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await evaluate(`(() => { const select = document.getElementById('inplace-reset-agent-preset'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'minimal'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await until(`document.querySelector('[data-inplace-reset-preset-choice]')?.dataset.inplaceResetPresetChoice === 'minimal'`, 'preset choice shown');
      assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
    }
    assert.equal(await evaluate(`document.querySelector('[aria-selected="true"][data-row-key]')?.getAttribute('data-row-key')`), `session:${first.id}`);
    evidence.targets.push({ sessionId: row.id, title: row.title, preview: text });
    console.log(`PASS menu → preview ${row.id}: ${text.replace(/\n/g, ' | ')}`);
    if (row.id === second.id) {
      await mkdir(out, { recursive: true });
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(out, 'session-menu-preview.png'), Buffer.from(screenshot.data, 'base64'));
    }
    await closePreview();
  }
  evidence.checks.push('two distinct row IDs passed through to read-only RPC', 'inactive row menu does not switch active conversation', 'dialog persists after menu closes', 'fresh confirmation for each row', 'preset roster defaults to preserving the source preset', 'changing preset clears prior confirmation');

  simulatedTopics = true;
  await openPreview(second.id);
  await until(`document.querySelector('[data-inplace-reset-stats]')?.textContent`, 'baseline before topic suggestions');
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '使用本会话模型分析主题').click()`);
  await until(`document.querySelectorAll('[data-inplace-reset-topic-option]').length === 2`, 'session-model topic candidates');
  await captureTopicOptions(2, 'simulated-multiple-topic-options');
  const topicBadge = await evaluate(`document.querySelector('[data-inplace-reset-topic-model]').textContent`);
  assert.match(topicBadge, /session-fixture-provider \/ current-session-model · high/);
  await evaluate(`(() => { const input = document.getElementById('inplace-reset-confirm'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(second.id.slice(8, 16))}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('[data-inplace-reset-topic-option="topic-1"] input').click()`);
  await until(`document.getElementById('inplace-reset-continuation-goal').value === '继续实现上下文重置与候选主题分析'`, 'topic selection fills editable continuation goal');
  assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
  assert.equal(await evaluate(`!!document.querySelector('[data-inplace-reset-selected-model]')`), false);
  assert.equal(requests.some((request) => /\/sessionResetExecute(?:Model)?$/.test(request.method)), false);
  await evaluate(`document.querySelector('[data-inplace-reset-topic="topic-1"] details').open = true; document.querySelector('[data-inplace-reset-topics]').scrollIntoView({ block: 'start' })`);
  const topicShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(out, 'session-model-topics.png'), Buffer.from(topicShot.data, 'base64'));
  await captureTopicOptions(2, 'single-topic-selected');
  const topicGoalA = '继续实现上下文重置与候选主题分析';
  const topicGoalB = '继续库存差异核对并保留业务边界';
  await evaluate(`document.querySelector('[data-inplace-reset-topic-option="topic-2"] input').click()`);
  await until(`document.querySelectorAll('[data-inplace-reset-topic-option] input:checked').length === 2 && document.querySelector('[data-inplace-reset-selected-topic-count]').dataset.inplaceResetSelectedTopicCount === '2'`, 'two topics selected together');
  const combinedGoal = await evaluate(`document.getElementById('inplace-reset-continuation-goal').value`);
  assert.ok(combinedGoal.includes(topicGoalA) && combinedGoal.includes(topicGoalB));
  assert.ok(combinedGoal.indexOf(topicGoalA) < combinedGoal.indexOf(topicGoalB));
  await captureTopicOptions(2, 'both-topics-selected');
  simulatedModel = { reportId: crypto.randomUUID(), sourceHash: 'a'.repeat(64), status: 'pending', mode: 'shadow', applied: false, auditComplete: true, coverage: { total: 128, assessed: 128, complete: true }, selected: [{ id: 'c0', seq: 0, role: 'user', sourceKind: 'user', text: '组合目标验证，保持原ID', retention: 'pass', superseded: 'fail' }], checks: ['constraints', 'state', 'faithful'].map((key) => ({ key, probability: 0.5, outcome: 'pending' })) };
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '模型筛选预览').click()`);
  await until(`document.querySelector('[data-inplace-reset-model-status]')?.dataset.inplaceResetModelStatus === 'pending'`, 'combined goal reaches the evaluation preview');
  assert.equal(requests.findLast((request) => request.method.endsWith('/sessionResetModelPreviewStartWithGoal')).continuationGoal, combinedGoal);
  assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-goal]').textContent`), combinedGoal);
  await evaluate(`(() => { const input = document.getElementById('inplace-reset-confirm'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(second.id.slice(8, 16))}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('[data-inplace-reset-topic-option="topic-2"] input').click()`);
  await until(`document.getElementById('inplace-reset-continuation-goal').value === ${JSON.stringify(topicGoalA)} && document.querySelectorAll('[data-inplace-reset-topic-option] input:checked').length === 1`, 'removing one topic restores the remaining goal');
  assert.equal(await evaluate(`!!document.querySelector('[data-inplace-reset-model-status]')`), false);
  assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
  await evaluate(`document.querySelector('[data-inplace-reset-topic-option="topic-1"] input').click()`);
  await until(`document.querySelectorAll('[data-inplace-reset-topic-option] input:checked').length === 0 && document.getElementById('inplace-reset-continuation-goal').value === ''`, 'clearing all topics restores the default continuation range');
  await evaluate(`document.querySelector('[data-inplace-reset-topic-option="topic-2"] input').click()`);
  await until(`document.querySelector('[data-inplace-reset-selected-topic-count]').dataset.inplaceResetSelectedTopicCount === '1' && document.getElementById('inplace-reset-continuation-goal').value === ${JSON.stringify(topicGoalB)}`, 'second topic selected first');
  await evaluate(`document.querySelector('[data-inplace-reset-topic-option="topic-1"] input').click()`);
  await until(`document.querySelector('[data-inplace-reset-selected-topic-count]').dataset.inplaceResetSelectedTopicCount === '2' && document.getElementById('inplace-reset-continuation-goal').value === ${JSON.stringify(combinedGoal)}`, 'first topic added without replacing second');
  assert.equal(await evaluate(`document.getElementById('inplace-reset-continuation-goal').value`), combinedGoal);
  const editedGoal = `${combinedGoal}\n保持只读验证。`;
  await evaluate(`(() => { const input = document.getElementById('inplace-reset-continuation-goal'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(editedGoal)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`document.querySelectorAll('[data-inplace-reset-topic-option] input:checked').length === 0`, 'manual editing clears the topic selection basis');
  staleTopic = true;
  await evaluate(`document.querySelector('[data-inplace-reset-topic-option="topic-2"] input').click()`);
  await until(`document.querySelector('[data-inplace-reset-topics] [role="alert"]')?.textContent.includes('模型已变化')`, 'stale topic refused before adoption');
  assert.equal(await evaluate(`document.getElementById('inplace-reset-continuation-goal').value`), editedGoal);
  await closePreview(); simulatedTopics = false; staleTopic = false;
  simulatedTopics = true; simulatedTopicUnavailable = true;
  await openPreview(second.id);
  await until(`!!document.querySelector('[data-inplace-reset-stats]')`, 'baseline for topic failure');
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '使用本会话模型分析主题').click()`);
  await until(`document.querySelector('[data-inplace-reset-topics] [role="alert"]')?.textContent.includes('暂无可选主题')`, 'failed analysis explicitly explains zero choices');
  assert.equal(await evaluate(`document.querySelectorAll('[data-inplace-reset-topic-option]').length`), 0);
  assert.equal(await evaluate(`document.getElementById('inplace-reset-continuation-goal').value`), '');
  await closePreview(); simulatedTopics = false; simulatedTopicUnavailable = false;
  evidence.checks.push('model failure explicitly reports no available topics without phantom choices');
  evidence.checks.push('all generated topic choices simultaneously visible as checkbox options', 'multiple topics combine into the exact evaluation goal', 'deselection clears stale reports and confirmation', 'clearing all topics restores default range', 'manual editing clears checkboxes without losing the edited goal', 'display order is stable regardless of click order', 'session model and reasoning effort shown for topic analysis', 'candidates show source quotes before choosing a goal', 'adopting a topic only fills the goal and clears confirmation', 'stale source or model refuses an old topic');

  for (const status of ['pass', 'pending', 'fail', 'unavailable']) {
    await openPreview(second.id);
    await until(`document.querySelector('[data-inplace-reset-stats]')?.textContent`, 'baseline before simulated model report');
    simulatedModel = { reportId: crypto.randomUUID(), sourceHash: 'a'.repeat(64), status, mode: 'shadow', applied: false, auditComplete: status === 'pass', batchCount: 5, requestCount: 10, coverage: { total: 128, assessed: status === 'pending' ? 64 : 128, complete: status !== 'pending' }, selected: status === 'unavailable' ? [] : [{ id: 'c0', seq: 0, role: 'user', sourceKind: 'user', text: '原文约束：禁止重启实例', retention: 'pass', superseded: 'fail' }], checks: status === 'unavailable' ? [] : ['constraints', 'state', 'faithful'].map((key) => ({ key, probability: status === 'pass' ? 0.95 : status === 'fail' ? 0.1 : 0.5, outcome: status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'pending' })) };
    if (status === 'pass') {
      await evaluate(`(() => { const input = document.getElementById('inplace-reset-continuation-goal'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '继续开发上下文重置插件'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    }
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '模型筛选预览').click()`);
    if (status === 'pass') {
      await until(`document.querySelector('[data-inplace-reset-progress]')?.dataset.inplaceResetProgress === 'audit'`, 'parallel progress reaches audit phase');
      const progress = await evaluate(`(() => { const region = document.querySelector('[data-inplace-reset-progress]'); const bar = region.querySelector('progress'); return { text: region.innerText, value: bar.value, max: bar.max, live: region.getAttribute('aria-live'), parallel: region.querySelector('[data-inplace-reset-parallel]').dataset.inplaceResetParallel }; })()`);
      assert.match(progress.text, /并行核对/);
      assert.match(progress.text, /并行 3 \/ 4/);
      assert.match(progress.text, /8 \/ 192/);
      assert.equal(progress.value, 2); assert.equal(progress.max, 5); assert.equal(progress.live, 'polite');
      assert.equal(await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '备份并重置').disabled`), true);
      await evaluate(`document.querySelector('[data-inplace-reset-progress]').scrollIntoView({ block: 'center' })`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(out, 'parallel-progress.png'), Buffer.from(screenshot.data, 'base64'));
      simulatedTask.hold = false;
    }
    await until(`document.querySelector('[data-inplace-reset-model-status]')?.getAttribute('data-inplace-reset-model-status') === ${JSON.stringify(status)}`, `model status ${status}`);
    assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
    assert.equal(requests.at(-1).sessionId, second.id);
    assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-use-model]').disabled`), status !== 'pass');
    if (status === 'pass') {
      assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-goal]').textContent`), '继续开发上下文重置插件');
      assert.equal(await evaluate(`document.querySelector('[data-inplace-reset-continuation]').textContent.includes('任务 1 · 约束 1')`), true);
      await evaluate(`document.querySelector('[data-inplace-reset-continuation] details').open = true`);
      const contextShot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(out, 'continuation-context.png'), Buffer.from(contextShot.data, 'base64'));
      await evaluate(`document.querySelector('[data-inplace-reset-use-model]').click()`);
      await until(`!!document.querySelector('[data-inplace-reset-selected-model]')`, 'candidate explicitly selected');
      assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
      assert.equal(await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '应用候选并重置').disabled`), true);
      await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '改用近期采样').click()`);
      assert.equal(await evaluate(`!!document.querySelector('[data-inplace-reset-selected-model]')`), false);
      await evaluate(`document.querySelector('[data-inplace-reset-use-model]').click()`);
      await evaluate(`(() => { const input = document.getElementById('inplace-reset-confirm'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(second.id.slice(8, 16))}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await evaluate(`(() => { const input = document.getElementById('inplace-reset-continuation-goal'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '改为接续库存核对'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await until(`!document.querySelector('[data-inplace-reset-model-status]') && !document.querySelector('[data-inplace-reset-selected-model]')`, 'goal edit clears the old report and selected candidate');
      assert.equal(await evaluate(`document.getElementById('inplace-reset-confirm').value`), '');
    }
    await closePreview();
  }
  evidence.checks.push('model pass, pending, fail and unavailable are distinct', 'model preview never fills reset confirmation', 'only a passing candidate can be explicitly selected', 'selection does not confirm or execute a reset', 'live phase progress and request counters update before completion', 'actual parallel count and accessible progress bar are visible', 'explicit continuation goal and cited task ledger are displayed', 'editing the goal clears the report, selection and confirmation');

  for (const wrongSession of [false, true]) {
    await openPreview(second.id);
    await until(`document.querySelector('[data-inplace-reset-stats]')?.textContent`, 'baseline for progress lifecycle');
    simulatedModel = { reportId: crypto.randomUUID(), sourceHash: 'a'.repeat(64), status: 'pass', mode: 'shadow', applied: false, auditComplete: true, coverage: { total: 128, assessed: 128, complete: true }, selected: [], checks: [] };
    wrongProgressSession = wrongSession;
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '模型筛选预览').click()`);
    if (wrongSession) {
      await until(`document.querySelector('[data-inplace-reset-model] [role="alert"]')?.textContent.includes('不属于所选任务')`, 'wrong-session progress is refused');
      assert.equal(await evaluate(`!!document.querySelector('[data-inplace-reset-model-status]')`), false);
    } else {
      await until(`!!document.querySelector('[data-inplace-reset-progress]')`, 'running progress before closing');
    }
    const taskId = simulatedTask.taskId;
    await closePreview();
    const count = requests.filter((request) => request.taskId === taskId).length;
    await delay(1200);
    assert.equal(requests.filter((request) => request.taskId === taskId).length, count, 'a closed dialog must stop polling');
    wrongProgressSession = false;
  }
  evidence.checks.push('closing the dialog stops progress polling', 'progress from another session is rejected without displaying a candidate');

  for (const value of [
    { ok: true, phase: 'HALTED_LIVE', reason: '宿主仍持有会话，未执行重置' },
    { ok: true, phase: 'DONE', sameId: true, verified: false },
  ]) {
    await openPreview(second.id);
    await until(`document.querySelector('[data-inplace-reset-stats]')?.textContent`, 'preview for simulated outcome');
    simulatedExecute = value;
    await evaluate(`(() => { const input = document.getElementById('inplace-reset-confirm'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(second.id.slice(8, 16))}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(`[...document.querySelectorAll('[role="dialog"] button')].some(el => el.textContent === '备份并重置' && !el.disabled)`, 'simulated action ready');
    await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(el => el.textContent === '备份并重置').click()`);
    await until(`document.querySelector('[data-inplace-reset-result]')?.getAttribute('data-inplace-reset-result') === 'NOT_RESET'`, 'halted or unverified result labelled not reset');
    assert.equal(await evaluate(`!!document.querySelector('[data-inplace-reset-after]')`), false);
    await closePreview();
  }
  evidence.checks.push('HALTED_LIVE displays not reset', 'unverified DONE is never presented as success');
  rejectPreview = true;
  await openPreview(second.id);
  await until(`document.querySelector('[role="alert"]')?.textContent.includes('预览失败验证')`, 'preview error visible');
  assert.equal(await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(el => el.textContent === '备份并重置')?.disabled`), true);
  evidence.checks.push('preview failure disables destructive action');
  await closePreview();
  assert.equal(await evaluate(`document.querySelector('button[title="同ID原地重置当前会话(v0.1)"]') !== null`), false);
  assert.equal(await evaluate(`!!document.getElementById('inplace-reset-fab')`), false);
  evidence.checks.push('old composer and floating controls absent', 'all execute calls simulated; no server reset or restart requested');
  await writeFile(join(out, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS ${evidence.checks.length} browser checks; evidence: ${out}`);
  }
} catch (error) {
  await mkdir(out, { recursive: true });
  try {
    const snapshot = await evaluate(`JSON.stringify({ dialog: document.querySelector('[role="dialog"]')?.innerText, body: document.body.innerText.slice(0, 2000), plugin: window.__DSH_BOOT__?.entries?.filter(entry => entry.id.includes('inplace-reset')), menus: [...document.querySelectorAll('[role="menu"], [role="menuitem"]')].map(el => ({ role: el.getAttribute('role'), text: el.innerText })) })`);
    await writeFile(join(out, 'failure.json'), JSON.stringify({ ...JSON.parse(snapshot), diagnostics }));
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(out, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
  } catch { /* Keep the original test failure when the page is unavailable. */ }
  console.error(`Browser evidence: ${out}`);
  throw error;
} finally {
  socket.close();
  for (const promise of pending.values()) promise.reject(new Error('CDP session closed'));
  await fetch(`${cdp}/json/close/${target.id}`);
  let closed = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const tabs = await (await fetch(`${cdp}/json/list`)).json();
    if (!tabs.some((tab) => tab.id === target.id)) { closed = true; break; }
    await delay(100);
  }
  await writeFile(join(out, 'closure.json'), JSON.stringify({ id: target.id, closed }), { flag: 'wx' });
  assert.equal(closed, true, 'Owned target did not disappear');
}
