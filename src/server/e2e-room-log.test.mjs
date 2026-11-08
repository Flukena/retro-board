import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  E2ERoomLog, E2E_BUSY, E2E_CORRUPT, E2E_FROZEN, E2E_LOCK_MISMATCH, E2E_QUOTA, E2E_ROTATION_STALE, E2E_STALE_SNAPSHOT,
  MAX_PENDING_OPS_PER_ROOM,
} from './e2e-room-log.js';
import { ROOM_LOCK_META, decodeLockRecord, encodeLockRecord } from './room-lock-record.js';
import { lockRecord, START_MS } from './room-lock-fixtures.mjs';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');

const DOC = 'room-doc-1';
const MAX_ROOM_BYTES = 1000;
const FREEZE_TTL_MS = 120_000;
const GRACE_MS = 86_400_000;
const bytesOf = (length, fill = 1) => new Uint8Array(length).fill(fill);
const approve = () => true;
const reject = () => false;

async function withLog(run, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-room-log-'));
  const ldb = new LeveldbPersistence(dir);
  const timers = [];
  const calls = { resumed: [], staged: [], released: 0, reserved: [] };
  const deps = {
    ldb,
    maxRoomBytes: MAX_ROOM_BYTES,
    reserveStore: (bytes) => { calls.reserved.push(bytes); calls.released -= 1; return () => { calls.released += 1; }; },
    hasCapacity: () => true,
    now: () => START_MS,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    onResume: (doc) => calls.resumed.push(doc),
    deleteStagedBlobs: (doc, id) => calls.staged.push([doc, id]),
    ...overrides,
  };
  const make = () => new E2ERoomLog(deps);
  try {
    await ldb.setMeta(DOC, ROOM_LOCK_META, encodeLockRecord(lockRecord()));
    await run({ log: make(), make, ldb, timers, calls });
  } finally {
    await ldb.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}

const rejectsWith = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const e2eKeys = async (ldb) => [...(await ldb.getMetas(DOC)).keys()].filter((k) => k.startsWith('e2e-')).sort();
const storedLock = async (ldb) => decodeLockRecord(await ldb.getMeta(DOC, ROOM_LOCK_META));

test('appends get contiguous seqs and reopen keeps numeric order (9 before 10)', () => withLog(async ({ log, make }) => {
  for (let i = 1; i <= 12; i += 1) assert.deepEqual(await log.append(DOC, bytesOf(2, i)), { seq: i });
  const reopened = await make().open(DOC);
  assert.equal(reopened.head, 12);
  assert.equal(reopened.snapshot, null);
  assert.deepEqual(reopened.updates.map((u) => u.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(reopened.updates[9].bytes[0], 10);
  assert.equal(await make().sizeOf(DOC), 24);
}));

test('concurrent appends get contiguous seqs', () => withLog(async ({ log }) => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(DOC, bytesOf(1, i))));
  assert.deepEqual(results.map((r) => r.seq).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
}));

test('snapshot prunes covered updates, keeps later ones, and stale snapshots fail', () => withLog(async ({ log, make }) => {
  for (let i = 0; i < 5; i += 1) await log.append(DOC, bytesOf(10));
  await log.snapshot(DOC, 3, bytesOf(7, 9));
  const state = await make().open(DOC);
  assert.equal(state.snapshot.baseSeq, 3);
  assert.deepEqual([...state.snapshot.bytes], [...bytesOf(7, 9)]);
  assert.deepEqual(state.updates.map((u) => u.seq), [4, 5]);
  assert.equal(await log.sizeOf(DOC), 7 + 20);
  await rejectsWith(log.snapshot(DOC, 3, bytesOf(1)), E2E_STALE_SNAPSHOT);
  await rejectsWith(log.snapshot(DOC, 2, bytesOf(1)), E2E_STALE_SNAPSHOT);
  await rejectsWith(log.snapshot(DOC, 6, bytesOf(1)), E2E_STALE_SNAPSHOT);
  assert.equal((await log.append(DOC, bytesOf(1))).seq, 6);
}));

test('a quota failure leaves storage untouched and the reservation is released', () => withLog(async ({ log, ldb, calls }) => {
  await log.append(DOC, bytesOf(600));
  const before = await ldb.getMetas(DOC);
  await rejectsWith(log.append(DOC, bytesOf(401)), E2E_QUOTA);
  await rejectsWith(log.snapshot(DOC, 1, bytesOf(MAX_ROOM_BYTES + 1)), E2E_QUOTA);
  assert.deepEqual([...(await ldb.getMetas(DOC)).entries()], [...before.entries()]);
  assert.equal(calls.released, 0, 'every taken reservation was released');
  assert.equal((await log.append(DOC, bytesOf(400))).seq, 2);
}));

test('a capacity refusal from reserveStore leaves storage untouched', () => withLog(async ({ log, ldb }) => {
  const before = await e2eKeys(ldb);
  await rejectsWith(log.append(DOC, bytesOf(5)), 'DB_FULL');
  assert.deepEqual(await e2eKeys(ldb), before);
}, { reserveStore: () => { throw Object.assign(new Error('full'), { code: 'DB_FULL' }); } }));

test('a subscriber joining during appends sees every seq exactly once', () => withLog(async ({ log }) => {
  const pending = Array.from({ length: 10 }, () => log.append(DOC, bytesOf(1)));
  const live = [];
  const joined = log.subscribeAfterReplay(DOC, (entry) => live.push(entry));
  const more = Array.from({ length: 10 }, () => log.append(DOC, bytesOf(1)));
  const { state, unsubscribe } = await joined;
  await Promise.all([...pending, ...more]);
  const seen = [...state.updates.map((u) => u.seq), ...live.filter((e) => e.kind === 'update').map((e) => e.seq)];
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  unsubscribe();
  await log.append(DOC, bytesOf(1));
  assert.equal(live.length + state.updates.length, 20, 'unsubscribed listener hears nothing more');
}));

test('snapshots reach subscribers', () => withLog(async ({ log }) => {
  const live = [];
  await log.subscribeAfterReplay(DOC, (entry) => live.push(entry));
  await log.append(DOC, bytesOf(2));
  await log.snapshot(DOC, 1, bytesOf(3));
  assert.deepEqual(live.map((e) => e.kind), ['update', 'snapshot']);
  assert.equal(live[1].baseSeq, 1);
}));

test('appends during a freeze are FROZEN and the freeze expires on its TTL', () => withLog(async ({ log, timers, calls }) => {
  await log.append(DOC, bytesOf(1));
  const live = [];
  await log.subscribeAfterReplay(DOC, (entry) => live.push(entry));
  const frozen = await log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  assert.equal(frozen.head, 1);
  assert.equal(frozen.lockRevision, 0);
  assert.equal(timers[0].ms, FREEZE_TTL_MS);
  await rejectsWith(log.append(DOC, bytesOf(1)), E2E_FROZEN);
  await rejectsWith(log.snapshot(DOC, 1, bytesOf(1)), E2E_FROZEN);
  timers[0].fn();
  await log.sizeOf(DOC);
  assert.deepEqual(calls.resumed, [DOC]);
  assert.deepEqual(live.map((e) => e.kind), ['resumed']);
  assert.equal((await log.append(DOC, bytesOf(1))).seq, 2);
}));

test('freeze rejects a wrong revision, a failed verify and a second freeze', () => withLog(async ({ log }) => {
  await rejectsWith(log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 5, verify: approve }), E2E_LOCK_MISMATCH);
  await rejectsWith(log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: reject }), E2E_LOCK_MISMATCH);
  await log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  await rejectsWith(log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve }), E2E_FROZEN);
}));

