import { LOCK_BYTES, decodeBase64Url, encodeBase64Url, hasExactKeys, isPlainObject } from '../../domain/room-lock-contract.js';
import { isRoomMasterKey } from './e2e-crypto.js';

const DB_NAME = 'retroroom-device-unlock';
const DB_VERSION = 1;
const STORE_NAME = 'rooms';
const ID_DOMAIN = 'retroroom/device-unlock/v1';
const ID_HASH = 'SHA-256';
const READ_ONLY = 'readonly';
const READ_WRITE = 'readwrite';
const RECORD_FIELDS = ['salt', 'masterKey'];
const textEncoder = new TextEncoder();

async function recordId(code, token) {
  const bytes = textEncoder.encode(JSON.stringify([ID_DOMAIN, code, token]));
  return encodeBase64Url(new Uint8Array(await globalThis.crypto.subtle.digest(ID_HASH, bytes)));
}

const isValidRecord = (record) => isPlainObject(record) && hasExactKeys(record, RECORD_FIELDS)
  && decodeBase64Url(record.salt)?.length === LOCK_BYTES.salt
  && isRoomMasterKey(record.masterKey);

function openDatabase(indexedDb) {
  return new Promise((resolve) => {
    const request = indexedDb.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => resolve(null);
    request.onblocked = () => { blocked = true; resolve(null); };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
}

function transact(database, mode, queue) {
  return new Promise((resolve) => {
    const transaction = database.transaction(STORE_NAME, mode);
    let result;
    // Request success is provisional. IndexedDB can still roll the transaction back.
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => resolve(undefined);
    queue(transaction.objectStore(STORE_NAME), (value) => { result = value; });
  });
}

async function withRoomStore(code, token, mode, fallback, queue) {
  let database;
  try {
    const indexedDb = globalThis.indexedDB;
    if (!indexedDb || typeof code !== 'string' || typeof token !== 'string') return fallback;
    const id = await recordId(code, token);
    database = await openDatabase(indexedDb);
    if (!database) return fallback;
    return (await transact(database, mode, (store, result) => queue(store, id, result))) ?? fallback;
  } catch (error) {
    // Storage is optional, including when browser policy denies access or a key cannot be cloned.
    if (error instanceof DOMException) return fallback;
    throw error;
  } finally {
    database?.close();
  }
}

function read(code, token) {
  return withRoomStore(code, token, READ_ONLY, null, (store, id, result) => {
    const request = store.get(id);
    request.onsuccess = () => result(isValidRecord(request.result) ? request.result : null);
  });
}

async function save(code, token, credentials) {
  const record = { salt: credentials?.salt, masterKey: credentials?.masterKey };
  if (!isValidRecord(record)) return false;
  return withRoomStore(code, token, READ_WRITE, false, (store, id, result) => {
    store.put(record, id);
    result(true);
  });
}

function remove(code, token, salt) {
  return withRoomStore(code, token, READ_WRITE, false, (store, id, result) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result;
      // Compare and delete in one transaction so a different salt saved by another tab wins.
      if (record !== undefined && (salt === undefined || record?.salt === salt)) store.delete(id);
      result(true);
    };
  });
}

export const rememberedRoomStore = { read, save, remove };
