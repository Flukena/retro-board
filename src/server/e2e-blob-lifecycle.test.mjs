import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fsPromises, { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { E2ERoomLog, E2E_BLOB_GRACE_MS } from './e2e-room-log.js';
import { E2EBlobStore, E2E_ORPHAN_MIN_AGE_MS } from './e2e-blob-store.js';
import { createE2EBlobs } from './e2e-blobs.js';
import { IMAGE_MAX_BYTES } from '../domain/security-boundaries.js';
import { E2E_CIPHERTEXT_OVERHEAD_BYTES } from '../domain/e2e-envelope.js';
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

const EMPTY_USAGE = () => ({ bytes: 0, files: 0, active: 0, reservedBytes: 0 });

// Everything that survives a relay restart (files, LevelDB) is built once; `assemble` makes the in-memory side.
async function withBlobs(run, { maxUploadBytes = 1024 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'e2e-blob-lifecycle-'));
  const uploadsDir = join(root, 'uploads');
  await mkdir(uploadsDir);
  const ldb = new LeveldbPersistence(join(root, 'db'));
  const clock = { now: START_MS };
  const faults = { unlink: () => false, beforeUnlink: async () => undefined };
  const warnings = [];
  const logger = { ...quiet, warn: (...args) => warnings.push(args) };
  const io = {
    ...fsPromises,
    unlink: async (path) => {
      await faults.beforeUnlink(path);
      if (faults.unlink(path)) throw Object.assign(new Error('injected unlink failure'), { code: 'EACCES' });
      return fsPromises.unlink(path);
    },
  };
  const roomUploadUsage = new Map([[DOC, EMPTY_USAGE()], [OTHER_DOC, EMPTY_USAGE()]]);
  const locks = new Map();
  const handles = new Map([[DOC, HANDLE], [OTHER_DOC, OTHER_HANDLE]]);
  const config = readRelayConfig({ YJS_UPLOADS_DIR: uploadsDir, YJS_MAX_UPLOAD_BYTES: String(maxUploadBytes) });
  const assemble = () => {
    const state = createUploadState(config);
    const uploads = createRelayUploads({
      config, state, roomUploadUsage, imageReads: createImageReadBudgets(config), storage: { setMeta: (...args) => ldb.setMeta(...args) },
      allowedOrigins: [ORIGIN], allowInsecureHttp: false,
    });
    const store = new E2EBlobStore({ uploadsDir, admission: uploads.admission, roomUploadUsage, io, logger });
    const roomLog = new E2ERoomLog({
      ldb, maxRoomBytes: 1_000_000, reserveStore: () => () => undefined, now: () => clock.now,
      setTimer: () => ({}), clearTimer: () => undefined, deleteStagedBlobs: (_docName, rotationId) => store.deleteStaged(rotationId),
      onBlobsRetired: (docName) => store.trackRetired(docName),
    });
    const registry = {
      locksByDoc: locks, lockFor: (docName) => locks.get(docName) ?? null, isLocked: (docName) => locks.has(docName),
      roomHandleForDoc: (docName) => handles.get(docName) ?? null,
    };
    const blobs = createE2EBlobs({
      config, allowedOrigins: [ORIGIN], allowInsecureHttp: false, uploads, store, roomLog, registry,
      onStorageFailure: (error) => { throw error; }, logger, now: () => clock.now,
    });
    return { blobs, store, roomLog, state };
  };
  try {
    for (const docName of [DOC, OTHER_DOC]) {
      await ldb.setMeta(docName, ROOM_LOCK_META, encodeLockRecord(lockRecord()));
      locks.set(docName, decodeLockRecord(encodeLockRecord(lockRecord())));
    }
    await run({ ...assemble(), assemble, roomUploadUsage, uploadsDir, ldb, clock, locks, faults, warnings });
  } finally {
    await ldb.destroy();
    await rm(root, { recursive: true, force: true });
  }
}