test('release resumes, deletes only that rotation\'s staged blobs, and drops their entries', () => withLog(async ({ log, make, timers, calls }) => {
  await log.addBlob(DOC, { id: 'kept', bytes: 5, epoch: 0, stagedFor: null });
  const { rotationId } = await log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  await log.addBlob(DOC, { id: 'staged', bytes: 6, epoch: 1, stagedFor: rotationId });
  await log.addBlob(DOC, { id: 'other', bytes: 6, epoch: 1, stagedFor: 'someone-else' });
  assert.equal(await log.release(DOC, 'not-the-rotation'), false);
  assert.equal(await log.release(DOC, rotationId), true);
  assert.deepEqual(calls.staged, [[DOC, rotationId]]);
  assert.deepEqual(calls.resumed, [DOC]);
  assert.equal(timers[0].cleared, true);
  assert.deepEqual((await make().blobs(DOC)).map((b) => b.id).sort(), ['kept', 'other']);
  assert.equal((await log.append(DOC, bytesOf(1))).seq, 1);
}));

const newLock = () => lockRecord({ keyEpoch: 1, wrapIv: lockRecord().wrapIv });

test('commit with the wrong head, wrong rotationId, or no freeze is stale', () => withLog(async ({ log, ldb }) => {
  const args = (over) => ({ expectedHead: 1, verify: approve, snapshot: bytesOf(4), lockRecord: newLock(), blobInventory: [], ...over });
  await log.append(DOC, bytesOf(3));
  await rejectsWith(log.commitRotation(DOC, { rotationId: 'x', ...args() }), E2E_ROTATION_STALE);
  const { rotationId } = await log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  await rejectsWith(log.commitRotation(DOC, { rotationId: 'wrong', ...args() }), E2E_ROTATION_STALE);
  await rejectsWith(log.commitRotation(DOC, { rotationId, ...args({ expectedHead: 0 }) }), E2E_ROTATION_STALE);
  await rejectsWith(log.commitRotation(DOC, { rotationId, ...args({ lockRecord: lockRecord() }) }), E2E_ROTATION_STALE);
  assert.equal((await storedLock(ldb)).keyEpoch, 0);
}));

