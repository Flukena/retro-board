import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ROOM_ACTIVITY_META } from './room-activity.js';
import { ROOM_HANDLE_RE, STORE_OPERATION_OVERHEAD_BYTES } from './relay-config.js';
import { RoomRegistry, REGISTRY_STORAGE_FAILURE_EVENT, databaseCapacityError } from './relay-room-registry.js';
import { lockRecord } from './room-lock-fixtures.mjs';
import { MAX_OWNED_ROOMS_PER_ACCOUNT, RETENTION_CLASS, ROOM_KIND, ROOM_OWNER_META, encodeOwnerRecord } from '../domain/room-ownership.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const REGISTRATION_KEY = 'retro-room-registration-v1';
const HANDLE_KEY = 'retro-room-handle-v1';
const USAGE_KEY = 'retro-room-upload-usage-v1';
const DOC_NAME = 'yjs/board-Example1-abcdefgh12345678';
const CAPACITY_COUNT = 2;
const REGISTRY_TEST_SIGNING_KEY_BYTES = 32;
const STALE_USAGE_BYTES = 90;
const STALE_USAGE_FILES = 4;
const POST_FLUSH_DISK_SCAN_COUNT = 2;
const POST_QUOTA_DATABASE_BYTES = STORE_OPERATION_OVERHEAD_BYTES * 4;
const UNLIMITED_BYTES = Number.MAX_SAFE_INTEGER;
const SEED_STEP_LABEL = 'seed';
const FLUSH_STEP_LABEL = 'flush';
const ROLLBACK_STEP_LABEL = 'clear';
const DISK_STEP_LABEL = 'disk';
const DURABLE_STEP_LABEL = 'durable';
const OWNER_ACCOUNT = 'ada-account-id-0001';
const OWNER_CREATED_AT = 1_800_000_000_000;
const ROOMS_BEYOND_THE_LIMIT = MAX_OWNED_ROOMS_PER_ACCOUNT + 2;
const OWNED_ROOM_LIMIT_CODE = 'OWNED_ROOM_LIMIT';
const ROOM_CAPACITY_CODE = 'ROOM_CAPACITY';
const STORAGE_FAILURE_CODE = 'STORAGE_FAILURE';
const SERVER_UNAVAILABLE_CODE = 'SERVER_UNAVAILABLE';
const ROOM_HANDLE_CHARACTERS = 32;
const HANDLE = 'H'.repeat(ROOM_HANDLE_CHARACTERS);
const QUIET_LOGGER = { warn() {}, error() {} };
const LATE_LOCK_RECORD = lockRecord();

