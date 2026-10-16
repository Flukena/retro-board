import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ROOM_HANDLE_RE, STORE_OPERATION_OVERHEAD_BYTES } from './src/relay-config.js';
import { RoomRegistry, REGISTRY_STORAGE_FAILURE_EVENT, databaseCapacityError } from './src/relay-room-registry.js';

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
const ROOM_CAPACITY_CODE = 'ROOM_CAPACITY';
const STORAGE_FAILURE_CODE = 'STORAGE_FAILURE';
const SERVER_UNAVAILABLE_CODE = 'SERVER_UNAVAILABLE';
const ROOM_HANDLE_CHARACTERS = 32;
const HANDLE = 'H'.repeat(ROOM_HANDLE_CHARACTERS);
const QUIET_LOGGER = { warn() {}, error() {} };

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
  await instance.hydrate(options.usage || { complete: true, roomsByHandle: new Map() });
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
  assert.deepEqual(trace, [SEED_STEP_LABEL, HANDLE_KEY, USAGE_KEY, FLUSH_STEP_LABEL, DISK_STEP_LABEL, REGISTRATION_KEY]);
  const name = registry.registeredDocForCapability(room.code, room.token);
  assert.ok(name);
  assert.equal(registry.registeredDocs.size, 1);
  assert.equal(registry.registeredRoomsByHandle.get(registry.roomHandleForDoc(name)), name);
  assertReservationsReleased(registry);
  assert.equal(registry.releases, 1);
  assert.equal(registry.registeredDocForCapability(room.code, `${room.token}x`), null);
});

for (const failAt of [SEED_STEP_LABEL, HANDLE_KEY, USAGE_KEY, FLUSH_STEP_LABEL, REGISTRATION_KEY]) {
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
  assert.deepEqual(trace, [SEED_STEP_LABEL, HANDLE_KEY, USAGE_KEY, FLUSH_STEP_LABEL, DISK_STEP_LABEL, ROLLBACK_STEP_LABEL]);
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

for (const key of [REGISTRATION_KEY, HANDLE_KEY, USAGE_KEY]) {
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