test('a failed commit batch leaves the old lock and the log intact', () => withLog(async ({ log, make, ldb }) => {
  await log.append(DOC, bytesOf(3));
  await log.append(DOC, bytesOf(3));
  const { rotationId } = await log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  const realTransact = ldb._transact;
  // Fails any batch that writes the snapshot key, so a non-atomic commit would leave the new lock behind.
  const failingDb = (db) => Object.assign(Object.create(db), {
    batch: (ops, options) => (ops.some((op) => op.key[3] === 'e2e-snapshot')
      ? Promise.reject(new Error('injected batch failure')) : db.batch(ops, options)),
  });
  ldb._transact = (f) => realTransact((db) => f(failingDb(db)));
  await rejects(log.commitRotation(DOC, { rotationId, expectedHead: 2, verify: approve, snapshot: bytesOf(4), lockRecord: newLock(), blobInventory: [] }));
  ldb._transact = realTransact;
  const lock = await storedLock(ldb);
  assert.equal(lock.keyEpoch, 0);
  assert.equal(lock.lockRevision, 0);
  const state = await make().open(DOC);
  assert.equal(state.snapshot, null);
  assert.deepEqual(state.updates.map((u) => u.seq), [1, 2]);
}));

const rejects = (promise) => assert.rejects(promise);

test('commit stores exactly one snapshot plus the new lock, bumps the revision and ends the freeze', () => withLog(async ({ log, make, ldb, timers }) => {
  for (let i = 0; i < 3; i += 1) await log.append(DOC, bytesOf(5));
  const { rotationId } = await log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  const inventory = [{ id: 'b1', bytes: 9, epoch: 1, stagedFor: null }, { id: 'b0', bytes: 8, epoch: 0, stagedFor: null }];
  await log.commitRotation(DOC, { rotationId, expectedHead: 3, verify: approve, snapshot: bytesOf(6, 2), lockRecord: newLock(), blobInventory: inventory });
  assert.deepEqual(await e2eKeys(ldb), ['e2e-blobs', 'e2e-head', 'e2e-snapshot']);
  const lock = await storedLock(ldb);
  assert.equal(lock.keyEpoch, 1);
  assert.equal(lock.lockRevision, 1);
  const state = await make().open(DOC);
  assert.equal(state.snapshot.baseSeq, 3);
  assert.deepEqual(state.updates, []);
  assert.equal(state.head, 3);
  assert.equal(await log.sizeOf(DOC), 6);
  assert.equal(timers[0].cleared, true);
  assert.equal((await log.append(DOC, bytesOf(1))).seq, 4);
  const blobs = await log.blobs(DOC);
  assert.equal(blobs.find((b) => b.id === 'b1').retiredAt, undefined);
  assert.equal(blobs.find((b) => b.id === 'b0').retiredAt, START_MS);
}));

test('a password change queued behind a commit fails re-verification and leaves the new lock', () => withLog(async ({ log, ldb }) => {
  const { rotationId } = await log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  const commit = log.commitRotation(DOC, { rotationId, expectedHead: 0, verify: approve, snapshot: bytesOf(2), lockRecord: newLock(), blobInventory: [] });
  const change = log.mutateLock(DOC, { expectedRevision: 0, verify: approve, next: (r) => ({ ...r, salt: lockRecord({ salt: 'x'.repeat(22) }).salt }) });
  await commit;
  await rejectsWith(change, E2E_LOCK_MISMATCH);
  assert.equal((await storedLock(ldb)).keyEpoch, 1);
}));

