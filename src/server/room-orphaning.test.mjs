import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedStorage, durableMetaBatch, storageOperationError } from './relay-storage.js';
import { RoomRegistry } from './relay-room-registry.js';
import { lockRecord } from './room-lock-fixtures.mjs';
import { RETENTION_CLASS, ROOM_KIND } from '../domain/room-ownership.js';
import { orphanAccountRooms, orphanRoomsOfDeletedAccounts } from './room-orphaning.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const SIGNING_KEY_BYTES = 32;
const MAX_ROOMS = 20;
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const QUIET = Object.freeze({ warn() {}, error() {}, log() {} });
const NO_USAGE = { complete: true, roomsByHandle: new Map() };
const GONE = 'G'.repeat(22);
const KEPT = 'K'.repeat(22);
const NOW_MS = 1_900_000_000_000;

async function openRegistry(t, dir = null, { failOwnerWrites = () => false } = {}) {
  const root = dir ?? await mkdtemp(join(tmpdir(), 'room-orphaning-'));
  if (!dir) t.after(() => rm(root, { recursive: true, force: true }));
  const ldb = new LeveldbPersistence(root);
  const registry = new RoomRegistry({
    persistence: {
      ...checkedStorage(ldb, Y),
      durableMetaBatch: async (docName, ops) => {
        if (failOwnerWrites(docName)) throw storageOperationError('injected owner write failure');
        await durableMetaBatch(ldb, docName, ops);
      },
      hasCapacity: () => true, reserveStore: () => () => {}, measureDatabase: () => 0,
    },
    Y, maxRooms: MAX_ROOMS, maxDatabaseBytes: UNLIMITED, signingKey: Buffer.alloc(SIGNING_KEY_BYTES), log: QUIET,
  });
  await registry.hydrate(NO_USAGE);
  return { root, ldb, registry };
}

const docOf = (registry, { code, token }) => registry.registeredDocForCapability(code, token);
const create = async (registry, options) => docOf(registry, await registry.createRoom(options));
const accountsWithout = (...missing) => ({ get: async (id) => (missing.includes(id) ? null : { id }) });

function assertOrphaned(registry, docName, kind) {
  const ownership = registry.ownershipOf(docName);
  assert.equal(ownership.ownerAccountId, null);
  assert.equal(ownership.record.orphanedAt, NOW_MS);
  assert.equal(ownership.record.kind, kind);
  assert.equal(ownership.retention, RETENTION_CLASS.KEPT, 'an orphaned room is never a 24 h guest room');
}

test('orphaning an account rewrites every room it owns, a lock-only owner included, and nothing else', async (t) => {
  const { registry } = await openRegistry(t);
  const board = await create(registry, { owner: { kind: ROOM_KIND.BOARD, accountId: GONE } });
  const poker = await create(registry, { owner: { kind: ROOM_KIND.POKER, accountId: GONE } });
  const lockOnly = await create(registry, { lock: lockRecord({ ownerAccountId: GONE }) });
  const other = await create(registry, { owner: { kind: ROOM_KIND.BOARD, accountId: KEPT } });
  const guest = await create(registry, { owner: { kind: ROOM_KIND.BOARD, accountId: null } });

  assert.equal(await orphanAccountRooms({ registry, accountId: GONE, now: () => NOW_MS, log: QUIET }), 3);

  assertOrphaned(registry, board, ROOM_KIND.BOARD);
  assertOrphaned(registry, poker, ROOM_KIND.POKER);
  assertOrphaned(registry, lockOnly, ROOM_KIND.BOARD);
  assert.equal(registry.ownershipOf(lockOnly).record.createdAt, lockRecord().createdAt);
  assert.deepEqual(registry.roomsOwnedBy(GONE), []);
  assert.deepEqual(registry.roomsOwnedBy(KEPT), [other]);
  assert.equal(registry.ownershipOf(guest).retention, RETENTION_CLASS.GUEST);
});

test('one failed room write is reported and the rest are still orphaned', async (t) => {
  let failing = null;
  const { registry } = await openRegistry(t, null, { failOwnerWrites: (docName) => docName === failing });
  const first = await create(registry, { owner: { kind: ROOM_KIND.BOARD, accountId: GONE } });
  const second = await create(registry, { owner: { kind: ROOM_KIND.BOARD, accountId: GONE } });
  failing = first;
  const failures = [];
  const orphaned = await orphanAccountRooms({
    registry, accountId: GONE, now: () => NOW_MS, log: QUIET, onStorageFailure: (error) => failures.push(error.code),
  });
  assert.equal(orphaned, 1);
  assert.deepEqual(failures, ['STORAGE_FAILURE']);
  assert.equal(registry.ownershipOf(first).ownerAccountId, GONE);
  assertOrphaned(registry, second, ROOM_KIND.BOARD);
});

test('startup orphans the rooms of every account that no longer exists and survives a restart', async (t) => {
  const first = await openRegistry(t);
  const gone = await create(first.registry, { owner: { kind: ROOM_KIND.POKER, accountId: GONE } });
  const kept = await create(first.registry, { owner: { kind: ROOM_KIND.BOARD, accountId: KEPT } });
  await first.ldb.destroy();

  const second = await openRegistry(t, first.root);
  const orphaned = await orphanRoomsOfDeletedAccounts({
    registry: second.registry, accounts: accountsWithout(GONE), now: () => NOW_MS, log: QUIET,
  });
  assert.equal(orphaned, 1);
  assertOrphaned(second.registry, gone, ROOM_KIND.POKER);
  assert.equal(second.registry.ownershipOf(kept).ownerAccountId, KEPT);
  await second.ldb.destroy();

  const third = await openRegistry(t, first.root);
  t.after(() => third.ldb.destroy());
  assertOrphaned(third.registry, gone, ROOM_KIND.POKER);
});