async function registryFixture(options = {}) {
  const trace = [];
  const failures = [];
  const metadata = options.metadata || new Map();
  let diskScans = 0;
  const persistence = {
    async getAllDocNames() { if (options.namesError) throw options.namesError; return options.names || []; },
    async getMeta(name, key) {
      trace.push(`read:${key}`);
      if (options.failReadAt === key) throw options.error;
      return metadata.get(`${name}:${key}`);
    },
    async setMeta(name, key, value) {
      trace.push(key);
      if (options.failAt === key) throw options.error;
      metadata.set(`${name}:${key}`, value);
    },
    async storeUpdate(name, update) {
      trace.push(SEED_STEP_LABEL);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, update);
        assert.equal(doc.getMap('meta').get('__roomRegistered'), 1);
      } finally { doc.destroy(); }
      if (options.holdSeed) await options.holdSeed;
      if (options.failAt === SEED_STEP_LABEL) throw options.error;
    },
    async durableMetaBatch(name, ops) {
      trace.push(DURABLE_STEP_LABEL);
      if (options.failAt === DURABLE_STEP_LABEL) throw options.error;
      for (const { type, key, value } of ops) {
        if (type === 'put') metadata.set(`${name}:${key}`, value);
        else metadata.delete(`${name}:${key}`);
      }
    },
    async flushDocument() { trace.push(FLUSH_STEP_LABEL); if (options.failAt === FLUSH_STEP_LABEL) throw options.error; },
    async clearDocument(name) {
      trace.push(ROLLBACK_STEP_LABEL);
      if (options.cleanupError) throw options.cleanupError;
      for (const key of metadata.keys()) if (key.startsWith(`${name}:`)) metadata.delete(key);
    },
  };
  let releases = 0;
  let storeOps = 0;
  let storeBytes = 0;
  let diskBytes = 0;
  const maxBytes = options.maxBytes ?? UNLIMITED_BYTES;
  persistence.hasCapacity = () => diskBytes + storeBytes < maxBytes;
  persistence.reserveStore = (estimatedBytes) => {
    if (storeOps >= (options.maxStoreOps ?? CAPACITY_COUNT) || diskBytes + storeBytes + estimatedBytes > maxBytes) {
      throw databaseCapacityError();
    }
    storeOps += 1;
    storeBytes += estimatedBytes;
    return () => { releases += 1; storeOps -= 1; storeBytes -= estimatedBytes; };
  };
  persistence.measureDatabase = () => {
    trace.push(DISK_STEP_LABEL);
    diskScans += 1;
    if (diskScans === options.failDiskAt) throw options.error;
    diskBytes = diskScans > 1 ? options.diskBytes || 0 : 0;
    return diskBytes;
  };
  const instance = new RoomRegistry({ persistence, Y, maxRooms: options.maxRooms ?? CAPACITY_COUNT,
    maxDatabaseBytes: maxBytes, signingKey: Buffer.alloc(REGISTRY_TEST_SIGNING_KEY_BYTES), log: QUIET_LOGGER });
  instance.on(REGISTRY_STORAGE_FAILURE_EVENT, (error) => failures.push(error));
  await instance.hydrate(options.usage || { complete: true, roomsByHandle: new Map() }, options.deleting);
  const registry = {
    createRoom: (...args) => instance.createRoom(...args),
    registeredDocForCapability: (...args) => instance.registeredDocForCapability(...args),
    roomHandleForDoc: (...args) => instance.roomHandleForDoc(...args),
    registeredDocs: instance.registeredDocs,
    registeredRoomsByHandle: instance.registeredRoomsByHandle,
    roomUploadUsage: instance.roomUploadUsage,
    get pending() { return instance.pendingRoomCreations; },
    get handles() { return instance.pendingRoomHandles.size; },
    get storeOps() { return storeOps; }, get storeBytes() { return storeBytes; },
    get releases() { return releases; },
  };
  trace.length = 0;
  return { registry, trace, failures, metadata, instance };
}

function assertReservationsReleased(registry) {
  assert.equal(registry.pending, 0);
  assert.equal(registry.handles, 0);
  assert.equal(registry.storeOps, 0);
  assert.equal(registry.storeBytes, 0);
}

test('registry creation reserves synchronously and publishes only after the final marker', async () => {
  let releaseSeed;
  const holdSeed = new Promise((resolve) => { releaseSeed = resolve; });
  const { registry, trace } = await registryFixture({ holdSeed });
  const creating = registry.createRoom();
  assert.equal(registry.pending, 1);
  assert.equal(registry.handles, 1);
  assert.equal(registry.storeOps, 1);
  assert.ok(registry.storeBytes > STORE_OPERATION_OVERHEAD_BYTES);
  assert.equal(registry.registeredDocs.size, 0);
  releaseSeed();
  const room = await creating;
  assert.deepEqual(trace, [SEED_STEP_LABEL, HANDLE_KEY, USAGE_KEY, ROOM_ACTIVITY_META, FLUSH_STEP_LABEL, DISK_STEP_LABEL, REGISTRATION_KEY]);
  const name = registry.registeredDocForCapability(room.code, room.token);
  assert.ok(name);
  assert.equal(registry.registeredDocs.size, 1);
  assert.equal(registry.registeredRoomsByHandle.get(registry.roomHandleForDoc(name)), name);
  assertReservationsReleased(registry);
  assert.equal(registry.releases, 1);
  assert.equal(registry.registeredDocForCapability(room.code, `${room.token}x`), null);
});

