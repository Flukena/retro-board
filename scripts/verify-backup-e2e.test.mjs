import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { E2ERoomLog, E2E_BLOBS_KEY, E2E_HEAD_KEY, E2E_SNAPSHOT_KEY, E2E_UPDATE_KEY_PREFIX } from '../src/server/e2e-room-log.js';
import { ROOM_LOCK_META, encodeLockRecord } from '../src/server/room-lock-record.js';
import { ROOM_HANDLE_META } from '../src/server/relay-room-registry.js';
import { e2eBlobFilename } from '../src/server/relay-uploads.js';
import { durableMetaBatch } from '../src/server/relay-storage.js';
import { lockRecord } from '../src/server/room-lock-fixtures.mjs';
import { verifyBackupE2ERooms } from './verify-backup-e2e.mjs';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');
const Y = require('yjs');

const DOC = 'room-doc-1';
const HANDLE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BLOB_A = '11111111-1111-4111-8111-111111111111';
const BLOB_B = '22222222-2222-4222-8222-222222222222';
const BLOB_ORPHAN = '33333333-3333-4333-8333-333333333333';
const MAX_ROOM_BYTES = 10_000;
const BLOB_BYTES = 12;
const ROTATION_ID = 'rotation-1';
const bytesOf = (length, fill = 1) => new Uint8Array(length).fill(fill);
const put = (key, value) => ({ type: 'put', key, value });
const del = (key) => ({ type: 'del', key });
const seqKey = (seq) => E2E_UPDATE_KEY_PREFIX + String(seq).padStart(16, '0');

async function openFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'verify-e2e-'));
  const uploads = await mkdtemp(join(tmpdir(), 'verify-e2e-uploads-'));
  const ldb = new LeveldbPersistence(dir);
  t.after(async () => {
    await ldb.destroy();
    await rm(dir, { recursive: true, force: true });
    await rm(uploads, { recursive: true, force: true });
  });
  const log = new E2ERoomLog({
    ldb, maxRoomBytes: MAX_ROOM_BYTES, reserveStore: () => () => {}, setTimer: () => 0, clearTimer: () => {},
  });
  return { ldb, log, uploads };
}

const blobPath = (uploads, id) => join(uploads, e2eBlobFilename(HANDLE, id));

async function seedRoom({ ldb, log, uploads }, { stagedBlob = false } = {}) {
  // A registered room always stores a Yjs update, which is what makes getAllDocNames list it.
  await ldb.storeUpdate(DOC, Y.encodeStateAsUpdate(new Y.Doc()));
  await ldb.setMeta(DOC, ROOM_LOCK_META, encodeLockRecord(lockRecord()));
  await ldb.setMeta(DOC, ROOM_HANDLE_META, HANDLE);
  for (let i = 0; i < 4; i += 1) await log.append(DOC, bytesOf(4, i));
  await log.snapshot(DOC, 2, bytesOf(6, 9));
  await log.addBlob(DOC, { id: BLOB_A, bytes: BLOB_BYTES, epoch: 1 });
  await writeFile(blobPath(uploads, BLOB_A), bytesOf(BLOB_BYTES));
  if (stagedBlob) {
    const { rotationId } = await log.freeze(DOC, 1000, { verify: () => true });
    await log.addBlob(DOC, { id: BLOB_B, bytes: BLOB_BYTES, epoch: 1, stagedFor: rotationId });
    await writeFile(blobPath(uploads, BLOB_B), bytesOf(BLOB_BYTES));
  }
}

test('a valid room verifies', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  assert.deepEqual(await verifyBackupE2ERooms(fx.ldb, fx.uploads), { rooms: 1, stagedBlobs: 0, orphanBlobs: 0 });
});

test('a pre-E2E backup verifies with 0 rooms', async (t) => {
  const fx = await openFixture(t);
  await fx.ldb.storeUpdate('plain-room', Y.encodeStateAsUpdate(new Y.Doc()));
  assert.deepEqual(await verifyBackupE2ERooms(fx.ldb, fx.uploads), { rooms: 0, stagedBlobs: 0, orphanBlobs: 0 });
});

