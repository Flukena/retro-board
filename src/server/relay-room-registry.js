import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ROOM_HANDLE_RE, ROOM_ID_ALLOCATION_ATTEMPTS, STORE_OPERATION_OVERHEAD_BYTES } from './relay-config.js';
import { roomLogId } from './relay-log-id.js';
import { RoomActivity } from './room-activity.js';
import { CORRUPT_LOCK, ROOM_LOCK_META, decodeLockRecord, encodeLockRecord } from './room-lock-record.js';

export const ROOM_REGISTRATION_META = 'retro-room-registration-v1';
export const ROOM_HANDLE_META = 'retro-room-handle-v1';
export const ROOM_UPLOAD_USAGE_META = 'retro-room-upload-usage-v1';
export const REGISTRY_STORAGE_FAILURE_EVENT = 'storageFailure';
const ROOM_NAME_CHARS = '[A-Za-z0-9_-]';
const MIN_BOARD_CODE_CHARS = 3;
const MAX_BOARD_CODE_CHARS = 32;
const MIN_ROOM_TOKEN_CHARS = 8;
const MAX_ROOM_TOKEN_CHARS = 64;
const BOARD_CODE_PATTERN = `${ROOM_NAME_CHARS}{${MIN_BOARD_CODE_CHARS},${MAX_BOARD_CODE_CHARS}}`;
const ROOM_TOKEN_PATTERN = `${ROOM_NAME_CHARS}{${MIN_ROOM_TOKEN_CHARS},${MAX_ROOM_TOKEN_CHARS}}`;
export const TOKENIZED_ROOM_RE = new RegExp(`^board-${BOARD_CODE_PATTERN}-${ROOM_TOKEN_PATTERN}$`);
const BOARD_CODE_RE = new RegExp(`^${BOARD_CODE_PATTERN}$`);
const ROOM_TOKEN_RE = new RegExp(`^${ROOM_TOKEN_PATTERN}$`);
const DOCUMENT_PREFIX = 'yjs/';
const LONGEST_NAME_FILL = 'x';
const BOARD_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const BOARD_CODE_RANDOM_BYTES = 8;
const ROOM_CREDENTIAL_RANDOM_BYTES = 24;
const REGISTRATION_DIGEST_BYTES = 32;
const RANDOM_ENCODING = 'base64url';
const REGISTRATION_DIGEST_ALGORITHM = 'sha256';
const REGISTRATION_DIGEST_DOMAIN = 'room-registration\0';
const SEED_META_MAP = 'meta';
const SEED_REGISTRATION_KEY = '__roomRegistered';
const REGISTRATION_VERSION = 1;
export const ROOM_CAPACITY_CODE = 'ROOM_CAPACITY';
const SERVER_UNAVAILABLE_CODE = 'SERVER_UNAVAILABLE';
const DATABASE_CAPACITY_MESSAGE = 'database capacity reached';
const HANDLE_GENERATION_MESSAGE = 'room handle generation failed';
const INVALID_HANDLE_MESSAGE = 'invalid persisted room handle';
const HANDLE_COLLISION_MESSAGE = 'room handle collision';
const EXISTING_ROOM_LIMIT_MESSAGE = 'existing room count exceeds YJS_MAX_REGISTERED_ROOMS';
const ROOM_ID_GENERATION_MESSAGE = 'room id generation failed';
const SERVICE_UNAVAILABLE_MESSAGE = 'service unavailable';
const ROOM_CAPACITY_MESSAGE = 'room capacity reached';
const QUARANTINE_LOG = '[yjs] quarantined incomplete room';
const USAGE_RECONCILED_LOG = '[yjs] reconciled room upload usage';
const INVALID_LOCK_LOG = '[yjs] room has an unreadable lock record';
const INVALID_LOCK_ARGUMENT_MESSAGE = 'invalid room lock record';
const LOCK_STORAGE_UNSUPPORTED_MESSAGE = 'persistence has no durableMetaBatch for locked rooms';
const PUT_OPERATION = 'put';
const DELETE_OPERATION = 'del';
const ROLLBACK_FAILED_LOG = '[yjs] incomplete room rollback failed';

export const canonicalDocName = (code, token) => `${DOCUMENT_PREFIX}board-${code}-${token}`;
/** The longest docName a room can have; storage-size bounds are computed against it. */
export const LONGEST_CANONICAL_DOC_NAME = canonicalDocName(
  LONGEST_NAME_FILL.repeat(MAX_BOARD_CODE_CHARS),
  LONGEST_NAME_FILL.repeat(MAX_ROOM_TOKEN_CHARS),
);
export const databaseCapacityError = () => Object.assign(new Error(DATABASE_CAPACITY_MESSAGE), { code: ROOM_CAPACITY_CODE });
export const fixedDigestEqual = (left, right) => (
  Buffer.isBuffer(left)
  && Buffer.isBuffer(right)
  && left.byteLength === right.byteLength
  && timingSafeEqual(left, right)
);

