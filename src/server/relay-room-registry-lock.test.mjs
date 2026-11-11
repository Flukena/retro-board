import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedStorage, durableMetaBatch } from './relay-storage.js';
import { LOCKED_REGISTRATION_MARKER, RoomRegistry, isCommittedRegistration } from './relay-room-registry.js';
import { CORRUPT_LOCK, ROOM_LOCK_META, decodeLockRecord } from './room-lock.js';
import { lockRecord } from './room-lock-fixtures.mjs';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const MARKER_META = 'retro-room-registration-v1';
const SIGNING_KEY_BYTES = 32;
const MAX_ROOMS = 10;
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const QUIET = { warn() {}, error() {} };
const NO_USAGE = { complete: true, roomsByHandle: new Map() };

async function openFixture(dir, wrap = (persistence) => persistence) {
  const ldb = new LeveldbPersistence(dir);
  opened.add(ldb);
  const storage = checkedStorage(ldb, Y);
  const events = [];
  const persistence = wrap({
    ...storage,
    durableMetaBatch: async (docName, ops) => { events.push('lock'); await durableMetaBatch(ldb, docName, ops); },
    hasCapacity: () => true,
    reserveStore: () => () => {},
    measureDatabase: () => 0,
  }, events);
  const registry = new RoomRegistry({
    persistence, Y, maxRooms: MAX_ROOMS, maxDatabaseBytes: UNLIMITED,
    signingKey: Buffer.alloc(SIGNING_KEY_BYTES), log: QUIET,
  });
  await registry.hydrate(NO_USAGE);
  return { ldb, registry, events, storage };
}

// Every DB opened through openFixture is destroyed in finally, even when the body throws.
const opened = new Set();
const withDir = async (body) => {
  const dir = await mkdtemp(join(tmpdir(), 'room-lock-'));
  try { await body(dir); } finally {
    for (const ldb of opened) await ldb.destroy();
    opened.clear();
    await rm(dir, { recursive: true, force: true });
  }
};

test('a locked room keeps its lock across a reopen and normal rooms have no lock key', async () => {
  await withDir(async (dir) => {
    const first = await openFixture(dir);
    const locked = await first.registry.createRoom({ lock: lockRecord() });
    const normal = await first.registry.createRoom();
    const lockedDoc = first.registry.registeredDocForCapability(locked.code, locked.token);
    const normalDoc = first.registry.registeredDocForCapability(normal.code, normal.token);
    assert.equal(first.registry.isLocked(lockedDoc), true);
    assert.equal(first.registry.isLocked(normalDoc), false);
    assert.equal(first.registry.lockFor(normalDoc), null);
    assert.equal(await first.storage.getMeta(normalDoc, ROOM_LOCK_META), undefined);
    await first.ldb.destroy();
    opened.delete(first.ldb);

    const second = await openFixture(dir);
    assert.deepEqual(second.registry.lockFor(lockedDoc), decodeLockRecord(lockRecord()));
    assert.equal(second.registry.isLocked(normalDoc), false);
    await second.registry.retireRoom(lockedDoc);
    assert.equal(second.registry.lockFor(lockedDoc), null);
    await second.ldb.destroy();
  });
});

test('the lock is durable before the registration marker is written', async () => {
  await withDir(async (dir) => {
    let lockSeenAtMarker = null;
    const fixture = await openFixture(dir, (persistence) => ({
      ...persistence,
      async setMeta(docName, key, value) {
        if (key === MARKER_META) lockSeenAtMarker = await persistence.getMeta(docName, ROOM_LOCK_META);
        return persistence.setMeta(docName, key, value);
      },
    }));
    await fixture.registry.createRoom({ lock: lockRecord() });
    assert.deepEqual(decodeLockRecord(lockSeenAtMarker), decodeLockRecord(lockRecord()));
    await fixture.ldb.destroy();
  });
});

