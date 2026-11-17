import { join } from 'node:path';
import { ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON } from '../domain/room-ownership.js';
import { ROOM_HANDLE_RE } from './relay-config.js';
import { roomLogId } from './relay-log-id.js';
import { STORAGE_FAILURE_CODE, metaBatch, storageOperationError } from './relay-storage.js';
import { roomHandleOfImageFile } from './relay-uploads.js';

/** Relay document holding the deletion journal. It lives outside every room, so clearing a room never clears it. */
export const DELETION_JOURNAL_DOC = 'retro-relay-deletions';
export const DELETION_KEY_PREFIX = 'deletion:';
/** How long a deletion waits for in-flight work (uploads, log ops, upgrades) before answering 503. */
export const DELETE_DRAIN_TIMEOUT_MS = 10_000;
export const DELETE_STATUS = Object.freeze({ NOT_FOUND: 404, UNAVAILABLE: 503 });
const JOURNAL_VERSION = 1;
const JOURNAL_KEYS = ['v', 'handle', 'startedAt'];
const PUT_OPERATION = 'put';
const DELETE_OPERATION = 'del';
const JOURNAL_READ_FAILURE = 'deletion journal read failed';
const UNREADABLE_ENTRY_LOG = '[yjs] unreadable deletion journal entry';
const RECOVERY_FAILED_LOG = '[yjs] room deletion recovery failed';
const NOT_FOUND = Object.freeze({ deleted: false, status: DELETE_STATUS.NOT_FOUND });
const DRAIN_TIMED_OUT = Object.freeze({ deleted: false, status: DELETE_STATUS.UNAVAILABLE });

const journalKey = (docName) => `${DELETION_KEY_PREFIX}${docName}`;

/** Exact-shape decode of a journal value; null for anything else. */
export function decodeDeletionEntry(value) {
  const exact = value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === JOURNAL_KEYS.length && JOURNAL_KEYS.every((key) => Object.hasOwn(value, key));
  if (!exact || value.v !== JOURNAL_VERSION || !ROOM_HANDLE_RE.test(value.handle ?? '')) return null;
  return Number.isSafeInteger(value.startedAt) && value.startedAt > 0 ? value : null;
}

/** Durable record of deletions in progress: `deletion:<docName>` = `{ v: 1, handle, startedAt }`. */
export class DeletionJournal {
  #ldb;
  #log;

  constructor(ldb, log = console) {
    this.#ldb = ldb;
    this.#log = log;
  }

