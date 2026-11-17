import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import { createPlainUpgrades } from './plain-upgrade.js';
import { createPlainRoomTeardown } from './plain-room-teardown.js';
import { RoomFence } from './room-fence.js';
import { ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON } from '../domain/room-ownership.js';

const DOC = 'yjs/board-Stalled1-abcdefgh12345678';
const TIMEOUT_MS = 60_000;
const QUIET = { error() {} };

function fixture() {
  const docs = new Map();
  const roomReady = new WeakMap();
  let hydrate;
  const getYDoc = (docName) => {
    if (!docs.has(docName)) {
      const doc = Object.assign(new Y.Doc(), { conns: new Map() });
      docs.set(docName, doc);
      roomReady.set(doc, new Promise((resolve) => { hydrate = resolve; }));
    }
    return docs.get(docName);
  };
  const wss = Object.assign(new EventEmitter(), { attached: 0, handleUpgrade() { wss.attached += 1; } });
  const fence = new RoomFence();
  const rejected = [];
  const upgrades = createPlainUpgrades({
    docs, getYDoc, roomReady, wss, fence, refusal: () => null, reject: (_socket, status) => rejected.push(status),
    timeoutMs: TIMEOUT_MS, log: QUIET,
  });
  const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { socket.destroyed = true; } });
  return { docs, roomReady, wss, fence, rejected, upgrades, socket, hydrate: () => hydrate() };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

test('an upgrade stalled in hydration while its room is deleted is refused 404, attaches nothing and leaves no doc', async () => {
  const f = fixture();
  const leave = f.fence.enter(DOC);
  let left = 0;
  f.upgrades.attach({}, f.socket, Buffer.alloc(0), DOC, () => { left += 1; leave(); });
  f.fence.fence(DOC);
  const teardown = createPlainRoomTeardown({ docs: f.docs, roomReady: f.roomReady, roomPersistenceChurn: new Map(), blockedRooms: new Map() });
  const retiring = teardown.retire(DOC, ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON);
  assert.equal(await f.fence.drained(DOC, 0), false, 'the stalled upgrade holds its entry');
  f.hydrate();
  await retiring;
  await settle();
  assert.deepEqual(f.rejected, [404]);
  assert.equal(f.wss.attached, 0);
  assert.equal(left, 1);
  assert.equal(f.docs.has(DOC), false);
  assert.equal(await f.fence.drained(DOC, 0), true);
});

test('an unfenced upgrade attaches after hydration and releases its entry', async () => {
  const f = fixture();
  let left = 0;
  f.upgrades.attach({}, f.socket, Buffer.alloc(0), DOC, () => { left += 1; });
  f.hydrate();
  await settle();
  assert.equal(f.wss.attached, 1);
  assert.deepEqual(f.rejected, []);
  assert.equal(left, 1);
});
