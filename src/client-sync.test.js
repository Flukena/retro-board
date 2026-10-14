import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Observable } from 'lib0/observable';
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