test('a failing lock write never writes the marker, and a failing marker write leaves no room and no lock key', async () => {
  await withDir(async (dir) => {
    const boom = new Error('injected');
    const written = [];
    const fixture = await openFixture(dir, (persistence) => ({
      ...persistence,
      async setMeta(docName, key, value) {
        written.push(key);
        if (key === MARKER_META && fixture.failMarker) throw boom;
        return persistence.setMeta(docName, key, value);
      },
      async durableMetaBatch(docName, ops) {
        if (fixture.failLock) throw boom;
        return persistence.durableMetaBatch(docName, ops);
      },
    }));
    fixture.failLock = true;
    await assert.rejects(fixture.registry.createRoom({ lock: lockRecord() }), (error) => error === boom);
    assert.equal(written.includes(MARKER_META), false);

    fixture.failLock = false;
    fixture.failMarker = true;
    await assert.rejects(fixture.registry.createRoom({ lock: lockRecord() }), (error) => error === boom);
    assert.equal(fixture.registry.registeredDocs.size, 0);
    assert.equal(fixture.registry.locksByDoc.size, 0);
    assert.deepEqual(await fixture.storage.getAllDocNames(), []);
    await fixture.ldb.destroy();
  });
});

test('createRoom rejects an invalid lock before reserving anything; publishLock updates memory only', async () => {
  await withDir(async (dir) => {
    const fixture = await openFixture(dir);
    await assert.rejects(fixture.registry.createRoom({ lock: { ...lockRecord(), v: 2 } }), TypeError);
    assert.equal(fixture.registry.pendingRoomCreations, 0);
    const room = await fixture.registry.createRoom({ lock: lockRecord() });
    const docName = fixture.registry.registeredDocForCapability(room.code, room.token);
    const rotated = lockRecord({ keyEpoch: 1, lockRevision: 1 });
    fixture.registry.publishLock(docName, rotated);
    assert.equal(fixture.registry.lockFor(docName).keyEpoch, 1);
    assert.equal(decodeLockRecord(await fixture.storage.getMeta(docName, ROOM_LOCK_META)).keyEpoch, 0);
    assert.throws(() => fixture.registry.publishLock(docName, { ...rotated, extra: 1 }), TypeError);
    await fixture.ldb.destroy();
  });
});

const LOCK_DOC = 'yjs/board-Crashed1-abcdefgh12345678';

const UNLOCKED_MARKER = 1;

// The relay released before encrypted rooms (e2d1ab7, relay-room-registry.js hydrateRoom) serves a document only
// when its marker is exactly 1 and ignores lock records; any other marker is quarantined (404).
const previousReleaseServes = (marker) => marker === UNLOCKED_MARKER;

test('a locked room is committed with a marker the previous release refuses; a normal room keeps marker 1', async () => {
  await withDir(async (dir) => {
    const fixture = await openFixture(dir);
    const locked = await fixture.registry.createRoom({ lock: lockRecord() });
    const normal = await fixture.registry.createRoom();
    const lockedMarker = await fixture.storage.getMeta(fixture.registry.registeredDocForCapability(locked.code, locked.token), MARKER_META);
    const normalMarker = await fixture.storage.getMeta(fixture.registry.registeredDocForCapability(normal.code, normal.token), MARKER_META);
    assert.equal(lockedMarker, LOCKED_REGISTRATION_MARKER);
    assert.equal(previousReleaseServes(lockedMarker), false, 'a rollback answers 404 for the locked room');
    assert.equal(normalMarker, UNLOCKED_MARKER);
    assert.equal(previousReleaseServes(normalMarker), true);
    assert.equal(isCommittedRegistration(lockedMarker) && isCommittedRegistration(normalMarker), true);
    assert.equal(isCommittedRegistration(0) || isCommittedRegistration(undefined) || isCommittedRegistration(3), false);
  });
});

test('a locked-room marker without a lock record is served as corrupt, never unlocked, and nothing is dropped', async () => {
  await withDir(async (dir) => {
    const first = await openFixture(dir);
    const room = await first.registry.createRoom({ lock: lockRecord() });
    const docName = first.registry.registeredDocForCapability(room.code, room.token);
    await durableMetaBatch(first.ldb, docName, [{ type: 'del', key: ROOM_LOCK_META }]);
    await first.ldb.destroy();
    opened.delete(first.ldb);

    const second = await openFixture(dir);
    assert.equal(second.registry.registeredDocs.has(docName), true);
    assert.equal(second.registry.isLocked(docName), true);
    assert.equal(second.registry.lockFor(docName), CORRUPT_LOCK);
    assert.equal(await second.storage.getMeta(docName, MARKER_META), LOCKED_REGISTRATION_MARKER);
  });
});