for (const failAt of [SEED_STEP_LABEL, HANDLE_KEY, USAGE_KEY, ROOM_ACTIVITY_META, FLUSH_STEP_LABEL, REGISTRATION_KEY]) {
  test(`registry creation preserves the original ${failAt} failure and releases reservations`, async () => {
    const error = Object.assign(new Error('injected storage error'), { code: STORAGE_FAILURE_CODE });
    const { registry, trace, metadata } = await registryFixture({ failAt, error });
    await assert.rejects(registry.createRoom(), (actual) => actual === error);
    assert.equal(trace.at(-2), ROLLBACK_STEP_LABEL);
    assert.equal(trace.at(-1), DISK_STEP_LABEL);
    assert.equal(registry.registeredDocs.size, 0);
    assert.equal(metadata.size, 0);
    assertReservationsReleased(registry);
    assert.equal(registry.releases, 1);
  });
}

test('registry rollback storage failure latches once without replacing the creation error', async () => {
  const error = new Error('primary failure');
  const cleanupError = Object.assign(new Error('rollback failed'), { code: STORAGE_FAILURE_CODE });
  const { registry, failures } = await registryFixture({ failAt: SEED_STEP_LABEL, error, cleanupError });
  await assert.rejects(registry.createRoom(), (actual) => actual === error);
  await assert.rejects(registry.createRoom(), (actual) => actual === error);
  assert.deepEqual(failures, [cleanupError]);
  assertReservationsReleased(registry);
});

test('registry capacity rejection releases reservations without reporting storage failure', async () => {
  const { registry, trace, failures } = await registryFixture({ maxStoreOps: 0 });
  await assert.rejects(registry.createRoom(), { code: ROOM_CAPACITY_CODE });
  assert.deepEqual(trace, [ROLLBACK_STEP_LABEL, DISK_STEP_LABEL]);
  assertReservationsReleased(registry);
  assert.deepEqual(failures, []);
});

test('registry room reservations prevent concurrent creation beyond the count limit', async () => {
  let releaseSeed;
  const holdSeed = new Promise((resolve) => { releaseSeed = resolve; });
  const { registry } = await registryFixture({ maxRooms: 1, holdSeed });
  const creating = registry.createRoom();
  await assert.rejects(registry.createRoom(), { code: ROOM_CAPACITY_CODE });
  releaseSeed();
  await creating;
  assert.equal(registry.pending, 0);
});

test('registry disk quota failure precedes marker and latches before rollback failure', async () => {
  const cleanupError = new Error('cleanup failure');
  const { registry, trace, failures } = await registryFixture({ maxBytes: POST_QUOTA_DATABASE_BYTES, diskBytes: POST_QUOTA_DATABASE_BYTES + 1, cleanupError });
  await assert.rejects(registry.createRoom(), { code: ROOM_CAPACITY_CODE });
  assert.equal(trace.includes(REGISTRATION_KEY), false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, ROOM_CAPACITY_CODE);
  assert.deepEqual(trace, [SEED_STEP_LABEL, HANDLE_KEY, USAGE_KEY, ROOM_ACTIVITY_META, FLUSH_STEP_LABEL, DISK_STEP_LABEL, ROLLBACK_STEP_LABEL]);
  assertReservationsReleased(registry);
});

test('registry startup quarantines markerless docs, repairs handles and reconciles complete usage', async () => {
  const orphan = 'yjs/board-Orphan12-abcdefgh12345678';
  const metadata = new Map([[`${DOC_NAME}:${REGISTRATION_KEY}`, 1], [`${DOC_NAME}:${USAGE_KEY}`, { bytes: STALE_USAGE_BYTES, files: STALE_USAGE_FILES }]]);
  const { registry } = await registryFixture({ names: [orphan, DOC_NAME], metadata });
  assert.equal(registry.registeredDocs.has(orphan), false);
  assert.equal(registry.registeredDocs.has(DOC_NAME), true);
  assert.match(registry.roomHandleForDoc(DOC_NAME), ROOM_HANDLE_RE);
  assert.equal(metadata.get(`${DOC_NAME}:${USAGE_KEY}`).bytes, 0);
  assert.equal(metadata.get(`${DOC_NAME}:${USAGE_KEY}`).files, 0);
});

