import { createHash, randomUUID } from 'node:crypto';
import { metaBatch, metaBatchBytes, storageOperationError } from './relay-storage.js';
import { ROOM_LOCK_META, decodeLockRecord, encodeLockRecord } from './room-lock-record.js';

export const E2E_QUOTA = 'E2E_QUOTA';
export const E2E_FROZEN = 'E2E_FROZEN';
export const E2E_BUSY = 'E2E_BUSY';
export const E2E_STALE_SNAPSHOT = 'E2E_STALE_SNAPSHOT';
export const E2E_ROTATION_STALE = 'E2E_ROTATION_STALE';
export const E2E_LOCK_MISMATCH = 'E2E_LOCK_MISMATCH';
export const E2E_CORRUPT = 'E2E_CORRUPT';
export const E2E_BLOB_DUPLICATE = 'E2E_BLOB_DUPLICATE';
export const MAX_PENDING_OPS_PER_ROOM = 256;
export const MAX_FREEZE_TTL_MS = 120_000;
export const E2E_BLOB_GRACE_MS = 86_400_000;

const HEAD_KEY = 'e2e-head';
const SNAPSHOT_KEY = 'e2e-snapshot';
const BLOBS_KEY = 'e2e-blobs';
const UPDATE_KEY_PREFIX = 'e2e-u-';
const SEQ_KEY_DIGITS = 16;
const STORE_OVERHEAD_BYTES = 64;
const DIGEST_ALGORITHM = 'sha256';
const DIGEST_ENCODING = 'hex';
const noop = () => undefined;
const clampTtl = (ttlMs) => (Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, MAX_FREEZE_TTL_MS) : MAX_FREEZE_TTL_MS);

const codedError = (code, message) => Object.assign(new Error(message), { code });
const updateKey = (seq) => UPDATE_KEY_PREFIX + seq.toString().padStart(SEQ_KEY_DIGITS, '0');
const seqOfKey = (key) => Number.parseInt(key.slice(UPDATE_KEY_PREFIX.length), 10);
const digestOf = (bytes) => createHash(DIGEST_ALGORITHM).update(bytes).digest(DIGEST_ENCODING);
const put = (key, value) => ({ type: 'put', key, value });
const del = (key) => ({ type: 'del', key });
const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
const snapshotValue = (baseSeq, bytes) => ({ baseSeq, bytes, sha256: digestOf(bytes) });

/** True when a stored snapshot value's bytes still match its recorded digest. */
export function verifySnapshotDigest(snapshot) {
  return snapshot?.bytes instanceof Uint8Array && typeof snapshot.sha256 === 'string' && digestOf(snapshot.bytes) === snapshot.sha256;
}

function newRoom() {
  return {
    pending: 0, tail: Promise.resolve(), loaded: false, head: 0, base: 0, snapshotBytes: 0,
    sizes: new Map(), blobs: [], frozen: null, listeners: new Set(),
    pendingStagedCleanup: new Set(), forgetRequested: false,
  };
}

const roomSize = (room) => room.snapshotBytes + [...room.sizes.values()].reduce((sum, n) => sum + n, 0);

/**
 * Ciphertext log of end-to-end encrypted rooms, kept in the room doc's LevelDB meta keys.
 * Every operation per docName runs through one promise chain; lock mutations share it.
 */
export class E2ERoomLog {
  #ldb;
  #maxRoomBytes;
  #reserveStore;
  #hasCapacity;
  #now;
  #setTimer;
  #clearTimer;
  #onResume;
  #deleteStagedBlobs;
  #onError;
  #rooms = new Map();

  constructor({
    ldb, maxRoomBytes, reserveStore, hasCapacity = () => true, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout,
    onResume = noop, deleteStagedBlobs = noop, onError = noop,
  }) {
    this.#ldb = ldb;
    this.#maxRoomBytes = maxRoomBytes;
    this.#reserveStore = reserveStore;
    this.#hasCapacity = hasCapacity;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#onResume = onResume;
    this.#deleteStagedBlobs = deleteStagedBlobs;
    this.#onError = onError;
  }

  /** Drops in-memory state for a retired or evicted room; storage is untouched. */
  forget(docName) {
    const room = this.#rooms.get(docName);
    if (!room) return;
    room.forgetRequested = true;
    this.#evictIfIdle(docName, room);
  }