const randomBoardCode = () => {
  const bytes = randomBytes(BOARD_CODE_RANDOM_BYTES);
  let code = '';
  for (const byte of bytes) code += BOARD_CODE_ALPHABET[byte % BOARD_CODE_ALPHABET.length];
  return code;
};
const randomRoomCredential = () => randomBytes(ROOM_CREDENTIAL_RANDOM_BYTES).toString(RANDOM_ENCODING);
const emptyUsage = () => ({ bytes: 0, files: 0 });
const activeUsage = ({ bytes, files }) => ({ bytes, files, reservedBytes: 0, active: 0 });
const persistedUsage = (usage) => ({
  bytes: Number.isSafeInteger(usage?.bytes) && usage.bytes >= 0 ? usage.bytes : 0,
  files: Number.isSafeInteger(usage?.files) && usage.files >= 0 ? usage.files : 0,
});

/**
 * Registry-owned persistence port. Checked operations reject on storage failure.
 * reserveStore is synchronous and returns a release function; capacity rejection
 * never emits a storage failure. measureDatabase refreshes the shared disk budget.
 * @typedef {object} RoomRegistryPersistence
 * @property {function(): Promise<string[]>} getAllDocNames
 * @property {function(string, string): Promise<*>} getMeta
 * @property {function(string, string, *): Promise<void>} setMeta
 * @property {function(string, Uint8Array): Promise<*>} storeUpdate
 * @property {function(string): Promise<void>} flushDocument
 * @property {function(string): Promise<void>} clearDocument
 * @property {function(string, {type: string, key: string, value?: *}[]): Promise<void>} [durableMetaBatch]
 *   fsynced atomic meta batch; required only to create locked rooms
 * @property {function(): boolean} hasCapacity
 * @property {function(number): function(): void} reserveStore
 * @property {function(): number} measureDatabase
 */
export class RoomRegistry extends EventEmitter {
  registeredDocs = new Set();
  registeredDocDigests = new Map();
  registeredRoomsByHandle = new Map();
  registeredRoomHandlesByDoc = new Map();
  roomUploadUsage = new Map();
  locksByDoc = new Map();
  pendingRoomHandles = new Set();
  existingDocNames = new Set();
  pendingRoomCreations = 0;
  activity;
  #failure = null;
  #persistence;
  #Y;
  #maxRooms;
  #maxDatabaseBytes;
  #signingKey;
  #dummyDigest = randomBytes(REGISTRATION_DIGEST_BYTES);
  #log;

  constructor({ persistence, Y, maxRooms, maxDatabaseBytes, signingKey, log = console }) {
    super();
    this.#persistence = persistence;
    this.activity = new RoomActivity(persistence);
    this.#Y = Y;
    this.#maxRooms = maxRooms;
    this.#maxDatabaseBytes = maxDatabaseBytes;
    this.#signingKey = signingKey;
    this.#log = log;
  }

