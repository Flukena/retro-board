import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { RoomFence } from './room-fence.js';
import { STORAGE_FAILURE_CODE, storageOperationError } from './relay-storage.js';
import {
  MAX_CONCURRENT_TITLE_READS, RELAY_TITLE_ORIGIN, TITLE_WRITE_STATUS, createRoomTitleReader, createRoomTitleWriter,
} from './room-title-writer.js';

const DOC = 'yjs/board-Title123-abcdefgh12345678';
const TITLE = 'Sprint 42 retro';
const NO_REFUSAL = () => null;
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * The relay's side of a room as the writer sees it: y-websocket's docs map, getYDoc (which binds hydration like
 * bindState), the hydration promises, and the store write each doc update queued (as queueStoreUpdate does).
 */
function relayRooms({ stored = new Map(), storeResult = () => Promise.resolve(true), storesUpdates = true } = {}) {
  const docs = new Map();
  const roomReady = new WeakMap();
  const storeWrites = new WeakMap();
  const hydrations = new Map();
  const origins = [];
  const getYDoc = (docName) => {
    if (docs.has(docName)) return docs.get(docName);
    const doc = new Y.Doc();
    doc.conns = new Map();
    doc.on('update', (update, origin) => {
      origins.push(origin);
      if (!storesUpdates) return;
      const write = storeResult(update).then((ok) => {
        if (ok) stored.set(docName, Y.mergeUpdates([stored.get(docName) ?? Y.encodeStateAsUpdate(new Y.Doc()), update]));
        return ok;
      });
      storeWrites.set(doc, write);
    });
    let hydrate;
    roomReady.set(doc, new Promise((resolve) => { hydrate = resolve; }));
    hydrations.set(docName, hydrate);
    docs.set(docName, doc);
    return doc;
  };
  return { docs, roomReady, storeWrites, getYDoc, hydrations, origins, stored };
}

function writerFor(rooms, { fence = new RoomFence(), refusal = NO_REFUSAL, admitsColdRoom = () => true } = {}) {
  const writer = createRoomTitleWriter({
    docs: rooms.docs, getYDoc: rooms.getYDoc, roomReady: rooms.roomReady, fence, refusal, admitsColdRoom,
    storeWriteOf: (doc) => rooms.storeWrites.get(doc),
  });
  return { writer, fence };
}

// Starts a write and lets the room hydrate on the next turn, as a cold LevelDB read would.
async function writeHydrating(rooms, writer, title = TITLE) {
  const result = writer.write(DOC, title);
  await settle();
  rooms.hydrations.get(DOC)?.();
  return result;
}

const titleOf = (doc) => doc.getMap('meta').get('title');

test('a resident room with a peer gets the title on its live doc, stored, and stays loaded', async () => {
  const rooms = relayRooms();
  const doc = rooms.getYDoc(DOC);
  doc.conns.set({}, new Set());
  rooms.hydrations.get(DOC)();
  const { writer } = writerFor(rooms);
  assert.equal(await writer.write(DOC, TITLE), TITLE_WRITE_STATUS.OK);
  assert.equal(titleOf(doc), TITLE);
  assert.deepEqual(rooms.origins, [RELAY_TITLE_ORIGIN]);
  await settle();
  assert.equal(rooms.docs.get(DOC), doc);
  const reloaded = new Y.Doc();
  Y.applyUpdate(reloaded, rooms.stored.get(DOC));
  assert.equal(titleOf(reloaded), TITLE);
});

test('a cold room is loaded through getYDoc, written after hydration, then unloaded', async () => {
  const rooms = relayRooms();
  const { writer, fence } = writerFor(rooms);
  const result = writer.write(DOC, TITLE);
  const doc = rooms.docs.get(DOC);
  await settle();
  assert.equal(titleOf(doc), undefined, 'nothing is written before hydration ends');
  rooms.hydrations.get(DOC)();
  assert.equal(await result, TITLE_WRITE_STATUS.OK);
  await settle();
  assert.equal(rooms.docs.has(DOC), false);
  assert.equal(rooms.roomReady.has(doc), false);
  assert.equal(fence.held(DOC), false);
});

test('a first connection holding a fence entry keeps the cold doc loaded, and its peer is attached to it', async () => {
  const rooms = relayRooms();
  const { writer, fence } = writerFor(rooms);
  const result = writer.write(DOC, TITLE);
  const doc = rooms.docs.get(DOC);
  const upgradeLeave = fence.enter(DOC);
  assert.equal(rooms.getYDoc(DOC), doc, 'the upgrade gets the same live doc');
  await settle();
  rooms.hydrations.get(DOC)();
  assert.equal(await result, TITLE_WRITE_STATUS.OK);
  await settle();
  assert.equal(rooms.docs.get(DOC), doc, 'still loaded while the upgrade holds its entry');
  doc.conns.set({}, new Set());
  upgradeLeave();
  await settle();
  assert.equal(rooms.docs.get(DOC), doc);
  assert.equal(titleOf(doc), TITLE);
});

test('a first connection that fails after the rename leaves no idle doc behind', async () => {
  const rooms = relayRooms();
  const { writer, fence } = writerFor(rooms);
  const result = writer.write(DOC, TITLE);
  const upgradeLeave = fence.enter(DOC);
  await settle();
  rooms.hydrations.get(DOC)();
  assert.equal(await result, TITLE_WRITE_STATUS.OK);
  await settle();
  assert.equal(rooms.docs.has(DOC), true);
  upgradeLeave();
  await settle();
  assert.equal(rooms.docs.has(DOC), false);
});