  // Evicting a busy room would let a fresh one run beside its chain, so wait until it is idle.
  #evictIfIdle(docName, room) {
    const idle = room.pending === 0 && !room.frozen && room.listeners.size === 0 && room.pendingStagedCleanup.size === 0;
    if (room.forgetRequested && idle && this.#rooms.get(docName) === room) this.#rooms.delete(docName);
  }

  /** Settles once every operation queued so far, in every room, has finished (used by shutdown drain). */
  async whenIdle() {
    await Promise.all([...this.#rooms.values()].map((room) => room.tail));
  }

  async open(docName) {
    return this.#enqueue(docName, async (room) => (await this.#readState(docName, room)).state);
  }

  async subscribeAfterReplay(docName, onEntry) {
    return this.#enqueue(docName, async (room) => {
      const { state } = await this.#readState(docName, room);
      room.listeners.add(onEntry);
      return {
        state,
        unsubscribe: () => {
          room.listeners.delete(onEntry);
          this.#evictIfIdle(docName, room);
        },
      };
    });
  }

  async sizeOf(docName) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      return roomSize(room);
    });
  }

  async append(docName, ciphertext) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      this.#assertNotFrozen(room);
      this.#assertWithinQuota(roomSize(room) + ciphertext.byteLength);
      const seq = room.head + 1;
      await this.#write(docName, [put(updateKey(seq), ciphertext), put(HEAD_KEY, seq)]);
      room.head = seq;
      room.sizes.set(seq, ciphertext.byteLength);
      this.#notify(room, { kind: 'update', seq, bytes: ciphertext });
      return { seq };
    });
  }

  async snapshot(docName, baseSeq, ciphertext) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      this.#assertNotFrozen(room);
      if (!(baseSeq > room.base && baseSeq <= room.head)) {
        throw codedError(E2E_STALE_SNAPSHOT, 'snapshot does not advance the base');
      }
      const covered = range(room.base + 1, baseSeq);
      const keptBytes = [...room.sizes].filter(([seq]) => seq > baseSeq).reduce((sum, [, n]) => sum + n, 0);
      this.#assertWithinQuota(ciphertext.byteLength + keptBytes);
      const ops = [put(SNAPSHOT_KEY, snapshotValue(baseSeq, ciphertext)), ...covered.map((seq) => del(updateKey(seq)))];
      await this.#write(docName, ops);
      covered.forEach((seq) => room.sizes.delete(seq));
      room.base = baseSeq;
      room.snapshotBytes = ciphertext.byteLength;
      this.#notify(room, { kind: 'snapshot', baseSeq, bytes: ciphertext });
    });
  }

  async freeze(docName, ttlMs, { expectedRevision, verify }) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      if (room.frozen) throw codedError(E2E_FROZEN, 'rotation already in progress');
      const record = await this.#verifiedRecord(docName, expectedRevision, verify);
      const rotationId = randomUUID();
      const timer = this.#setTimer(() => { this.#expireFreeze(docName, rotationId); }, clampTtl(ttlMs));
      room.frozen = { rotationId, timer };
      return { head: room.head, rotationId, lockRevision: record.lockRevision };
    });
  }

  /** Ends a freeze. An owner-initiated abort passes `verify`; internal TTL expiry does not. */
  async release(docName, rotationId, { verify } = {}) {
    return this.#enqueue(docName, (room) => this.#releaseInChain(docName, room, rotationId, verify));
  }

  /** Retries cleanup of staged blobs left behind by a released rotation; true when nothing is left. */
  async retryCleanup(docName) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      return room.pendingStagedCleanup.size === 0;
    });
  }

  async #releaseInChain(docName, room, rotationId, verify) {
    await this.#load(docName, room);
    if (room.frozen?.rotationId !== rotationId) return false;
    if (verify) await this.#verifiedRecord(docName, undefined, verify);
    this.#clearTimer(room.frozen.timer);
    room.frozen = null;
    room.pendingStagedCleanup.add(rotationId);
    this.#notify(room, { kind: 'resumed' });
    this.#onResume(docName);
    await this.#cleanupStaged(docName, room);
    return true;
  }

  // Cleanup failure never keeps the room frozen: it stays queued and is retried on the next op.
  async #cleanupStaged(docName, room) {
    for (const rotationId of [...room.pendingStagedCleanup]) {
      try {
        await this.#dropStagedBlobs(docName, room, rotationId);
        room.pendingStagedCleanup.delete(rotationId);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  // Internal chain op: expiry must never be refused because the admission queue is full.
  #expireFreeze(docName, rotationId) {
    this.#enqueue(docName, (room) => this.#releaseInChain(docName, room, rotationId, undefined), { internal: true })
      .catch(this.#onError);
  }

  async mutateLock(docName, { verify, expectedRevision, next }) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      this.#assertNotFrozen(room);
      const current = await this.#verifiedRecord(docName, expectedRevision, verify);
      const updated = encodeLockRecord({ ...(await next(current)), lockRevision: current.lockRevision + 1 });
      await this.#write(docName, [put(ROOM_LOCK_META, updated)], { durable: true });
      return decodeLockRecord(updated);
    });
  }

  async commitRotation(docName, { rotationId, expectedHead, verify, snapshot, lockRecord, blobInventory }) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      if (room.frozen?.rotationId !== rotationId || room.head !== expectedHead) {
        throw codedError(E2E_ROTATION_STALE, 'rotation freeze is not current');
      }
      // The revision cannot change while frozen (mutateLock is refused), so the revision checked at
      // freeze time still holds; verify re-checks the password against the current record here.
      const current = await this.#verifiedRecord(docName, undefined, verify);
      if (lockRecord.keyEpoch !== current.keyEpoch + 1) throw codedError(E2E_ROTATION_STALE, 'key epoch must advance by one');
      this.#assertWithinQuota(snapshot.byteLength);
      const nextRecord = encodeLockRecord({ ...lockRecord, lockRevision: current.lockRevision + 1 });
      const inventory = this.#retireOldEpochs(blobInventory, nextRecord.keyEpoch);
      const ops = [
        ...[...room.sizes.keys()].map((seq) => del(updateKey(seq))),
        put(SNAPSHOT_KEY, snapshotValue(room.head, snapshot)),
        put(ROOM_LOCK_META, nextRecord),
        put(BLOBS_KEY, inventory),
      ];
      await this.#write(docName, ops, { durable: true });
      this.#clearTimer(room.frozen.timer);
      room.frozen = null;
      room.base = room.head;
      room.snapshotBytes = snapshot.byteLength;
      room.sizes.clear();
      room.blobs = inventory;
      return decodeLockRecord(nextRecord);
    });
  }

  async addBlob(docName, blob) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      if (blob.stagedFor && room.frozen?.rotationId !== blob.stagedFor) {
        throw codedError(E2E_ROTATION_STALE, 'staged blob does not match the active rotation');
      }
      if (room.blobs.some((entry) => entry.id === blob.id)) throw codedError(E2E_BLOB_DUPLICATE, 'blob id already inventoried');
      const entry = { id: blob.id, bytes: blob.bytes, epoch: blob.epoch, stagedFor: blob.stagedFor ?? null };
      const inventory = [...room.blobs, entry];
      await this.#write(docName, [put(BLOBS_KEY, inventory)]);
      room.blobs = inventory;
    });
  }

  async blobs(docName) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      return room.blobs.map((entry) => ({ ...entry }));
    });
  }

  /** Removes old-epoch entries retired at least `graceMs` ago; returns the removed ids. */
  async expireOldEpochBlobs(docName, now, graceMs = E2E_BLOB_GRACE_MS) {
    return this.#enqueue(docName, async (room) => {
      await this.#load(docName, room);
      const expired = (entry) => entry.retiredAt !== undefined && now - entry.retiredAt >= graceMs;
      const removed = room.blobs.filter(expired).map((entry) => entry.id);
      if (removed.length === 0) return removed;
      const inventory = room.blobs.filter((entry) => !expired(entry));
      await this.#write(docName, [put(BLOBS_KEY, inventory)]);
      room.blobs = inventory;
      return removed;
    });
  }

  #enqueue(docName, task, { internal = false } = {}) {
    let room = this.#rooms.get(docName);
    if (!room) {
      room = newRoom();
      this.#rooms.set(docName, room);
    }
    if (!internal && room.pending >= MAX_PENDING_OPS_PER_ROOM) {
      return Promise.reject(codedError(E2E_BUSY, 'too many queued operations for this room'));
    }
    room.pending += 1;
    const owner = room;
    const run = owner.tail.then(() => task(owner));
    owner.tail = run.then(noop, noop);
    return run.finally(() => {
      owner.pending -= 1;
      this.#evictIfIdle(docName, owner);
    });
  }

  #notify(room, entry) {
    for (const listener of [...room.listeners]) {
      try {
        listener(entry);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  #assertNotFrozen(room) {
    if (room.frozen) throw codedError(E2E_FROZEN, 'room is frozen for rotation');
  }

  #assertWithinQuota(totalBytes) {
    if (totalBytes > this.#maxRoomBytes) throw codedError(E2E_QUOTA, 'room size limit exceeded');
  }

  async #write(docName, ops, { durable = false } = {}) {
    if (!this.#hasCapacity()) throw codedError(E2E_QUOTA, 'database capacity reached');
    const release = this.#reserveStore(metaBatchBytes(docName, ops) + STORE_OVERHEAD_BYTES);
    try {
      await metaBatch(this.#ldb, docName, ops, { durable });
    } finally {
      release();
    }
  }

  async #dropStagedBlobs(docName, room, rotationId) {
    const inventory = room.blobs.filter((entry) => entry.stagedFor !== rotationId);
    if (inventory.length !== room.blobs.length) {
      await this.#write(docName, [put(BLOBS_KEY, inventory)]);
      room.blobs = inventory;
    }
    await this.#deleteStagedBlobs(docName, rotationId);
  }

  #retireOldEpochs(inventory, currentEpoch) {
    const retiredAt = this.#now();
    return inventory.map((entry) => {
      const copy = { id: entry.id, bytes: entry.bytes, epoch: entry.epoch, stagedFor: entry.stagedFor ?? null };
      if (entry.retiredAt !== undefined) copy.retiredAt = entry.retiredAt;
      else if (entry.epoch < currentEpoch) copy.retiredAt = retiredAt;
      return copy;
    });
  }

  async #verifiedRecord(docName, expectedRevision, verify) {
    const record = decodeLockRecord(await this.#ldb.getMeta(docName, ROOM_LOCK_META));
    if (!record || (expectedRevision !== undefined && record.lockRevision !== expectedRevision) || !(await verify(record))) {
      throw codedError(E2E_LOCK_MISMATCH, 'room lock changed or failed verification');
    }
    return record;
  }

  async #readMetas(docName) {
    const metas = await this.#ldb.getMetas(docName);
    if (metas === null) throw storageOperationError('e2e log read failed');
    return metas;
  }

  async #load(docName, room) {
    if (!room.loaded) await this.#readState(docName, room);
    if (room.pendingStagedCleanup.size > 0) await this.#cleanupStaged(docName, room);
  }

  /** Reads storage, refreshes the room's cached counters, and returns the verified public state. */
  async #readState(docName, room) {
    const metas = await this.#readMetas(docName);
    const stored = metas.get(SNAPSHOT_KEY);
    if (stored && !verifySnapshotDigest(stored)) throw codedError(E2E_CORRUPT, 'snapshot digest mismatch');
    const updates = [...metas.keys()].filter((key) => key.startsWith(UPDATE_KEY_PREFIX)).sort()
      .map((key) => ({ seq: seqOfKey(key), bytes: metas.get(key) }));
    const blobs = metas.get(BLOBS_KEY) ?? [];
    const head = metas.get(HEAD_KEY) ?? 0;
    if (!room.loaded) {
      room.head = head;
      room.base = stored?.baseSeq ?? 0;
      room.snapshotBytes = stored?.bytes.byteLength ?? 0;
      room.sizes = new Map(updates.map((u) => [u.seq, u.bytes.byteLength]));
      room.blobs = blobs;
      room.loaded = true;
    }
    return { state: { head, snapshot: stored ? { baseSeq: stored.baseSeq, bytes: stored.bytes } : null, updates, blobs } };
  }
}