test('registry startup retains valid stored usage when the upload scan is incomplete', async () => {
  const metadata = new Map([[`${DOC_NAME}:${REGISTRATION_KEY}`, 1], [`${DOC_NAME}:${HANDLE_KEY}`, HANDLE],
    [`${DOC_NAME}:${USAGE_KEY}`, { bytes: STALE_USAGE_BYTES, files: STALE_USAGE_FILES }]]);
  const { registry } = await registryFixture({ names: [DOC_NAME], metadata,
    usage: { complete: false, roomsByHandle: new Map() } });
  assert.equal(registry.roomUploadUsage.get(DOC_NAME).bytes, STALE_USAGE_BYTES);
  assert.equal(registry.roomUploadUsage.get(DOC_NAME).files, STALE_USAGE_FILES);
});

test('registry startup throws when registered rooms exceed the configured count', async () => {
  const metadata = new Map([[`${DOC_NAME}:${REGISTRATION_KEY}`, 1]]);
  await assert.rejects(registryFixture({ names: [DOC_NAME], metadata, maxRooms: 0 }),
    { message: 'existing room count exceeds YJS_MAX_REGISTERED_ROOMS' });
});

test('registry rollback never clears a published room', async () => {
  const { registry, instance, trace } = await registryFixture();
  const room = await registry.createRoom();
  const name = registry.registeredDocForCapability(room.code, room.token);
  trace.length = 0;
  await instance.rollback(name);
  await instance.rollback(null);
  assert.deepEqual(trace, []);
  assert.equal(registry.registeredDocs.has(name), true);
});

test('registry disk scan errors preserve the original error and release store reservations', async () => {
  const error = new Error('disk scan failed');
  const { registry, trace, failures } = await registryFixture({ failDiskAt: POST_FLUSH_DISK_SCAN_COUNT, error });
  await assert.rejects(registry.createRoom(), (actual) => actual === error);
  assert.equal(trace.includes(REGISTRATION_KEY), false);
  assert.deepEqual(trace.slice(-3), [DISK_STEP_LABEL, ROLLBACK_STEP_LABEL, DISK_STEP_LABEL]);
  assert.deepEqual(failures, []);
  assertReservationsReleased(registry);
});

test('registry rollback disk scan failure latches without replacing the write error', async () => {
  const error = new Error('write and subsequent scan fail');
  const { registry, failures } = await registryFixture({ failAt: SEED_STEP_LABEL, failDiskAt: POST_FLUSH_DISK_SCAN_COUNT, error });
  await assert.rejects(registry.createRoom(), (actual) => actual === error);
  assert.deepEqual(failures, [error]);
  assertReservationsReleased(registry);
});

for (const key of [REGISTRATION_KEY, HANDLE_KEY, USAGE_KEY, ROOM_ACTIVITY_META]) {
  test(`registry startup propagates ${key} read failures`, async () => {
    const error = new Error('metadata read failed');
    const metadata = new Map([[`${DOC_NAME}:${REGISTRATION_KEY}`, 1], [`${DOC_NAME}:${HANDLE_KEY}`, HANDLE]]);
    await assert.rejects(registryFixture({ names: [DOC_NAME], metadata, failReadAt: key, error }), (actual) => actual === error);
  });
}

for (const key of [HANDLE_KEY, USAGE_KEY]) {
  test(`registry startup propagates ${key} repair failures`, async () => {
    const error = new Error('repair write failed');
    const metadata = new Map([[`${DOC_NAME}:${REGISTRATION_KEY}`, 1], [`${DOC_NAME}:${USAGE_KEY}`, { bytes: STALE_USAGE_BYTES, files: STALE_USAGE_FILES }]]);
    await assert.rejects(registryFixture({ names: [DOC_NAME], metadata, failAt: key, error }), (actual) => actual === error);
  });
}