  async put(docName, entry) {
    await metaBatch(this.#ldb, DELETION_JOURNAL_DOC, [{ type: PUT_OPERATION, key: journalKey(docName), value: entry }], { durable: true });
  }

  async remove(docName) {
    await metaBatch(this.#ldb, DELETION_JOURNAL_DOC, [{ type: DELETE_OPERATION, key: journalKey(docName) }], { durable: true });
  }

  /** docName → entry. An unreadable entry keeps its room out of service with no handle, so only its rows are cleared. */
  async load() {
    const metas = await this.#ldb.getMetas(DELETION_JOURNAL_DOC);
    if (metas === null) throw storageOperationError(JOURNAL_READ_FAILURE);
    const entries = new Map();
    for (const [key, value] of metas) {
      if (!key.startsWith(DELETION_KEY_PREFIX)) continue;
      const docName = key.slice(DELETION_KEY_PREFIX.length);
      const entry = decodeDeletionEntry(value);
      if (!entry) this.#log.warn(UNREADABLE_ENTRY_LOG, { docName: roomLogId(docName) });
      entries.set(docName, entry ?? { handle: null });
    }
    return entries;
  }
}

/**
 * Removes every image and `.e2e` blob file of a room by its handle (one directory scan), then reconciles upload usage.
 * Returns the number of files removed. Ports: io (fs.promises), reconcileUploadUsage().
 */
export function createRoomFileRemover({ io, uploadsDir, reconcileUploadUsage }) {
  return async (handle) => {
    let removed = 0;
    for (const entry of await io.readdir(uploadsDir, { withFileTypes: true })) {
      if (!entry.isFile() || roomHandleOfImageFile(entry.name) !== handle) continue;
      await io.unlink(join(uploadsDir, entry.name));
      removed += 1;
    }
    if (removed > 0) await reconcileUploadUsage();
    return removed;
  };
}

/**
 * The one crash-safe way a room is deleted, shared by owner deletion, guest expiry and idle retirement.
 * Ports: fence (RoomFence), journal (DeletionJournal), registry (unregisterDurably, unpublish, clearRoomStorage,
 * roomHandleForDoc), plainRooms.retire(docName, code, reason) and e2eRooms.retireRoom(docName, code, reason) (each
 * closes its sockets in the same tick, then settles once its in-flight work has landed), files(handle) → count,
 * onStorageFailure(error). `pending`: the journal as loaded at startup, before the registry hydrated.
 */
export class RoomDeletion {
  #fence;
  #journal;
  #registry;
  #plainRooms;
  #e2eRooms;
  #files;
  #onStorageFailure;
  #log;
  #now;
  #drainTimeoutMs;
  #pending = new Map();
  #running = new Map();
  #recovering = null;

  constructor({
    fence, journal, registry, plainRooms, e2eRooms, files, onStorageFailure, pending = new Map(), log = console,
    now = Date.now, drainTimeoutMs = DELETE_DRAIN_TIMEOUT_MS,
  }) {
    this.#fence = fence;
    this.#journal = journal;
    this.#registry = registry;
    this.#plainRooms = plainRooms;
    this.#e2eRooms = e2eRooms;
    this.#files = files;
    this.#onStorageFailure = onStorageFailure;
    this.#log = log;
    this.#now = now;
    this.#drainTimeoutMs = drainTimeoutMs ?? DELETE_DRAIN_TIMEOUT_MS;
    for (const [docName, { handle }] of pending) {
      this.#fence.fence(docName);
      this.#pending.set(docName, handle);
    }
  }

  /**
   * `{ deleted: true, files }`, `{ deleted: false, status: 404 }` for a room that is not registered, or
   * `{ deleted: false, status: 503 }` when in-flight work outlived the drain timeout (recovery finishes it later).
   * Rejects on a storage or file failure; the journal entry then stays for recovery.
   */
  deleteRoom(docName) {
    const running = this.#running.get(docName);
    if (running) return running;
    if (this.#pending.has(docName)) return this.#track(docName, () => this.#finish(docName));
    const handle = this.#registry.roomHandleForDoc(docName);
    if (!handle || this.#fence.isFenced(docName)) return Promise.resolve(NOT_FOUND);
    // Fenced before the first await: no new session, upgrade, upload or log op can enter the room from here on.
    this.#fence.fence(docName);
    return this.#track(docName, () => this.#start(docName, handle));
  }

  /** Finishes every journaled deletion (at startup and on each tick). Single-flight; one failure never stops the rest. */
  recover() {
    this.#recovering ??= this.#recoverAll().finally(() => { this.#recovering = null; });
    return this.#recovering;
  }

  async #recoverAll() {
    let recovered = 0;
    let files = 0;
    for (const docName of [...this.#pending.keys()]) {
      try {
        const result = await this.deleteRoom(docName);
        if (!result.deleted) continue;
        recovered += 1;
        files += result.files;
      } catch (error) {
        this.#log.error(RECOVERY_FAILED_LOG, { docName: roomLogId(docName), err: error.message });
      }
    }
    return { recovered, files };
  }

  #track(docName, run) {
    const running = run().catch((error) => {
      if (error.code === STORAGE_FAILURE_CODE) this.#onStorageFailure(error);
      throw error;
    }).finally(() => { this.#running.delete(docName); });
    this.#running.set(docName, running);
    return running;
  }

  async #start(docName, handle) {
    await this.#journal.put(docName, { v: JOURNAL_VERSION, handle, startedAt: this.#now() });
    this.#pending.set(docName, handle);
    await this.#registry.unregisterDurably(docName);
    return this.#finish(docName);
  }

  // Steps 4–11; recovery re-runs exactly these, so each one is safe to repeat.
  async #finish(docName) {
    const handle = this.#pending.get(docName);
    this.#registry.unpublish(docName);
    const plain = this.#plainRooms.retire(docName, ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON);
    const e2e = this.#e2eRooms.retireRoom(docName, ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON);
    await Promise.all([plain, e2e]);
    if (!(await this.#fence.drained(docName, this.#drainTimeoutMs))) return DRAIN_TIMED_OUT;
    await this.#registry.clearRoomStorage(docName);
    const files = handle ? await this.#files(handle) : 0;
    await this.#journal.remove(docName);
    this.#pending.delete(docName);
    this.#fence.lift(docName);
    return { deleted: true, files };
  }
}
