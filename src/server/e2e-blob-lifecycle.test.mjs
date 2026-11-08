import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { E2ERoomLog, E2E_BLOB_GRACE_MS } from './e2e-room-log.js';
import { E2EBlobStore, E2E_ORPHAN_MIN_AGE_MS } from './e2e-blob-store.js';
import { createE2EBlobs } from './e2e-blobs.js';
import { createImageReadBudgets, createRelayUploads, createUploadState, e2eBlobFilename } from './relay-uploads.js';
import { readRelayConfig } from './relay-config.js';
import { ROOM_LOCK_META, decodeLockRecord, encodeLockRecord } from './room-lock-record.js';
import { lockRecord, START_MS } from './room-lock-fixtures.mjs';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');

const ORIGIN = 'https://allowed.example';
const CLIENT_IP = '127.0.0.1';
const DOC = 'yjs/board-room-aaaaaaaa';
const HANDLE = 'H'.repeat(32);
const OTHER_DOC = 'yjs/board-other-bbbbbbbb';
const OTHER_HANDLE = 'O'.repeat(32);
const BLOB_BYTES = 64;
const FREEZE_TTL_MS = 120_000;
const approve = () => true;
const quiet = { log() {}, warn() {}, error() {} };

class Response extends Writable {
  headers = {};
  _write(_chunk, _encoding, callback) { callback(); }
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
  setHeader(name, value) { this.headers[name] = value; }
}

async function withBlobs(run) {
  const root = await mkdtemp(join(tmpdir(), 'e2e-blob-lifecycle-'));
  const uploadsDir = join(root, 'uploads');
  await mkdir(uploadsDir);
  const ldb = new LeveldbPersistence(join(root, 'db'));
  const clock = { now: START_MS };
  try {
    await ldb.setMeta(DOC, ROOM_LOCK_META, encodeLockRecord(lockRecord()));
    const config = readRelayConfig({ YJS_UPLOADS_DIR: uploadsDir, YJS_MAX_UPLOAD_BYTES: '1024' });
    const state = createUploadState(config);
    const roomUploadUsage = new Map([[DOC, { bytes: 0, files: 0, active: 0, reservedBytes: 0 }], [OTHER_DOC, { bytes: 0, files: 0, active: 0, reservedBytes: 0 }]]);
    const uploads = createRelayUploads({
      config, state, roomUploadUsage, imageReads: createImageReadBudgets(config), storage: { setMeta: (...args) => ldb.setMeta(...args) },
      allowedOrigins: [ORIGIN], allowInsecureHttp: false,
    });
    const store = new E2EBlobStore({ uploadsDir, admission: uploads.admission, roomUploadUsage, logger: quiet });
    const roomLog = new E2ERoomLog({
      ldb, maxRoomBytes: 1_000_000, reserveStore: () => () => undefined, now: () => clock.now,
      setTimer: () => ({}), clearTimer: () => undefined, deleteStagedBlobs: (_docName, rotationId) => store.deleteStaged(rotationId),
    });
    const locks = new Map([[DOC, decodeLockRecord(encodeLockRecord(lockRecord()))], [OTHER_DOC, decodeLockRecord(encodeLockRecord(lockRecord()))]]);
    const handles = new Map([[DOC, HANDLE], [OTHER_DOC, OTHER_HANDLE]]);
    const registry = {
      locksByDoc: locks, lockFor: (docName) => locks.get(docName) ?? null, isLocked: (docName) => locks.has(docName),
      roomHandleForDoc: (docName) => handles.get(docName) ?? null,
    };
    const blobs = createE2EBlobs({
      config, allowedOrigins: [ORIGIN], allowInsecureHttp: false, uploads, store, roomLog, registry,
      onStorageFailure: (error) => { throw error; }, logger: quiet, now: () => clock.now,
    });
    await run({ blobs, store, roomLog, roomUploadUsage, uploadsDir, ldb, clock, state, locks });
  } finally {
    await ldb.destroy();
    await rm(root, { recursive: true, force: true });
  }
}

const upload = async (blobs, { id = randomUUID(), stage, bytes = BLOB_BYTES, docName = DOC, handle = HANDLE } = {}) => {
  const body = Buffer.alloc(bytes, 5);
  const headers = {
    origin: ORIGIN, 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'x-blob-id': id,
    ...(stage ? { 'x-blob-stage': stage } : {}),
  };
  const req = Object.assign(Readable.from([body]), { headers });
  const res = new Response();
  const finished = once(res, 'finish');
  await blobs.handleUpload(req, res, CLIENT_IP, docName, handle);
  await finished;
  return { id, status: res.status };
};