test('registry startup propagates enumeration failure and rejects duplicate handles', async () => {
  const namesError = new Error('enumeration failed');
  await assert.rejects(registryFixture({ namesError }), (actual) => actual === namesError);
  const other = 'yjs/board-Example2-abcdefgh12345678';
  const metadata = new Map([DOC_NAME, other].flatMap((name) => [
    [`${name}:${REGISTRATION_KEY}`, 1], [`${name}:${HANDLE_KEY}`, HANDLE],
  ]));
  await assert.rejects(registryFixture({ names: [DOC_NAME, other], metadata }), { message: 'room handle collision' });
});

test('registry startup uses actual room usage from a complete scan', async () => {
  const metadata = new Map([[`${DOC_NAME}:${REGISTRATION_KEY}`, 1], [`${DOC_NAME}:${HANDLE_KEY}`, HANDLE]]);
  const actual = { bytes: STALE_USAGE_BYTES, files: STALE_USAGE_FILES };
  const { registry } = await registryFixture({ names: [DOC_NAME], metadata,
    usage: { complete: true, roomsByHandle: new Map([[HANDLE, actual]]) } });
  assert.deepEqual(metadata.get(`${DOC_NAME}:${USAGE_KEY}`), actual);
  assert.deepEqual(registry.roomUploadUsage.get(DOC_NAME), { ...actual, reservedBytes: 0, active: 0 });
});

test('registry unavailable service precedes capacity and performs no persistence work', async () => {
  const { registry, trace } = await registryFixture({ maxRooms: 0 });
  await assert.rejects(registry.createRoom({ unavailable: true }), { code: SERVER_UNAVAILABLE_CODE });
  assert.deepEqual(trace, []);
});

test('registry unpublish removes the room from memory in the same call, and clearRoomStorage wipes its storage', async () => {
  const { registry, instance, metadata, trace } = await registryFixture();
  const room = await registry.createRoom();
  const kept = await registry.createRoom();
  const docName = registry.registeredDocForCapability(room.code, room.token);
  const handle = registry.roomHandleForDoc(docName);
  trace.length = 0;
  assert.equal(instance.unpublish(docName), handle);
  assert.deepEqual(trace, [], 'unpublishing touches no storage');
  assert.equal(registry.registeredDocForCapability(room.code, room.token), null);
  assert.equal(registry.registeredRoomsByHandle.has(handle), false);
  assert.equal(registry.roomUploadUsage.has(docName), false);
  assert.equal(instance.existingDocNames.has(docName), false);
  assert.equal(instance.registeredDocDigests.has(docName), false);
  await instance.clearRoomStorage(docName);
  assert.ok(trace.includes(ROLLBACK_STEP_LABEL));
  assert.equal([...metadata.keys()].some((key) => key.startsWith(`${docName}:`)), false);
  assert.ok(registry.registeredDocForCapability(kept.code, kept.token));
  assert.equal(registry.registeredDocs.size, 1);
});

test('registry unpublish of an unknown room returns null and does no work', async () => {
  const { instance, trace } = await registryFixture();
  assert.equal(instance.unpublish(DOC_NAME), null);
  assert.deepEqual(trace, []);
});

test('registry clearRoomStorage failure latches and rejects', async () => {
  const error = Object.assign(new Error('clear failed'), { code: STORAGE_FAILURE_CODE });
  const { registry, instance, failures } = await registryFixture({ cleanupError: error });
  const room = await registry.createRoom();
  const docName = registry.registeredDocForCapability(room.code, room.token);
  instance.unpublish(docName);
  await assert.rejects(instance.clearRoomStorage(docName), error);
  assert.deepEqual(failures, [error]);
});