const upload = async (blobs, { id = randomUUID(), stage, bytes = BLOB_BYTES, docName = DOC, handle = HANDLE, stream } = {}) => {
  const body = Buffer.alloc(bytes, 5);
  const headers = {
    origin: ORIGIN, 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'x-blob-id': id,
    ...(stage ? { 'x-blob-stage': stage } : {}),
  };
  const req = Object.assign(Readable.from(stream ? stream(body) : [body]), { headers });
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

test('settleStaged deletes only the staged files that are not kept, with their usage, and can be repeated', () => withBlobs(async ({ blobs, roomLog, store, roomUploadUsage, uploadsDir }) => {
  const { rotationId } = await roomLog.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  const kept = await upload(blobs, { stage: rotationId });
  const dropped = await upload(blobs, { stage: rotationId });
  await store.settleStaged(rotationId, [kept.id]);
  assert.deepEqual(await e2eFiles(uploadsDir), [e2eBlobFilename(HANDLE, kept.id)]);
  assert.deepEqual(roomUploadUsage.get(DOC), { bytes: BLOB_BYTES, files: 1, active: 0, reservedBytes: 0 });
  await store.settleStaged(rotationId, [kept.id]);
  assert.equal(roomUploadUsage.get(DOC).files, 1);
  assert.notEqual(dropped.id, kept.id);
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
  assert.deepEqual(roomUploadUsage.get(DOC), EMPTY_USAGE());
  assert.equal(state.bytes, 0);
  assert.deepEqual([first.status, second.status], [201, 201]);
}));

test('expiry still happens after the room left memory following the rotation', () => withBlobs(async ({ blobs, roomLog, store, uploadsDir, clock }) => {
  await upload(blobs);
  await commitRotation(roomLog, await roomLog.blobs(DOC));
  roomLog.forget(DOC);
  assert.deepEqual(roomLog.loadedDocNames(), [], 'the last socket closed and the room was evicted');
  assert.deepEqual(store.retiredRooms(), [DOC]);
  clock.now += E2E_BLOB_GRACE_MS;
  await blobs.sweepExpired();
  assert.deepEqual(await e2eFiles(uploadsDir), []);
  assert.deepEqual(await inventoryIds(roomLog), []);
  assert.deepEqual(store.retiredRooms(), [], 'a room with nothing retired left is no longer visited');
}));

test('a rotation that retires more blobs while the sweep deletes files keeps the room tracked', () => withBlobs(async ({ blobs, roomLog, store, clock, locks, faults, uploadsDir }) => {
  const first = await upload(blobs);
  await commitRotation(roomLog, await roomLog.blobs(DOC));
  locks.set(DOC, decodeLockRecord(encodeLockRecord(lockRecord({ keyEpoch: 1, lockRevision: 1 }))));
  const second = await upload(blobs);
  clock.now += E2E_BLOB_GRACE_MS;
  faults.beforeUnlink = async (path) => {
    faults.beforeUnlink = async () => undefined;
    if (!path.endsWith(`${first.id}.e2e`)) return;
    const { rotationId } = await roomLog.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 1, verify: approve });
    await roomLog.commitRotation(DOC, {
      rotationId, expectedHead: 0, verify: approve, snapshot: new Uint8Array(4), lockRecord: lockRecord({ keyEpoch: 2 }),
      blobInventory: (await roomLog.blobs(DOC)).filter((entry) => entry.id !== first.id),
    });
  };
  await blobs.sweepExpired();
  assert.deepEqual(store.retiredRooms(), [DOC], 'the second rotation retired a blob during the sweep');
  clock.now += E2E_BLOB_GRACE_MS;
  await blobs.sweepExpired();
  assert.deepEqual(await e2eFiles(uploadsDir), []);
  assert.deepEqual(await inventoryIds(roomLog), []);
  assert.deepEqual(store.retiredRooms(), []);
  assert.equal(second.status, 201);
}));