const e2eFiles = async (uploadsDir) => (await readdir(uploadsDir)).filter((name) => name.endsWith('.e2e')).sort();
const inventoryIds = async (roomLog) => (await roomLog.blobs(DOC)).map((entry) => entry.id).sort();
const setAge = async (path, ageMs, now) => { const at = new Date(now - ageMs); await utimes(path, at, at); };

test('a blob staged during a rotation is deleted, with its usage, when the rotation is released', () => withBlobs(async ({ blobs, roomLog, roomUploadUsage, uploadsDir, state }) => {
  const { rotationId } = await roomLog.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  const staged = await upload(blobs, { stage: rotationId });
  assert.equal(staged.status, 201);
  assert.deepEqual(await e2eFiles(uploadsDir), [e2eBlobFilename(HANDLE, staged.id)]);
  assert.deepEqual(roomUploadUsage.get(DOC), { bytes: BLOB_BYTES, files: 1, active: 0, reservedBytes: 0 });
  assert.equal((await roomLog.blobs(DOC))[0].stagedFor, rotationId);

  assert.equal(await roomLog.release(DOC, rotationId), true);
  assert.deepEqual(await e2eFiles(uploadsDir), []);
  assert.deepEqual(await inventoryIds(roomLog), []);
  assert.deepEqual(roomUploadUsage.get(DOC), { bytes: 0, files: 0, active: 0, reservedBytes: 0 });
  assert.equal(state.bytes, 0);
}));

test('a staged upload that arrives after its rotation ended is refused and leaves no file or usage', () => withBlobs(async ({ blobs, roomLog, roomUploadUsage, uploadsDir, state }) => {
  const { rotationId } = await roomLog.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  await roomLog.release(DOC, rotationId);
  const late = await upload(blobs, { stage: rotationId });
  assert.equal(late.status, 409);
  assert.deepEqual(await e2eFiles(uploadsDir), []);
  assert.deepEqual(await readdir(uploadsDir), [], 'no temp file is left behind either');
  assert.deepEqual(await inventoryIds(roomLog), []);
  assert.equal(roomUploadUsage.get(DOC).files, 0);
  assert.equal(state.files, 0);
}));

test('a staged upload for a rotation that never existed is refused with 409', () => withBlobs(async ({ blobs, uploadsDir }) => {
  assert.equal((await upload(blobs, { stage: randomUUID() })).status, 409);
  assert.deepEqual(await readdir(uploadsDir), []);
}));

const commitRotation = async (roomLog, blobInventory) => {
  const { rotationId } = await roomLog.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  await roomLog.commitRotation(DOC, {
    rotationId, expectedHead: 0, verify: approve, snapshot: new Uint8Array(4), lockRecord: lockRecord({ keyEpoch: 1 }), blobInventory,
  });
};

test('old-epoch blobs keep their files for the grace, then the sweep deletes file, entry and usage', () => withBlobs(async ({ blobs, roomLog, roomUploadUsage, uploadsDir, clock, state }) => {
  const first = await upload(blobs);
  const second = await upload(blobs);
  await commitRotation(roomLog, await roomLog.blobs(DOC));
  const rotatedAt = clock.now;

  clock.now = rotatedAt + E2E_BLOB_GRACE_MS - 1;
  await blobs.sweepExpired();
  assert.equal((await e2eFiles(uploadsDir)).length, 2, 'still inside the grace');

  clock.now = rotatedAt + E2E_BLOB_GRACE_MS;
  await blobs.sweepExpired();
  assert.deepEqual(await e2eFiles(uploadsDir), []);
  assert.deepEqual(await inventoryIds(roomLog), []);
  assert.deepEqual(roomUploadUsage.get(DOC), { bytes: 0, files: 0, active: 0, reservedBytes: 0 });
  assert.equal(state.bytes, 0);
  assert.deepEqual([first.status, second.status], [201, 201]);
}));

test('the expiry sweep keeps blobs uploaded under the new epoch', () => withBlobs(async ({ blobs, roomLog, uploadsDir, clock, locks }) => {
  const old = await upload(blobs);
  await commitRotation(roomLog, await roomLog.blobs(DOC));
  locks.set(DOC, decodeLockRecord(encodeLockRecord(lockRecord({ keyEpoch: 1, lockRevision: 1 }))));
  const current = await upload(blobs);
  assert.deepEqual((await roomLog.blobs(DOC)).map((entry) => [entry.id, entry.epoch]).sort(), [[old.id, 0], [current.id, 1]].sort());
  clock.now += E2E_BLOB_GRACE_MS;
  await blobs.sweepExpired();
  assert.deepEqual(await e2eFiles(uploadsDir), [e2eBlobFilename(HANDLE, current.id)]);
  assert.deepEqual(await inventoryIds(roomLog), [current.id]);
}));