test('a store failure answers 503', async () => {
  const rooms = relayRooms({ storeResult: () => Promise.resolve(false) });
  const { writer } = writerFor(rooms);
  assert.equal(await writeHydrating(rooms, writer), TITLE_WRITE_STATUS.UNAVAILABLE);
  assert.equal(rooms.stored.has(DOC), false);
});

test('an update the relay refused to store (blocked room, backlog) answers 503', async () => {
  const rooms = relayRooms({ storesUpdates: false });
  const { writer } = writerFor(rooms);
  assert.equal(await writeHydrating(rooms, writer), TITLE_WRITE_STATUS.UNAVAILABLE);
});

test('a room the relay refuses to serve gets no title and answers 503', async () => {
  const rooms = relayRooms();
  const { writer } = writerFor(rooms, { refusal: () => new Error('room unavailable') });
  assert.equal(await writeHydrating(rooms, writer), TITLE_WRITE_STATUS.UNAVAILABLE);
  assert.deepEqual(rooms.origins, []);
});

test('a fenced room is never loaded and answers 404', async () => {
  const rooms = relayRooms();
  const { writer, fence } = writerFor(rooms);
  fence.fence(DOC);
  assert.equal(await writer.write(DOC, TITLE), TITLE_WRITE_STATUS.NOT_FOUND);
  assert.equal(rooms.docs.has(DOC), false);
});

test('a room deleted while it hydrated gets no title and answers 404', async () => {
  const rooms = relayRooms();
  const { writer, fence } = writerFor(rooms);
  const result = writer.write(DOC, TITLE);
  const doc = rooms.docs.get(DOC);
  fence.fence(DOC);
  rooms.docs.delete(DOC);
  doc.destroy();
  rooms.hydrations.get(DOC)();
  assert.equal(await result, TITLE_WRITE_STATUS.NOT_FOUND);
  assert.deepEqual(rooms.origins, []);
});

const storedDoc = (title) => {
  const doc = new Y.Doc();
  if (title !== undefined) doc.getMap('meta').set('title', title);
  return doc;
};

test('the reader reads a resident room live and a cold room from storage without loading it', async () => {
  const rooms = relayRooms();
  const resident = rooms.getYDoc(DOC);
  resident.getMap('meta').set('title', 'Live title');
  rooms.hydrations.get(DOC)();
  const cold = 'yjs/board-Cold1234-abcdefgh12345678';
  const destroyed = [];
  const read = createRoomTitleReader({
    docs: rooms.docs, roomReady: rooms.roomReady,
    readStoredDoc: async (docName) => {
      assert.equal(docName, cold);
      const doc = storedDoc('Stored title');
      doc.on('destroy', () => destroyed.push(docName));
      return doc;
    },
  });
  assert.equal(await read(DOC), 'Live title');
  assert.equal(await read(cold), 'Stored title');
  assert.deepEqual(destroyed, [cold]);
  assert.equal(rooms.docs.has(cold), false);
});

test('the reader answers null for a missing or invalid title', async () => {
  const titles = new Map([['none', undefined], ['blank', '  '], ['number', 42]]);
  const read = createRoomTitleReader({
    docs: new Map(), roomReady: new WeakMap(), readStoredDoc: async (docName) => storedDoc(titles.get(docName)),
  });
  for (const docName of titles.keys()) assert.equal(await read(docName), null, docName);
});

test('a storage failure while reading a title is never turned into a missing title', async () => {
  const read = createRoomTitleReader({
    docs: new Map(), roomReady: new WeakMap(), readStoredDoc: async () => { throw storageOperationError('getYDoc failed'); },
  });
  await assert.rejects(read('cold'), { code: STORAGE_FAILURE_CODE });
});

test('the reader keeps at most MAX_CONCURRENT_TITLE_READS storage reads in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const read = createRoomTitleReader({
    docs: new Map(), roomReady: new WeakMap(),
    readStoredDoc: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await settle();
      inFlight -= 1;
      return storedDoc('t');
    },
  });
  const reads = Array.from({ length: MAX_CONCURRENT_TITLE_READS * 3 }, (_, index) => read(`room-${index}`));
  assert.deepEqual(new Set(await Promise.all(reads)), new Set(['t']));
  assert.equal(peak, MAX_CONCURRENT_TITLE_READS);
});

test('a cold room is not loaded when the relay is at its active-room capacity', async () => {
  const rooms = relayRooms();
  const { writer, fence } = writerFor(rooms, { admitsColdRoom: () => false });
  assert.equal(await writer.write(DOC, TITLE), TITLE_WRITE_STATUS.UNAVAILABLE);
  assert.equal(rooms.docs.has(DOC), false);
  assert.equal(fence.held(DOC), false);
});

test('a resident room is renamed even at capacity: it already holds its slot', async () => {
  const rooms = relayRooms();
  const doc = rooms.getYDoc(DOC);
  doc.conns.set({}, new Set());
  rooms.hydrations.get(DOC)();
  const { writer } = writerFor(rooms, { admitsColdRoom: () => false });
  assert.equal(await writer.write(DOC, TITLE), TITLE_WRITE_STATUS.OK);
});

test('an idle renamed doc is unloaded when the last other holder releases, however long it held on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const rooms = relayRooms();
  const { writer, fence } = writerFor(rooms);
  const upload = fence.enter(DOC);
  const result = writer.write(DOC, TITLE);
  await Promise.resolve();
  rooms.hydrations.get(DOC)();
  assert.equal(await result, TITLE_WRITE_STATUS.OK);
  const LONG_HOLD_MS = 10 * 60_000;
  t.mock.timers.tick(LONG_HOLD_MS);
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.equal(rooms.docs.has(DOC), true, 'still held by the other holder');
  upload();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.equal(rooms.docs.has(DOC), false);
});
