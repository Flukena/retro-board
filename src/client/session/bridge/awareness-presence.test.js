import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorage } from '../../../test-support/bridge-harness.js';

const REMOTE_CLIENT_A = 101;
const REMOTE_CLIENT_B = 102;
const STALE_AFTER_MS = 30_000;
const OVERLONG_ITEM_ID = 'x'.repeat(129);
const SHARED_USER = { userId: 'peer', name: 'Peer', lastSeen: 1 };

test('presence expires at 30s while busy, editing and selection keep distinct per-connection readers', async () => {
  await withStorage((browser) => {
    const { storage } = browser;
    const awareness = browser.__rbProvider.awareness;
    const now = Date.now();
    for (const clientId of [REMOTE_CLIENT_A, REMOTE_CLIENT_B]) {
      awareness.states.set(clientId, { user: SHARED_USER, busyItems: ['card', OVERLONG_ITEM_ID],
        editingItemId: OVERLONG_ITEM_ID, selectedItems: ['card', OVERLONG_ITEM_ID] });
      awareness.meta.set(clientId, { clock: 1, lastUpdated: now });
    }
    assert.equal(storage.getRemoteBusyItems().get('card').size, 2);
    assert.equal(storage.getRemoteSelectedItems().get('card').size, 2);
    assert.equal(storage.getRemoteBusyItems().has(OVERLONG_ITEM_ID), false);
    assert.equal(storage.getRemoteSelectedItems().has(OVERLONG_ITEM_ID), false);
    assert.equal(storage.getRemoteEditingItems().get(OVERLONG_ITEM_ID).size, 2);
    assert.equal(storage.getPresenceSnapshot().peer.name, 'Peer');
    for (const clientId of [REMOTE_CLIENT_A, REMOTE_CLIENT_B]) {
      awareness.meta.get(clientId).lastUpdated = now - STALE_AFTER_MS;
    }
    assert.equal(storage.getPresenceSnapshot().peer, undefined);
    assert.equal(storage.getRemoteBusyItems().get('card').size, 2);
  });
});

test('text and geometry busy claims merge, text stays singular, and document destruction clears the slot', async () => {
  await withStorage((browser) => {
    const { storage } = browser;
    const awareness = browser.__rbProvider.awareness;
    storage.setLocalBusyItems('geometry', ['b', 'a', 'a']);
    storage.setLocalBusyItems('text', ['c', 'd']);
    assert.deepEqual(awareness.getLocalState().busyItems, ['a', 'b', 'c']);
    assert.equal(awareness.getLocalState().editingItemId, 'c');
    storage.setLocalBusyItems('geometry', []);
    assert.deepEqual(awareness.getLocalState().busyItems, ['c']);
    storage.setLocalBusyItems('text', []);
    assert.equal(awareness.getLocalState().busyItems, null);
    storage.setLocalBusyItems('geometry', ['a']);
    browser.__rbYDoc.destroy();
    assert.equal(awareness.getLocalState(), null);
  });
});

test('the extracted controller reads fake Awareness slots without combining their owners', async () => {
  const { createAwarenessPresence } = await import('./awareness-presence.js');
  let localState = {};
  const states = new Map([
    [REMOTE_CLIENT_A, { user: SHARED_USER, busyItems: ['card'], selectedItems: ['card'] }],
    [REMOTE_CLIENT_B, { user: SHARED_USER, busyItems: ['card'], editingItemId: 'card' }],
  ]);
  const awareness = {
    clientID: 1,
    meta: new Map(),
    getStates() { return states; },
    getLocalState() { return localState; },
    setLocalState(state) { localState = state; },
    setLocalStateField(key, value) { localState = { ...localState, [key]: value }; },
    on() { /* This fixture exercises synchronous reads and local writes. */ },
  };
  const { methods } = createAwarenessPresence({ provider: { awareness }, emitter: new EventTarget(), motionPublisher: null });
  assert.deepEqual([...methods.getRemoteBusyItems().get('card').keys()], [REMOTE_CLIENT_A, REMOTE_CLIENT_B]);
  assert.deepEqual([...methods.getRemoteEditingItems().get('card').keys()], [REMOTE_CLIENT_B]);
  assert.deepEqual([...methods.getRemoteSelectedItems().get('card').keys()], [REMOTE_CLIENT_A]);
  methods.setLocalBusyItems('text', ['c', 'd']);
  methods.setLocalBusyItems('geometry', ['b', 'a']);
  assert.deepEqual(localState.busyItems, ['a', 'b', 'c']);
});