test('registry publishLock of an unpublished room is ignored, so a late commit cannot re-publish it', async () => {
  const { registry, instance } = await registryFixture();
  const room = await registry.createRoom();
  const docName = registry.registeredDocForCapability(room.code, room.token);
  instance.unpublish(docName);
  instance.publishLock(docName, LATE_LOCK_RECORD);
  assert.equal(instance.isLocked(docName), false);
});

test('hydrate never registers a room that is being deleted', async () => {
  const metadata = new Map([[`${DOC_NAME}:${REGISTRATION_KEY}`, 1], [`${DOC_NAME}:${HANDLE_KEY}`, HANDLE]]);
  const persistenceNames = [DOC_NAME];
  const { instance, trace } = await registryFixture({ metadata, names: persistenceNames, deleting: new Set([DOC_NAME]) });
  assert.equal(instance.registeredDocs.has(DOC_NAME), false);
  assert.equal(trace.some((step) => step.startsWith('read:')), false, 'not even its marker is read');
});

const ownedBy = (accountId, kind = ROOM_KIND.BOARD) => ({ kind, accountId });
const ownedDocOf = (index) => `yjs/board-Owned${index}-abcdefgh12345678`;
// Committed rooms already owned by OWNER_ACCOUNT, as hydrate finds them on disk.
function ownedRoomsOnDisk(count) {
  const names = [];
  const metadata = new Map();
  for (let index = 0; index < count; index += 1) {
    const name = ownedDocOf(index);
    names.push(name);
    metadata.set(`${name}:${REGISTRATION_KEY}`, 1);
    metadata.set(`${name}:${ROOM_OWNER_META}`, encodeOwnerRecord({ kind: ROOM_KIND.BOARD, accountId: OWNER_ACCOUNT, createdAt: OWNER_CREATED_AT }));
  }
  return { names, metadata };
}

test('an owned room writes its owner record durably, after the disk check and before the marker', async () => {
  const { registry, instance, trace, metadata } = await registryFixture();
  const room = await registry.createRoom({ owner: ownedBy(OWNER_ACCOUNT, ROOM_KIND.POKER) });
  assert.deepEqual(trace, [SEED_STEP_LABEL, HANDLE_KEY, USAGE_KEY, ROOM_ACTIVITY_META, FLUSH_STEP_LABEL, DISK_STEP_LABEL, DURABLE_STEP_LABEL, REGISTRATION_KEY]);
  const docName = registry.registeredDocForCapability(room.code, room.token);
  const stored = metadata.get(`${docName}:${ROOM_OWNER_META}`);
  assert.equal(stored.accountId, OWNER_ACCOUNT);
  assert.equal(stored.kind, ROOM_KIND.POKER);
  const ownership = instance.ownershipOf(docName);
  assert.equal(ownership.retention, RETENTION_CLASS.KEPT);
  assert.equal(ownership.ownerAccountId, OWNER_ACCOUNT);
  assert.equal(ownership.kind, ROOM_KIND.POKER);
  assert.equal(ownership.locked, false);
  assert.deepEqual(instance.roomsOwnedBy(OWNER_ACCOUNT), [docName]);
});

test('a guest room is recorded with no account, indexed under nobody, and expires as a guest room', async () => {
  const { registry, instance } = await registryFixture();
  const room = await registry.createRoom({ owner: ownedBy(null) });
  const docName = registry.registeredDocForCapability(room.code, room.token);
  const ownership = instance.ownershipOf(docName);
  assert.equal(ownership.record.accountId, null);
  assert.equal(ownership.retention, RETENTION_CLASS.GUEST);
  assert.equal(ownership.ownerAccountId, null);
});

test('a room created with no owner (the Public Wall) gets no record and is kept', async () => {
  const { registry, instance, trace, metadata } = await registryFixture();
  const room = await registry.createRoom();
  const docName = registry.registeredDocForCapability(room.code, room.token);
  assert.equal(trace.includes(DURABLE_STEP_LABEL), false);
  assert.equal(metadata.has(`${docName}:${ROOM_OWNER_META}`), false);
  assert.deepEqual(instance.ownershipOf(docName), {
    record: null, retention: RETENTION_CLASS.KEPT, ownerAccountId: null, kind: ROOM_KIND.BOARD, locked: false,
  });
  assert.equal(instance.ownershipOf(DOC_NAME), null, 'an unknown room has no ownership');
});

