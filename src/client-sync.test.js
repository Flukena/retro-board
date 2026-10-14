import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Observable } from 'lib0/observable';
import { establishRoomSession } from './room-session.js';
import { attachClientSync } from './client-sync.js';

class Transport extends Observable {
  wsconnected = false;
  synced = false;
}

function setup(context) {
  const doc = new Y.Doc();
  const provider = new Transport();
  const browser = new EventTarget();
  const state = attachClientSync(provider, doc, browser);
  context.after(() => doc.destroy());
  return { doc, provider, browser, state };
}

test('remote updates and per-device preferences do not mark offline board edits pending', (context) => {
  const { doc, state } = setup(context);
  const peer = new Y.Doc();
  context.after(() => peer.destroy());
  peer.getMap('meta').set('allRevealed', true);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  doc.transact(() => doc.getMap('kv').set('u|device|userName', 'Alice'), 'system');
  assert.equal(state.getSnapshot().hasUnsyncedLocalChanges, false);
  doc.transact(() => doc.getMap('kv').set('s||vote:item:user', true), 'local');
  assert.equal(state.getSnapshot().hasUnsyncedLocalChanges, true);
});

test('undo and silent shared edits count; socket sync clears guard and destroy detaches it', (context) => {
  const { doc, state, provider, browser } = setup(context);
  const meta = doc.getMap('meta');
  const undo = new Y.UndoManager(meta, { trackedOrigins: new Set(['local']) });
  context.after(() => undo.destroy());
  provider.wsconnected = true;
  provider.synced = true;
  provider.emit('sync', [true]);
  doc.transact(() => meta.set('allRevealed', true), 'local');
  provider.wsconnected = false;
  provider.synced = false;
  provider.emit('connection-close', [{}]);
  undo.undo();
  assert.equal(state.getSnapshot().hasUnsyncedLocalChanges, true);
  provider.wsconnected = true;
  provider.synced = true;
  provider.emit('sync', [true]);
  assert.equal(state.getSnapshot().hasUnsyncedLocalChanges, false);
  provider.wsconnected = false;
  provider.emit('connection-close', [{ code: 1008, reason: 'session expired' }]);
  doc.transact(() => meta.set('editingLocked', true), 'system');
  assert.equal(state.getSnapshot().status, 'session-lost');
  const before = new Event('beforeunload', { cancelable: true });
  browser.dispatchEvent(before);
  assert.equal(before.defaultPrevented, true);
  doc.destroy();
  const after = new Event('beforeunload', { cancelable: true });
  browser.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
});

const TEST_NOW_MS = 1_700_000_000_000;
const SESSION_TTL_MS = 60_000;
const REFRESH_DELAY_MS = 48_000;
const ROOM_HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';

test('scheduled refresh then old-socket expiry recovers after the replacement socket syncs', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: TEST_NOW_MS });
  const oldWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5181') };
  context.after(() => {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return new Response(JSON.stringify({ roomHandle: ROOM_HANDLE, expiresAt: Date.now() + SESSION_TTL_MS }),
      { headers: { 'content-type': 'application/json' } });
  });
  await establishRoomSession('TEST', 'Abcdefgh12345678');
  const { doc, provider, state } = setup(context);
  provider.wsconnected = true;
  provider.synced = true;
  provider.emit('sync', [true]);
  context.mock.timers.tick(REFRESH_DELAY_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 2, 'HTTP session renewed while old socket remains connected');
  provider.emit('connection-close', [{ code: 1008, reason: 'session expired' }]);
  provider.wsconnected = false;
  provider.synced = false;
  assert.equal(state.getSnapshot().status, 'session-lost');
  doc.transact(() => doc.getMap('meta').set('allRevealed', true), 'local');
  provider.emit('sync', [true]);
  assert.equal(state.getSnapshot().status, 'session-lost', 'non-socket sync cannot recover expiry');
  provider.wsconnected = true;
  provider.synced = true;
  provider.emit('status', [{ status: 'connected' }]);
  provider.emit('sync', [true]);
  assert.deepEqual(state.getSnapshot(), { status: 'connected', hasUnsyncedLocalChanges: false });
  doc.transact(() => doc.getMap('meta').set('editingLocked', true), 'local');
  assert.equal(state.getSnapshot().hasUnsyncedLocalChanges, false, 'online edits remain online after recovery');
});
