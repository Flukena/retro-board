import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ROOM_HANDLE_RE, ROOM_ID_ALLOCATION_ATTEMPTS, STORE_OPERATION_OVERHEAD_BYTES } from './relay-config.js';
import { roomLogId } from './relay-log-id.js';

export const ROOM_REGISTRATION_META = 'retro-room-registration-v1';
export const ROOM_HANDLE_META = 'retro-room-handle-v1';
export const ROOM_UPLOAD_USAGE_META = 'retro-room-upload-usage-v1';
export const REGISTRY_STORAGE_FAILURE_EVENT = 'storageFailure';
export const TOKENIZED_ROOM_RE = /^board-[A-Za-z0-9_-]{3,32}-[A-Za-z0-9_-]{8,64}$/;
const BOARD_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const ROOM_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DOCUMENT_PREFIX = 'yjs/';
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
const ROOM_CAPACITY_CODE = 'ROOM_CAPACITY';
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
const ROLLBACK_FAILED_LOG = '[yjs] incomplete room rollback failed';

export const canonicalDocName = (code, token) => `${DOCUMENT_PREFIX}board-${code}-${token}`;
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
  pendingRoomHandles = new Set();
  existingDocNames = new Set();
  pendingRoomCreations = 0;
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
      return;
    }
    if (this.registeredDocs.size >= this.#maxRooms) {
      throw new Error(EXISTING_ROOM_LIMIT_MESSAGE);
    }
    let handle = await this.#persistence.getMeta(docName, ROOM_HANDLE_META);
    if (!ROOM_HANDLE_RE.test(handle || '')) {
      handle = this.newUniqueRoomHandle();
      await this.#persistence.setMeta(docName, ROOM_HANDLE_META, handle);
    }
    this.registerDocInMemory(docName, handle);
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

  async persistRoom(docName, handle, update) {
    await this.#persistence.storeUpdate(docName, update);
    await this.#persistence.setMeta(docName, ROOM_HANDLE_META, handle);
    await this.#persistence.setMeta(docName, ROOM_UPLOAD_USAGE_META, emptyUsage());
    await this.#persistence.flushDocument(docName);
    if (this.#persistence.measureDatabase() > this.#maxDatabaseBytes) {
      const error = databaseCapacityError();
      this.reportStorageFailure(error);
      throw error;
    }
    // Marker LAST, then in-memory publication; never adopt a failed creation.
    await this.#persistence.setMeta(docName, ROOM_REGISTRATION_META, REGISTRATION_VERSION);
  }

  publishRoom(docName, handle) {
    this.existingDocNames.add(docName);
    this.registerDocInMemory(docName, handle);
    this.roomUploadUsage.set(docName, activeUsage(emptyUsage()));
  }

  async rollback(docName) {
    if (!docName || this.registeredDocs.has(docName)) return;
    try {
      await this.#persistence.clearDocument(docName);
      this.existingDocNames.delete(docName);
      this.#persistence.measureDatabase();
    } catch (error) {
      this.reportStorageFailure(error);
      this.#log.error(ROLLBACK_FAILED_LOG, { docName: roomLogId(docName), err: error.message });
    }
  }

  async createRoom({ unavailable = false, initialUpdate = null } = {}) {
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
      await this.persistRoom(identity.docName, handle, update);
      this.publishRoom(identity.docName, handle);
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