test('an invalid owner is refused before anything is reserved', async () => {
  const { registry, trace } = await registryFixture();
  for (const owner of [ownedBy('short'), ownedBy(OWNER_ACCOUNT, 'canvas'), {}]) {
    await assert.rejects(registry.createRoom({ owner }), TypeError);
  }
  assert.deepEqual(trace, []);
  assertReservationsReleased(registry);
});

test('two concurrent creates at 499 owned rooms: exactly one succeeds and the limit is a 409 code', async () => {
  let releaseSeed;
  const holdSeed = new Promise((resolve) => { releaseSeed = resolve; });
  const disk = ownedRoomsOnDisk(MAX_OWNED_ROOMS_PER_ACCOUNT - 1);
  const { registry, instance } = await registryFixture({ ...disk, holdSeed, maxRooms: ROOMS_BEYOND_THE_LIMIT });
  assert.equal(instance.roomsOwnedBy(OWNER_ACCOUNT).length, MAX_OWNED_ROOMS_PER_ACCOUNT - 1);
  const first = registry.createRoom({ owner: ownedBy(OWNER_ACCOUNT) });
  const second = registry.createRoom({ owner: ownedBy(OWNER_ACCOUNT) });
  releaseSeed();
  const [won, lost] = await Promise.allSettled([first, second]);
  assert.equal(won.status, 'fulfilled');
  assert.equal(lost.status, 'rejected');
  assert.equal(lost.reason.code, OWNED_ROOM_LIMIT_CODE);
  assert.equal(instance.roomsOwnedBy(OWNER_ACCOUNT).length, MAX_OWNED_ROOMS_PER_ACCOUNT);
  assertReservationsReleased(registry);
  const guest = await registry.createRoom({ owner: ownedBy(null) });
  assert.ok(guest.code, 'the account limit never blocks guest rooms');
});

test('a failed owned create releases its reservation, so the last slot is still usable', async () => {
  const error = Object.assign(new Error('injected marker failure'), { code: STORAGE_FAILURE_CODE });
  const disk = ownedRoomsOnDisk(MAX_OWNED_ROOMS_PER_ACCOUNT - 1);
  const options = { ...disk, maxRooms: ROOMS_BEYOND_THE_LIMIT, failAt: REGISTRATION_KEY, error };
  const { registry, instance } = await registryFixture(options);
  await assert.rejects(registry.createRoom({ owner: ownedBy(OWNER_ACCOUNT) }), (actual) => actual === error);
  options.failAt = DURABLE_STEP_LABEL;
  await assert.rejects(registry.createRoom({ owner: ownedBy(OWNER_ACCOUNT) }), (actual) => actual === error);
  assert.equal(instance.roomsOwnedBy(OWNER_ACCOUNT).length, MAX_OWNED_ROOMS_PER_ACCOUNT - 1);
  options.failAt = undefined;
  await registry.createRoom({ owner: ownedBy(OWNER_ACCOUNT) });
  await assert.rejects(registry.createRoom({ owner: ownedBy(OWNER_ACCOUNT) }), { code: OWNED_ROOM_LIMIT_CODE });
  assertReservationsReleased(registry);
});

test('unpublishing an owned room removes it from the owner index at once', async () => {
  const { registry, instance } = await registryFixture();
  const room = await registry.createRoom({ owner: ownedBy(OWNER_ACCOUNT) });
  const docName = registry.registeredDocForCapability(room.code, room.token);
  instance.unpublish(docName);
  assert.deepEqual(instance.roomsOwnedBy(OWNER_ACCOUNT), []);
  assert.equal(instance.ownershipOf(docName), null);
});