test('startup sweep deletes only unreferenced .e2e files strictly older than the age limit', () => withBlobs(async ({ blobs, roomLog, uploadsDir, clock }) => {
  const kept = await upload(blobs);
  const names = {
    inventoried: e2eBlobFilename(HANDLE, kept.id),
    atLimit: e2eBlobFilename(HANDLE, randomUUID()),
    pastLimit: e2eBlobFilename(HANDLE, randomUUID()),
    young: e2eBlobFilename(HANDLE, randomUUID()),
    goneRoom: e2eBlobFilename('G'.repeat(32), randomUUID()),
    image: `${HANDLE}.abcdef01.png`,
  };
  for (const name of Object.values(names)) if (name !== names.inventoried) await writeFile(join(uploadsDir, name), 'x');
  const ages = { inventoried: 3 * E2E_ORPHAN_MIN_AGE_MS, atLimit: E2E_ORPHAN_MIN_AGE_MS, pastLimit: E2E_ORPHAN_MIN_AGE_MS + 1, young: 1000, goneRoom: 5 * E2E_ORPHAN_MIN_AGE_MS, image: 5 * E2E_ORPHAN_MIN_AGE_MS };
  for (const [label, age] of Object.entries(ages)) await setAge(join(uploadsDir, names[label]), age, clock.now);

  assert.equal(await blobs.reconcileOrphans(), 2);
  const left = new Set(await readdir(uploadsDir));
  assert.deepEqual(
    Object.fromEntries(Object.entries(names).map(([label, name]) => [label, left.has(name)])),
    { inventoried: true, atLimit: true, pastLimit: false, young: true, goneRoom: false, image: true },
  );
  assert.deepEqual(await inventoryIds(roomLog), [kept.id]);
}));

test('a room whose inventory cannot be read keeps all of its files during the startup sweep', () => withBlobs(async ({ blobs, uploadsDir, clock, ldb }) => {
  await ldb.setMeta(OTHER_DOC, 'e2e-snapshot', { baseSeq: 1, bytes: new Uint8Array(3), sha256: 'not the digest' });
  const unknown = e2eBlobFilename(OTHER_HANDLE, randomUUID());
  const orphan = e2eBlobFilename(HANDLE, randomUUID());
  for (const name of [unknown, orphan]) {
    await writeFile(join(uploadsDir, name), 'x');
    await setAge(join(uploadsDir, name), 5 * E2E_ORPHAN_MIN_AGE_MS, clock.now);
  }
  assert.equal(await blobs.reconcileOrphans(), 1);
  assert.deepEqual(await e2eFiles(uploadsDir), [unknown]);
}));

test('deleteExcept removes every blob of the room that is not kept and returns the usage', () => withBlobs(async ({ blobs, store, roomUploadUsage, uploadsDir }) => {
  const keep = await upload(blobs);
  const drop = await upload(blobs);
  const otherRoom = await upload(blobs, { docName: OTHER_DOC, handle: OTHER_HANDLE });
  assert.equal(await store.deleteExcept(DOC, HANDLE, [keep.id]), 1);
  assert.deepEqual(await e2eFiles(uploadsDir), [e2eBlobFilename(HANDLE, keep.id), e2eBlobFilename(OTHER_HANDLE, otherRoom.id)].sort());
  assert.equal(roomUploadUsage.get(DOC).files, 1);
  assert.equal(roomUploadUsage.get(OTHER_DOC).files, 1);
  assert.equal((await stat(join(uploadsDir, e2eBlobFilename(HANDLE, keep.id)))).size, BLOB_BYTES);
  assert.notEqual(drop.id, keep.id);
}));

test('the startup sweep keeps only rooms that hold blobs in memory for the expiry sweep', () => withBlobs(async ({ blobs, roomLog }) => {
  await blobs.reconcileOrphans();
  assert.deepEqual(roomLog.loadedDocNames(), [], 'rooms without blobs are not pinned');
  const kept = await upload(blobs);
  await blobs.reconcileOrphans();
  assert.deepEqual(roomLog.loadedDocNames(), [DOC]);
  assert.deepEqual(await inventoryIds(roomLog), [kept.id]);
}));
