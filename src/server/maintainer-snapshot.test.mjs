import test from 'node:test';
import assert from 'node:assert/strict';
import { maintainerSnapshot } from './maintainer-snapshot.js';

test('lists cold and resident rooms without hydration or disclosure of capabilities/content', () => {
  const cold = 'yjs/board-cold-SECRET_TOKEN';
  const warm = 'yjs/board-warm-OTHER_SECRET';
  const doc = { share: new Map([['items', new Map([['private content', {}]])], ['private content', new Map()]]) };
  const snapshot = maintainerSnapshot({
    registry: { registeredRoomsByHandle: new Map([['cold-handle', cold], ['warm-handle', warm]]), roomUploadUsage: new Map([[cold, { bytes: 25, files: 2 }]]) },
    docs: new Map([[warm, doc]]), connections: new Map([[warm, 3]]),
    blockedRooms: new Map([[warm, Date.now() + 10000]]), roomUsage: new WeakMap([[doc, { upperBytes: 120 }]]), ready: true,
  });
  assert.equal(snapshot.rooms.length, 2);
  assert.deepEqual(snapshot.rooms[0], { handle: 'cold-handle', connections: 0, resident: false, blockedUntil: null, documentBytesUpperBound: null, uploadBytes: 25, uploadFiles: 2, collections: null });
  assert.equal(snapshot.rooms[1].connections, 3);
  assert.deepEqual(snapshot.rooms[1].collections, { items: 1 });
  assert.equal(snapshot.rooms[1].documentBytesUpperBound, 120);
  assert.ok(snapshot.rooms[1].blockedUntil > Date.now());
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|private content|yjs\/board/);
});