test('a locked room with marker 2 keeps its lock across hydration: the orphan sweep never treats it as interrupted', async () => {
  await withDir(async (dir) => {
    const first = await openFixture(dir);
    const room = await first.registry.createRoom({ lock: lockRecord() });
    const docName = first.registry.registeredDocForCapability(room.code, room.token);
    await first.ldb.destroy();
    opened.delete(first.ldb);
    const second = await openFixture(dir);
    assert.deepEqual(decodeLockRecord(await second.storage.getMeta(docName, ROOM_LOCK_META)), decodeLockRecord(lockRecord()));
    assert.deepEqual(second.registry.lockFor(docName), decodeLockRecord(lockRecord()));
  });
});

test('an unknown marker is quarantined like a missing one, and its lock key is dropped', async () => {
  await withDir(async (dir) => {
    const first = await openFixture(dir);
    await first.storage.storeUpdate(LOCK_DOC, first.registry.seedUpdate());
    await durableMetaBatch(first.ldb, LOCK_DOC, [{ type: 'put', key: ROOM_LOCK_META, value: lockRecord() }]);
    await first.storage.setMeta(LOCK_DOC, MARKER_META, 0);
    await first.ldb.destroy();
    opened.delete(first.ldb);
    const second = await openFixture(dir);
    assert.equal(second.registry.registeredDocs.has(LOCK_DOC), false);
    assert.equal(await second.storage.getMeta(LOCK_DOC, ROOM_LOCK_META), undefined);
  });
});



test('hydration deletes the lock key of an interrupted creation and leaves the room unreachable', async () => {
  await withDir(async (dir) => {
    const first = await openFixture(dir);
    await first.registry.createRoom();
    // Simulate a crash after the lock write but before the marker: seed doc + lock only.
    await first.storage.storeUpdate(LOCK_DOC, first.registry.seedUpdate());
    await durableMetaBatch(first.ldb, LOCK_DOC, [{ type: 'put', key: ROOM_LOCK_META, value: lockRecord() }]);
    assert.ok(await first.storage.getMeta(LOCK_DOC, ROOM_LOCK_META));
    await first.ldb.destroy();
    opened.delete(first.ldb);

    const second = await openFixture(dir);
    assert.equal(second.registry.registeredDocs.has(LOCK_DOC), false);
    assert.equal(second.registry.isLocked(LOCK_DOC), false);
    assert.equal(await second.storage.getMeta(LOCK_DOC, ROOM_LOCK_META), undefined);
    assert.equal(second.registry.registeredDocs.size, 1);
  });
});

test('a corrupt committed lock keeps the room managed, locked and retirable with its data intact', async () => {
  await withDir(async (dir) => {
    const first = await openFixture(dir);
    const room = await first.registry.createRoom({ lock: lockRecord() });
    const docName = first.registry.registeredDocForCapability(room.code, room.token);
    await durableMetaBatch(first.ldb, docName, [{ type: 'put', key: ROOM_LOCK_META, value: { v: 9 } }]);
    await first.ldb.destroy();
    opened.delete(first.ldb);

    const second = await openFixture(dir);
    assert.equal(second.registry.registeredDocs.has(docName), true);
    assert.equal(second.registry.isLocked(docName), true);
    assert.equal(second.registry.lockFor(docName), CORRUPT_LOCK);
    assert.deepEqual(second.registry.lockFor(docName), { corrupt: true });
    assert.ok(second.registry.roomUploadUsage.has(docName));
    assert.deepEqual(await second.storage.getMeta(docName, ROOM_LOCK_META), { v: 9 });
    assert.ok(await second.storage.getMeta(docName, 'retro-room-handle-v1'));
    assert.ok(await second.registry.retireRoom(docName));
    assert.equal(second.registry.lockFor(docName), null);
  });
});
