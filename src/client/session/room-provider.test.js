import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { E2EProvider } from './e2e-provider.js';
import { createRoomProvider, isEncryptedRoom } from './room-provider.js';

const BASE = 'ws://localhost:1234/rooms';
const HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const OTHER_HANDLE = 'Zyxwvutsrqponmlkjihgfedcba543210';
const PARAMS = Object.freeze({ awarenessId: '42' });

const make = (t, roomKey) => {
  const ydoc = new Y.Doc();
  const provider = createRoomProvider({ wsBaseUrl: BASE, roomHandle: HANDLE, ydoc, params: PARAMS, roomKey });
  t.after(() => { provider.destroy(); ydoc.destroy(); });
  return provider;
};

test('a room without its own unlocked key keeps the y-websocket provider and its query', (t) => {
  for (const roomKey of [null, { roomHandle: OTHER_HANDLE, keyEpoch: 0 }]) {
    const provider = make(t, roomKey);
    assert.ok(provider instanceof WebsocketProvider);
    assert.equal(provider.url, `${BASE}/${HANDLE}?awarenessId=42`);
    assert.equal(provider.shouldConnect, false);
  }
  assert.equal(isEncryptedRoom(null, HANDLE), false);
});

test('the unlocked key of this room selects the encrypted provider on the /e2e path, not yet connected', (t) => {
  const provider = make(t, { roomHandle: HANDLE, keyEpoch: 0 });
  assert.ok(provider instanceof E2EProvider);
  assert.equal(provider.url, `${BASE}/${HANDLE}/e2e`);
  assert.equal(provider.ws, null);
  assert.equal(provider.pendingDelivery, 0);
});
