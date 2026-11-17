import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createPlainRoomTeardown } from './plain-room-teardown.js';
import { ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON } from '../domain/room-ownership.js';

const DOC = 'yjs/board-Plain1-abcdefgh12345678';
const LATER_MS = 60_000;

const fakeConn = () => {
  const conn = { closes: [], close(code, reason) { conn.closes.push([code, reason]); } };
  return conn;
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const docs = new Map();
  const roomReady = new WeakMap();
  const roomPersistenceChurn = new Map();
  const blockedRooms = new Map([[DOC, Date.now() + LATER_MS]]);
  const teardown = createPlainRoomTeardown({ docs, roomReady, roomPersistenceChurn, blockedRooms });
  return { docs, roomReady, roomPersistenceChurn, blockedRooms, teardown };
}

test('retire closes every socket 4004, drops and destroys the doc at once, and waits for hydration and compaction', async () => {
  const f = fixture();
  const doc = new Y.Doc();
  doc.conns = new Map([[fakeConn(), new Set()], [fakeConn(), new Set()]]);
  f.docs.set(DOC, doc);
  const hydration = deferred();
  const compaction = deferred();
  f.roomReady.set(doc, hydration.promise);
  const timer = setTimeout(() => assert.fail('the scheduled compaction must not run'), 1);
  const churn = { uncompactedBytes: 10, uncompactedUpdates: 2, remeasureRequested: true, compactionPromise: compaction.promise, compactionTimer: timer };
  f.roomPersistenceChurn.set(DOC, churn);
  const stored = [];
  doc.on('update', (update) => stored.push(update));

  let settled = false;
  const retiring = f.teardown.retire(DOC, ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON).then(() => { settled = true; });
  for (const conn of doc.conns.keys()) assert.deepEqual(conn.closes, [[ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON]]);
  assert.equal(f.docs.has(DOC), false);
  assert.equal(f.roomPersistenceChurn.has(DOC), false);
  assert.equal(f.blockedRooms.has(DOC), false);
  assert.deepEqual([churn.uncompactedBytes, churn.uncompactedUpdates, churn.remeasureRequested], [0, 0, false], 'no compaction is rescheduled');
  // A late frame from a peer that ignores the close reaches a destroyed doc: no update listener stores it.
  doc.getMap('items').set('late', 1);
  assert.deepEqual(stored, []);

  hydration.resolve();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(settled, false, 'an in-flight compaction is still writing');
  compaction.resolve();
  await retiring;
});

test('retire of a room with no resident doc still cancels its churn and settles', async () => {
  const f = fixture();
  f.roomPersistenceChurn.set(DOC, { uncompactedBytes: 1, uncompactedUpdates: 1, compactionPromise: null, compactionTimer: null });
  await f.teardown.retire(DOC, ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON);
  assert.equal(f.roomPersistenceChurn.has(DOC), false);
});