test('a failed file delete keeps the inventory entry and the next sweep retries it; a missing file counts as deleted', () => withBlobs(async ({ blobs, roomLog, uploadsDir, clock, faults }) => {
  const stuck = await upload(blobs);
  const gone = await upload(blobs);
  await commitRotation(roomLog, await roomLog.blobs(DOC));
  clock.now += E2E_BLOB_GRACE_MS;
  await rm(join(uploadsDir, e2eBlobFilename(HANDLE, gone.id)));
  faults.unlink = (path) => path.endsWith(`${stuck.id}.e2e`);
  await blobs.sweepExpired();
  assert.deepEqual(await inventoryIds(roomLog), [stuck.id], 'only the entry whose file could not be deleted remains');
  assert.deepEqual(await e2eFiles(uploadsDir), [e2eBlobFilename(HANDLE, stuck.id)]);
  faults.unlink = () => false;
  await blobs.sweepExpired();
  assert.deepEqual(await inventoryIds(roomLog), []);
  assert.deepEqual(await e2eFiles(uploadsDir), []);
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

test('an upload that outlives a rotation is refused with 409 and leaves no file, entry or usage', () => withBlobs(async ({ blobs, roomLog, roomUploadUsage, uploadsDir }) => {
  const slow = await upload(blobs, { stream: async function* rotateWhileStreaming(body) {
    yield body;
    await commitRotation(roomLog, []);
  } });
  assert.equal(slow.status, 409);
  assert.deepEqual(await readdir(uploadsDir), []);
  assert.deepEqual(await inventoryIds(roomLog), []);
  assert.deepEqual(roomUploadUsage.get(DOC), EMPTY_USAGE());
}));

test('a plain upload is refused with 409 while a rotation freeze is active', () => withBlobs(async ({ blobs, roomLog, roomUploadUsage, uploadsDir }) => {
  const { rotationId } = await roomLog.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  assert.equal((await upload(blobs)).status, 409);
  assert.deepEqual(await readdir(uploadsDir), []);
  assert.deepEqual(roomUploadUsage.get(DOC), EMPTY_USAGE());
  await roomLog.release(DOC, rotationId);
  assert.equal((await upload(blobs)).status, 201);
}));

test('the size cap is the image limit plus the envelope, never above the configured upload limit', async () => {
  const envelope = 256 + E2E_CIPHERTEXT_OVERHEAD_BYTES;
  await withBlobs(async ({ blobs }) => {
    assert.equal((await upload(blobs, { bytes: 1024 + envelope + 1 })).status, 413);
    assert.equal((await upload(blobs, { bytes: 1024 + envelope })).status, 201);
  });
  await withBlobs(async ({ blobs }) => {
    assert.equal((await upload(blobs, { bytes: IMAGE_MAX_BYTES + envelope + 1 })).status, 413, 'a larger configured limit does not raise the cap');
    assert.equal((await upload(blobs, { bytes: IMAGE_MAX_BYTES + envelope })).status, 201);
  }, { maxUploadBytes: 2 * IMAGE_MAX_BYTES });
});

test('a temp file that cannot be removed after publishing does not undo the upload; the startup sweep removes it later', () => withBlobs(async ({ blobs, roomLog, uploadsDir, faults, warnings, clock }) => {
  faults.unlink = (path) => path.endsWith('.tmp');
  const result = await upload(blobs);
  assert.equal(result.status, 201);
  assert.deepEqual(await inventoryIds(roomLog), [result.id]);
  assert.equal(warnings.length, 1, 'one warning');
  const [temp] = (await readdir(uploadsDir)).filter((name) => name.endsWith('.tmp'));
  assert.match(temp, /^\.upload-e2e-/);
  faults.unlink = () => false;
  await setAge(join(uploadsDir, temp), 1000, clock.now);
  await blobs.reconcileOrphans();
  assert.ok((await readdir(uploadsDir)).includes(temp), 'a young temp may belong to an upload in flight');
  await setAge(join(uploadsDir, temp), E2E_ORPHAN_MIN_AGE_MS + 1, clock.now);
  await blobs.reconcileOrphans();
  assert.deepEqual((await readdir(uploadsDir)).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual(await e2eFiles(uploadsDir), [e2eBlobFilename(HANDLE, result.id)]);
}));

test('after a restart, staged blobs of the lost rotation are deleted with their entries, and a failed delete is retried', () => withBlobs(async ({ blobs, roomLog, assemble, uploadsDir, roomUploadUsage, faults }) => {
  const { rotationId } = await roomLog.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  const staged = await upload(blobs, { stage: rotationId });
  assert.equal(staged.status, 201);
  const restarted = assemble();
  assert.equal(restarted.roomLog.loadedDocNames().length, 0);

  faults.unlink = (path) => path.endsWith('.e2e');
  assert.equal(await restarted.blobs.reconcileOrphans(), 0);
  assert.deepEqual(await e2eFiles(uploadsDir), [e2eBlobFilename(HANDLE, staged.id)], 'the file survives a failed delete');
  assert.deepEqual((await restarted.roomLog.blobs(DOC)).map((entry) => entry.id), [staged.id], 'so does its entry');

  faults.unlink = () => false;
  assert.equal(await restarted.blobs.reconcileOrphans(), 1);
  assert.deepEqual(await e2eFiles(uploadsDir), []);
  assert.deepEqual(await restarted.roomLog.blobs(DOC), []);
  assert.deepEqual(roomUploadUsage.get(DOC), EMPTY_USAGE());
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

test('the startup sweep leaves no locked room pinned in memory, and remembers rooms with retired blobs', () => withBlobs(async ({ blobs, roomLog, assemble, store, clock }) => {
  await upload(blobs);
  await commitRotation(roomLog, await roomLog.blobs(DOC));
  const restarted = assemble();
  await restarted.blobs.reconcileOrphans();
  assert.deepEqual(restarted.roomLog.loadedDocNames(), []);
  assert.deepEqual(restarted.store.retiredRooms(), [DOC]);
  assert.deepEqual(store.retiredRooms(), [DOC]);
  assert.equal(clock.now, START_MS);
}));
