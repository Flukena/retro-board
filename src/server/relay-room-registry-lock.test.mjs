import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedStorage, durableMetaBatch } from './relay-storage.js';
import { RoomRegistry } from './relay-room-registry.js';
import { ROOM_LOCK_META, decodeLockRecord } from './room-lock.js';
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

const withDir = async (body) => {
  const dir = await mkdtemp(join(tmpdir(), 'room-lock-'));
  try { await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
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
