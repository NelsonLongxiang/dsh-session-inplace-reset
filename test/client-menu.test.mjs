import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function clientRuntime(saved = null) {
  let contribution;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const MenuItemButton = Symbol('MenuItemButton');
  let stored = saved === null ? null : JSON.stringify(saved);
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (value) => { contribution = value; } }, sessionStorage: { getItem: () => stored, removeItem: () => { stored = null; } } } });
  assert.equal(contribution.id, manifest.name);
  const plugin = contribution.factory((name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton };
    throw new Error(`Unexpected import: ${name}`);
  });
  assert.equal(typeof plugin.apply, 'function', 'factory must return a Cordis plugin without mounting DOM');
  const entries = new Map();
  const cleanups = [];
  const navigations = [];
  plugin.apply({
    uiWorkspace: { openSession: (id) => navigations.push(id) },
    slots: {
      inject: (_name, mount) => mount(),
      register: (options, component) => {
        entries.set(options.name, { options, component });
        return () => entries.delete(options.name);
      },
    },
    effect: (mount) => { cleanups.push(mount()); },
  });
  return { entries, navigations, MenuItemButton, stored: () => stored, dispose: () => cleanups.reverse().forEach((cleanup) => cleanup?.()) };
}

test('menu targets its row even when another session is open, and dialog survives menu dismissal', () => {
  const runtime = clientRuntime();
  const menu = runtime.entries.get('sidebar.workspaces.session.menu.item');
  const overlay = runtime.entries.get('shell.overlay');
  assert.ok(menu && overlay);
  assert.ok(runtime.entries.has('settings.models.footer'), 'evaluation configuration belongs inside the Models settings view');
  assert.equal(runtime.entries.has('conversation.input.right'), false);
  assert.equal(overlay.component(), null);
  const selectedSession = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const otherRow = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  let menuOpen = true;
  const item = menu.component({
    sessionId: otherRow,
    displayTitle: '另一行的会话',
    useMenuOpenState: () => [menuOpen, (open) => { menuOpen = open; }],
  });
  assert.equal(item.type, runtime.MenuItemButton);
  item.props.onSelect();
  assert.equal(menuOpen, false);
  const dialog = overlay.component();
  assert.equal(dialog.props.sessionId, otherRow);
  assert.notEqual(dialog.props.sessionId, selectedSession);
  assert.equal(dialog.props.displayTitle, '另一行的会话');
  dialog.props.onClose();
  assert.equal(overlay.component(), null);
  runtime.dispose();
  assert.equal(runtime.entries.size, 0);
});

test('switching menu rows creates a fresh dialog and carries no previous confirmation or preview', () => {
  const runtime = clientRuntime();
  const menu = runtime.entries.get('sidebar.workspaces.session.menu.item');
  const overlay = runtime.entries.get('shell.overlay');
  const choose = (sessionId) => menu.component({ sessionId, displayTitle: sessionId, useMenuOpenState: () => [true, () => {}] }).props.onSelect();
  choose('session-11111111-1111-1111-1111-111111111111');
  const first = overlay.component();
  choose('session-22222222-2222-2222-2222-222222222222');
  const second = overlay.component();
  assert.notEqual(first.props.key, second.props.key);
  assert.equal(second.props.key, second.props.sessionId);
  runtime.dispose();
});

test('browser reload restores the verified result without overriding host navigation', () => {
  const id = 'session-33333333-3333-3333-3333-333333333333';
  const completed = { phase: 'DONE', verified: true, sessionId: id, before: { totalTurns: 24 }, after: { totalTurns: 1 } };
  const runtime = clientRuntime({ sessionId: id, displayTitle: 'reset result', completed });
  assert.deepEqual(runtime.navigations, []);
  const dialog = runtime.entries.get('shell.overlay').component();
  assert.equal(dialog.props.completed.after.totalTurns, 1);
  dialog.props.onClose();
  assert.equal(runtime.stored(), null);
  runtime.dispose();
});

test('a saved result for a different ID cannot reopen a completion dialog', () => {
  const id = 'session-55555555-5555-5555-5555-555555555555';
  const runtime = clientRuntime({ sessionId: id, completed: { phase: 'DONE', verified: true, sessionId: 'another-id', before: { totalTurns: 24 }, after: { totalTurns: 1 } } });
  assert.equal(runtime.entries.get('shell.overlay').component(), null);
  assert.deepEqual(runtime.navigations, []);
  runtime.dispose();
});

test('HALTED records cannot reopen a success dialog after page reload', () => {
  const runtime = clientRuntime({ sessionId: 'session-44444444-4444-4444-4444-444444444444', completed: { phase: 'HALTED_LIVE', verified: true } });
  assert.equal(runtime.entries.get('shell.overlay').component(), null);
  assert.deepEqual(runtime.navigations, []);
  runtime.dispose();
});
