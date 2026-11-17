import test from 'node:test';
import assert from 'node:assert/strict';
import { maintainerSnapshot } from './maintainer-snapshot.js';

test('lists cold and resident rooms without hydration or disclosure of capabilities/content', () => {
  const cold = 'yjs/board-cold-SECRET_TOKEN';
  const warm = 'yjs/board-warm-OTHER_SECRET';
  const doc = { share: new Map([['items', new Map([['private content', {}]])], ['private content', new Map()]]) };
  const snapshot = maintainerSnapshot({
    registry: { registeredRoomsByHandle: new Map([['cold-handle', cold], ['warm-handle', warm]]), roomUploadUsage: new Map([[cold, { bytes: 25, files: 2 }]]), isLocked: () => false, ownershipOf: (docName) => ({ retention: docName === cold ? 'guest' : 'kept', ownerAccountId: 'ADA_ACCOUNT_ID_SECRET' }) },
    docs: new Map([[warm, doc]]), connections: new Map([[warm, 3]]),
    blockedRooms: new Map([[warm, Date.now() + 10000]]), roomUsage: new WeakMap([[doc, { upperBytes: 120 }]]), ready: true,
  });
  assert.equal(snapshot.rooms.length, 2);
  assert.deepEqual(snapshot.rooms[0], { createdAt: null, lastSessionAt: null, trackedSinceAt: null, lastActiveAt: null, handle: 'cold-handle', connections: 0, resident: false, blockedUntil: null, documentBytesUpperBound: null, uploadBytes: 25, uploadFiles: 2, collections: null, encrypted: false, retention: 'guest' });
  assert.equal(snapshot.rooms[1].retention, 'kept');
  assert.equal(snapshot.rooms[1].connections, 3);
  assert.deepEqual(snapshot.rooms[1].collections, { items: 1 });
  assert.equal(snapshot.rooms[1].documentBytesUpperBound, 120);
  assert.ok(snapshot.rooms[1].blockedUntil > Date.now());
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|private content|yjs\/board/, 'no capability, content or owner account id');
});

test('rows carry when tracking began for rooms older than activity tracking', () => {
  const legacy = 'yjs/board-legacy-SECRET_TOKEN';
  const activity = { get: () => ({ createdAt: null, lastSessionAt: null, lastActiveAt: null, trackedSinceAt: 1234 }) };
  const snapshot = maintainerSnapshot({
    registry: { registeredRoomsByHandle: new Map([['legacy-handle', legacy]]), roomUploadUsage: new Map(), activity, isLocked: () => false, ownershipOf: () => ({ retention: 'kept' }) },
    docs: new Map(), connections: new Map(), blockedRooms: new Map(), roomUsage: new WeakMap(), ready: true,
  });
  assert.equal(snapshot.rooms[0].trackedSinceAt, 1234);
  assert.equal(snapshot.rooms[0].createdAt, null);
});

test('encrypted rooms are listed with encrypted: true and expose no document state even if a document is resident', () => {
  const locked = 'yjs/board-locked-SECRET_TOKEN';
  const doc = { share: new Map([['items', new Map([['private content', {}]])]]) };
  const snapshot = maintainerSnapshot({
    registry: {
      registeredRoomsByHandle: new Map([['locked-handle', locked], ['plain-handle', 'yjs/board-plain-OTHER']]),
      roomUploadUsage: new Map([[locked, { bytes: 9, files: 1 }]]), isLocked: (docName) => docName === locked,
      ownershipOf: () => ({ retention: 'kept' }),
    },
    docs: new Map([[locked, doc]]), connections: new Map([[locked, 2]]), blockedRooms: new Map(), roomUsage: new WeakMap([[doc, { upperBytes: 77 }]]), ready: true,
  });
  const [lockedRow, plainRow] = snapshot.rooms;
  assert.equal(lockedRow.encrypted, true);
  assert.equal(plainRow.encrypted, false);
  assert.equal(lockedRow.collections, null);
  assert.equal(lockedRow.documentBytesUpperBound, null);
  assert.equal(lockedRow.resident, false);
  assert.equal(lockedRow.connections, 2);
  assert.equal(lockedRow.uploadBytes, 9);
});