test('mutateLock writes next(record) with revision + 1, and refuses stale, unverified or frozen calls', () => withLog(async ({ log, ldb }) => {
  const next = (r) => ({ ...r, wrappedDek: lockRecord({ wrappedDek: 'Z'.repeat(r.wrappedDek.length) }).wrappedDek });
  const updated = await log.mutateLock(DOC, { expectedRevision: 0, verify: approve, next });
  assert.equal(updated.lockRevision, 1);
  assert.equal((await storedLock(ldb)).wrappedDek, updated.wrappedDek);
  await rejectsWith(log.mutateLock(DOC, { expectedRevision: 0, verify: approve, next }), E2E_LOCK_MISMATCH);
  await rejectsWith(log.mutateLock(DOC, { expectedRevision: 1, verify: reject, next }), E2E_LOCK_MISMATCH);
  assert.equal((await storedLock(ldb)).lockRevision, 1);
  await log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 1, verify: approve });
  await rejectsWith(log.mutateLock(DOC, { expectedRevision: 1, verify: approve, next }), E2E_FROZEN);
}));

test('the 257th queued op is BUSY', () => withLog(async ({ log }) => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const blocker = log.mutateLock(DOC, { expectedRevision: 0, verify: () => gate, next: (r) => r });
  const queued = Array.from({ length: MAX_PENDING_OPS_PER_ROOM - 1 }, () => log.append(DOC, bytesOf(1)));
  await rejectsWith(log.append(DOC, bytesOf(1)), E2E_BUSY);
  open(true);
  await blocker;
  assert.equal((await Promise.all(queued)).length, MAX_PENDING_OPS_PER_ROOM - 1);
  assert.equal((await log.append(DOC, bytesOf(1))).seq, MAX_PENDING_OPS_PER_ROOM);
}, { maxRoomBytes: 1_000_000 }));

test('a truncated snapshot fails open', () => withLog(async ({ log, ldb, make }) => {
  await log.append(DOC, bytesOf(3));
  await log.snapshot(DOC, 1, bytesOf(8, 4));
  const stored = await ldb.getMeta(DOC, 'e2e-snapshot');
  await ldb.setMeta(DOC, 'e2e-snapshot', { ...stored, bytes: stored.bytes.slice(0, 5) });
  await rejectsWith(make().open(DOC), E2E_CORRUPT);
}));

test('expireOldEpochBlobs removes only retired entries past the grace and returns their ids', () => withLog(async ({ log, make }) => {
  const { rotationId } = await log.freeze(DOC, FREEZE_TTL_MS, { expectedRevision: 0, verify: approve });
  await log.commitRotation(DOC, {
    rotationId, expectedHead: 0, verify: approve, snapshot: bytesOf(1), lockRecord: newLock(),
    blobInventory: [{ id: 'old', bytes: 1, epoch: 0, stagedFor: null }, { id: 'new', bytes: 1, epoch: 1, stagedFor: null }],
  });
  assert.deepEqual(await log.expireOldEpochBlobs(DOC, START_MS + GRACE_MS - 1, GRACE_MS), []);
  assert.deepEqual(await log.expireOldEpochBlobs(DOC, START_MS + GRACE_MS, GRACE_MS), ['old']);
  assert.deepEqual((await make().blobs(DOC)).map((b) => b.id), ['new']);
}));

test('clearDocument removes every e2e key', () => withLog(async ({ log, ldb }) => {
  await log.append(DOC, bytesOf(2));
  await log.append(DOC, bytesOf(2));
  await log.snapshot(DOC, 1, bytesOf(2));
  await log.addBlob(DOC, { id: 'b', bytes: 1, epoch: 0, stagedFor: null });
  assert.deepEqual(await e2eKeys(ldb), ['e2e-blobs', 'e2e-head', 'e2e-snapshot', 'e2e-u-0000000000000002']);
  await ldb.clearDocument(DOC);
  assert.deepEqual([...(await ldb.getMetas(DOC)).keys()], []);
}));

test('forget drops in-memory state and the room reloads from storage', () => withLog(async ({ log }) => {
  await log.append(DOC, bytesOf(2));
  log.forget(DOC);
  assert.equal((await log.append(DOC, bytesOf(2))).seq, 2);
}));