test('a backup taken mid-rotation reports staged blobs without failing', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx, { stagedBlob: true });
  assert.deepEqual(await verifyBackupE2ERooms(fx.ldb, fx.uploads), { rooms: 1, stagedBlobs: 1, orphanBlobs: 0 });
});

test('a file outside the inventory is counted as an orphan, not an error', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  await writeFile(blobPath(fx.uploads, BLOB_ORPHAN), bytesOf(3));
  await writeFile(join(fx.uploads, e2eBlobFilename('B'.repeat(32), BLOB_ORPHAN)), bytesOf(3));
  assert.deepEqual(await verifyBackupE2ERooms(fx.ldb, fx.uploads), { rooms: 1, stagedBlobs: 0, orphanBlobs: 1 });
});

test('a gap in the update sequence fails', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  await durableMetaBatch(fx.ldb, DOC, [del(seqKey(3))]);
  await assert.rejects(verifyBackupE2ERooms(fx.ldb, fx.uploads), /encrypted room update log is not contiguous/);
});

test('a head behind the snapshot base fails', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  await durableMetaBatch(fx.ldb, DOC, [put(E2E_HEAD_KEY, 1)]);
  await assert.rejects(verifyBackupE2ERooms(fx.ldb, fx.uploads), /encrypted room head is behind its snapshot/);
});

test('a missing snapshot fails when the log starts after seq 0', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  await durableMetaBatch(fx.ldb, DOC, [del(E2E_SNAPSHOT_KEY)]);
  await assert.rejects(verifyBackupE2ERooms(fx.ldb, fx.uploads), /encrypted room snapshot is missing/);
});

test('a snapshot with the wrong digest fails', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  const metas = await fx.ldb.getMetas(DOC);
  const snapshot = metas.get(E2E_SNAPSHOT_KEY);
  await durableMetaBatch(fx.ldb, DOC, [put(E2E_SNAPSHOT_KEY, { ...snapshot, bytes: bytesOf(6, 1) })]);
  await assert.rejects(verifyBackupE2ERooms(fx.ldb, fx.uploads), /encrypted room snapshot digest does not match/);
});

test('a deleted blob file fails', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  await unlink(blobPath(fx.uploads, BLOB_A));
  await assert.rejects(verifyBackupE2ERooms(fx.ldb, fx.uploads), /encrypted room blob file is missing or has the wrong size/);
});

test('a truncated blob file fails', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  await writeFile(blobPath(fx.uploads, BLOB_A), bytesOf(BLOB_BYTES - 1));
  await assert.rejects(verifyBackupE2ERooms(fx.ldb, fx.uploads), /encrypted room blob file is missing or has the wrong size/);
});

test('a lock record that does not decode fails', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  await durableMetaBatch(fx.ldb, DOC, [put(ROOM_LOCK_META, { v: 1 })]);
  await assert.rejects(verifyBackupE2ERooms(fx.ldb, fx.uploads), /encrypted room lock record is invalid/);
});

test('the error never names the room, handle or blob', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  await unlink(blobPath(fx.uploads, BLOB_A));
  await assert.rejects(verifyBackupE2ERooms(fx.ldb, fx.uploads), (e) => ![DOC, HANDLE, BLOB_A].some((s) => e.message.includes(s)));
});

test('an inventory id that is not a blob id fails without touching paths outside uploads', async (t) => {
  const fx = await openFixture(t);
  await seedRoom(fx);
  await durableMetaBatch(fx.ldb, DOC, [put(E2E_BLOBS_KEY, [{ id: '../escape', bytes: BLOB_BYTES, epoch: 0 }])]);
  await assert.rejects(verifyBackupE2ERooms(fx.ldb, fx.uploads), /encrypted room blob inventory is invalid/);
});