  digest(docName) {
    return createHmac(REGISTRATION_DIGEST_ALGORITHM, this.#signingKey)
      .update(REGISTRATION_DIGEST_DOMAIN).update(docName).digest();
  }

  newUniqueRoomHandle() {
    for (let attempt = 0; attempt < ROOM_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
      const handle = randomRoomCredential();
      if (!this.registeredRoomsByHandle.has(handle) && !this.pendingRoomHandles.has(handle)) return handle;
    }
    throw Object.assign(new Error(HANDLE_GENERATION_MESSAGE), { code: SERVER_UNAVAILABLE_CODE });
  }

  roomHandleForDoc(docName) { return this.registeredRoomHandlesByDoc.get(docName) || null; }

  registerDocInMemory(docName, handle) {
    if (!ROOM_HANDLE_RE.test(handle)) throw new Error(INVALID_HANDLE_MESSAGE);
    const prior = this.registeredRoomsByHandle.get(handle);
    if (prior && prior !== docName) throw new Error(HANDLE_COLLISION_MESSAGE);
    this.registeredDocs.add(docName);
    this.registeredDocDigests.set(docName, this.digest(docName));
    this.registeredRoomsByHandle.set(handle, docName);
    this.registeredRoomHandlesByDoc.set(docName, handle);
    return handle;
  }

  async hydrate(initialUploadUsage) {
    this.existingDocNames = new Set(await this.#persistence.getAllDocNames());
    const tokenized = [...this.existingDocNames].filter((name) => (
      name.startsWith(DOCUMENT_PREFIX) && TOKENIZED_ROOM_RE.test(name.slice(DOCUMENT_PREFIX.length))
    ));
    for (const name of tokenized) await this.hydrateRoom(name, initialUploadUsage);
    this.#persistence.measureDatabase();
  }

  async hydrateRoom(docName, initialUploadUsage) {
    // Only the final commit marker makes a partially created document reachable.
    if ((await this.#persistence.getMeta(docName, ROOM_REGISTRATION_META)) !== REGISTRATION_VERSION) {
      this.#log.warn(QUARANTINE_LOG, { docName: roomLogId(docName) });
      await this.#dropOrphanLock(docName);
      return;
    }
    if (this.registeredDocs.size >= this.#maxRooms) {
      throw new Error(EXISTING_ROOM_LIMIT_MESSAGE);
    }
    const lock = await this.#readLock(docName);
    let handle = await this.#persistence.getMeta(docName, ROOM_HANDLE_META);
    if (!ROOM_HANDLE_RE.test(handle || '')) {
      handle = this.newUniqueRoomHandle();
      await this.#persistence.setMeta(docName, ROOM_HANDLE_META, handle);
    }
    await this.activity.hydrate(docName);
    this.registerDocInMemory(docName, handle);
    if (lock) this.locksByDoc.set(docName, lock);
    const stored = persistedUsage(await this.#persistence.getMeta(docName, ROOM_UPLOAD_USAGE_META));
    const actual = initialUploadUsage.roomsByHandle.get(handle) || emptyUsage();
    const { bytes, files } = initialUploadUsage.complete ? actual : stored;
    const usage = { bytes, files };
    if (initialUploadUsage.complete && (usage.bytes !== stored.bytes || usage.files !== stored.files)) {
      await this.#persistence.setMeta(docName, ROOM_UPLOAD_USAGE_META, usage);
      this.#log.warn(USAGE_RECONCILED_LOG, { docName: roomLogId(docName), ...usage });
    }
    this.roomUploadUsage.set(docName, activeUsage(usage));
  }

  // An interrupted locked creation: the lock landed but the marker did not.
  async #dropOrphanLock(docName) {
    const raw = await this.#persistence.getMeta(docName, ROOM_LOCK_META);
    if (raw === undefined || raw === null || typeof this.#persistence.durableMetaBatch !== 'function') return;
    await this.#persistence.durableMetaBatch(docName, [{ type: DELETE_OPERATION, key: ROOM_LOCK_META }]);
  }

  // null = unlocked room, CORRUPT_LOCK = committed record that cannot be read (managed but never served).
  async #readLock(docName) {
    const raw = await this.#persistence.getMeta(docName, ROOM_LOCK_META);
    if (raw === undefined || raw === null) return null;
    const lock = decodeLockRecord(raw);
    if (!lock) {
      this.#log.warn(INVALID_LOCK_LOG, { docName: roomLogId(docName) });
      return CORRUPT_LOCK;
    }
    return lock;
  }

  lockFor(docName) { return this.locksByDoc.get(docName) ?? null; }

  isLocked(docName) { return this.locksByDoc.has(docName); }

  // Memory only: the caller has already written the record in its own durable batch.
  publishLock(docName, record) {
    const lock = decodeLockRecord(record);
    if (!lock) throw new TypeError(INVALID_LOCK_ARGUMENT_MESSAGE);
    this.locksByDoc.set(docName, lock);
  }

  registeredDocForCapability(code, token) {
    if (!BOARD_CODE_RE.test(code) || !ROOM_TOKEN_RE.test(token)) return null;
    const docName = canonicalDocName(code, token);
    const expected = this.registeredDocDigests.get(docName) || this.#dummyDigest;
    return fixedDigestEqual(this.digest(docName), expected) && this.registeredDocs.has(docName) ? docName : null;
  }

  allocateRoomIdentity() {
    for (let attempt = 0; attempt < ROOM_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
      const code = randomBoardCode();
      const token = randomRoomCredential();
      const docName = canonicalDocName(code, token);
      if (!this.existingDocNames.has(docName) && !this.registeredDocs.has(docName)) return { code, token, docName };
    }
    throw new Error(ROOM_ID_GENERATION_MESSAGE);
  }

  seedUpdate() {
    const seed = new this.#Y.Doc();
    seed.getMap(SEED_META_MAP).set(SEED_REGISTRATION_KEY, REGISTRATION_VERSION);
    const update = this.#Y.encodeStateAsUpdate(seed);
    seed.destroy();
    return update;
  }

  reportStorageFailure(error) {
    if (this.#failure) return;
    this.#failure = error;
    this.emit(REGISTRY_STORAGE_FAILURE_EVENT, error);
  }

  async persistRoom(docName, handle, update, lock = null) {
    await this.#persistence.storeUpdate(docName, update);
    await this.#persistence.setMeta(docName, ROOM_HANDLE_META, handle);
    await this.#persistence.setMeta(docName, ROOM_UPLOAD_USAGE_META, emptyUsage());
    await this.activity.create(docName);
    await this.#persistence.flushDocument(docName);
    if (this.#persistence.measureDatabase() > this.#maxDatabaseBytes) {
      const error = databaseCapacityError();
      this.reportStorageFailure(error);
      throw error;
    }
    // The lock lands durably BEFORE the marker: a reachable room is never unlocked.
    if (lock) {
      await this.#persistence.durableMetaBatch(docName, [{ type: PUT_OPERATION, key: ROOM_LOCK_META, value: encodeLockRecord(lock) }]);
    }
    // Marker LAST, then in-memory publication; never adopt a failed creation.
    await this.#persistence.setMeta(docName, ROOM_REGISTRATION_META, REGISTRATION_VERSION);
  }

  publishRoom(docName, handle, lock = null) {
    this.existingDocNames.add(docName);
    if (lock) this.locksByDoc.set(docName, lock);
    this.registerDocInMemory(docName, handle);
    this.roomUploadUsage.set(docName, activeUsage(emptyUsage()));
  }

  async rollback(docName) {
    if (!docName || this.registeredDocs.has(docName)) return;
    try {
      await this.#persistence.clearDocument(docName);
      this.existingDocNames.delete(docName);
      this.activity.forget(docName);
      this.#persistence.measureDatabase();
    } catch (error) {
      this.reportStorageFailure(error);
      this.#log.error(ROLLBACK_FAILED_LOG, { docName: roomLogId(docName), err: error.message });
    }
  }

  // Unpublish synchronously, before the first await, so no session, upgrade or
  // upload can reach the room while its storage is cleared. Callers check that
  // the room is not loaded or connected in the same tick. Returns the handle.
  async retireRoom(docName) {
    const handle = this.registeredRoomHandlesByDoc.get(docName);
    if (!handle) return null;
    this.registeredDocs.delete(docName);
    this.registeredDocDigests.delete(docName);
    this.registeredRoomsByHandle.delete(handle);
    this.registeredRoomHandlesByDoc.delete(docName);
    this.roomUploadUsage.delete(docName);
    this.locksByDoc.delete(docName);
    this.existingDocNames.delete(docName);
    this.activity.forget(docName);
    try {
      // A flush already in flight must land before the clear, not after it.
      await this.activity.flush();
      await this.#persistence.clearDocument(docName);
    } catch (error) {
      this.reportStorageFailure(error);
      throw error;
    }
    return handle;
  }

  async createRoom({ unavailable = false, initialUpdate = null, lock = null } = {}) {
    const record = lock === null ? null : decodeLockRecord(lock);
    if (lock !== null && !record) throw new TypeError(INVALID_LOCK_ARGUMENT_MESSAGE);
    if (record && typeof this.#persistence.durableMetaBatch !== 'function') throw new TypeError(LOCK_STORAGE_UNSUPPORTED_MESSAGE);
    if (unavailable) throw Object.assign(new Error(SERVICE_UNAVAILABLE_MESSAGE), { code: SERVER_UNAVAILABLE_CODE });
    if (this.registeredDocs.size + this.pendingRoomCreations >= this.#maxRooms) {
      throw Object.assign(new Error(ROOM_CAPACITY_MESSAGE), { code: ROOM_CAPACITY_CODE });
    }
    if (!this.#persistence.hasCapacity()) throw databaseCapacityError();
    this.pendingRoomCreations += 1;
    let identity;
    let handle;
    let releaseStore;
    try {
      identity = this.allocateRoomIdentity();
      handle = this.newUniqueRoomHandle();
      this.pendingRoomHandles.add(handle);
      const update = initialUpdate ?? this.seedUpdate();
      releaseStore = this.#persistence.reserveStore(update.byteLength + STORE_OPERATION_OVERHEAD_BYTES);
      await this.persistRoom(identity.docName, handle, update, record);
      this.publishRoom(identity.docName, handle, record);
      return { code: identity.code, token: identity.token };
    } catch (error) {
      await this.rollback(identity?.docName);
      throw error;
    } finally {
      this.pendingRoomCreations = Math.max(0, this.pendingRoomCreations - 1);
      if (handle) this.pendingRoomHandles.delete(handle);
      if (releaseStore) releaseStore();
    }
  }
}
