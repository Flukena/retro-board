import {
  LOCK_BYTES, LOCK_KDF, ROOM_PASSWORD_MIN_LENGTH, decodeBase64Url, encodeBase64Url, isLockKdf, parseLockParams,
} from '../../domain/room-lock-contract.js';

const { subtle } = globalThis.crypto;
const textEncoder = new TextEncoder();

const BITS_PER_BYTE = 8;
const DEK_BYTES = 32;
const MASTER_BITS = 256;
const AUTH_BITS = LOCK_BYTES.authKey * BITS_PER_BYTE;
const GCM_TAG_BYTES = 16;
const KEK_INFO = textEncoder.encode('retroroom/kek/v1');
const AUTH_INFO = textEncoder.encode('retroroom/auth/v1');
const WRAP_AAD = textEncoder.encode('retroroom/kek-wrap/v1');
const AES_KEY_PARAMS = Object.freeze({ name: 'AES-GCM', length: 256 });
const HKDF_EMPTY_SALT = new Uint8Array(0);
const SHA256_ALGORITHM = 'SHA-256';

export class RoomKeyError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'RoomKeyError';
    this.code = code;
  }
}

const randomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));
const codePointLength = (text) => [...text].length;

function assertPasswordLength(password) {
  if (typeof password !== 'string' || codePointLength(password) < ROOM_PASSWORD_MIN_LENGTH) {
    throw new RangeError(`password must have at least ${ROOM_PASSWORD_MIN_LENGTH} characters`);
  }
}

function decodeExact(text, length, label) {
  const bytes = decodeBase64Url(text);
  if (bytes?.length !== length) throw new RangeError(`invalid ${label}`);
  return bytes;
}

async function pbkdf2Master(password, salt, kdf) {
  const base = await subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const params = { name: kdf.name, hash: kdf.hash, iterations: kdf.iterations, salt };
  return new Uint8Array(await subtle.deriveBits(params, base, MASTER_BITS));
}

const hkdfParams = (info) => ({ name: 'HKDF', hash: SHA256_ALGORITHM, salt: HKDF_EMPTY_SALT, info });

export async function deriveRoomSecrets(password, saltB64, kdf) {
  if (!isLockKdf(kdf)) throw new RangeError('unsupported kdf');
  const salt = decodeExact(saltB64, LOCK_BYTES.salt, 'salt');
  const master = await pbkdf2Master(password, salt, kdf);
  const hkdfKey = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  master.fill(0);
  const kek = await subtle.deriveKey(hkdfParams(KEK_INFO), hkdfKey, AES_KEY_PARAMS, false, ['encrypt', 'decrypt']);
  const authBytes = new Uint8Array(await subtle.deriveBits(hkdfParams(AUTH_INFO), hkdfKey, AUTH_BITS));
  return { kek, authKey: encodeBase64Url(authBytes) };
}

async function verifierOf(authKey) {
  const digest = await subtle.digest(SHA256_ALGORITHM, decodeBase64Url(authKey));
  return encodeBase64Url(new Uint8Array(digest));
}

const importDek = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function wrapRawDek(kek, rawDek) {
  const wrapIv = randomBytes(LOCK_BYTES.wrapIv);
  const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData: WRAP_AAD }, kek, rawDek);
  return { wrappedDek: encodeBase64Url(new Uint8Array(wrapped)), wrapIv: encodeBase64Url(wrapIv) };
}

async function unwrapRawDek(kek, wrappedDek, wrapIv) {
  const data = decodeExact(wrappedDek, LOCK_BYTES.wrappedDek, 'wrappedDek');
  const iv = decodeExact(wrapIv, LOCK_BYTES.wrapIv, 'wrapIv');
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, kek, data));
  } catch {
    throw new RoomKeyError('wrong-password');
  }
}

export async function unwrapRoomKey(kek, wrappedDek, wrapIv) {
  const raw = await unwrapRawDek(kek, wrappedDek, wrapIv);
  try {
    return await importDek(raw);
  } finally {
    raw.fill(0);
  }
}

async function buildLock(password, rawDek) {
  const salt = encodeBase64Url(randomBytes(LOCK_BYTES.salt));
  const kdf = { ...LOCK_KDF };
  const { kek, authKey } = await deriveRoomSecrets(password, salt, kdf);
  const wrap = await wrapRawDek(kek, rawDek);
  return { authKey, lock: { salt, kdf, verifier: await verifierOf(authKey), ...wrap } };
}

export async function createRoomLock(password) {
  assertPasswordLength(password);
  const rawDek = randomBytes(DEK_BYTES);
  try {
    const { lock, authKey } = await buildLock(password, rawDek);
    return { lock, dek: await importDek(rawDek), authKey };
  } finally {
    rawDek.fill(0);
  }
}

/** Rotation: a brand-new DEK under a new password. */
export const createNextRoomKey = createRoomLock;

export async function rewrapRoomLock({ currentPassword, lock, newPassword }) {
  assertPasswordLength(newPassword);
  if (newPassword === currentPassword) throw new RangeError('new password must differ from the current password');
  const params = parseLockParams(lock);
  if (!params) throw new RangeError('invalid lock');
  const old = await deriveRoomSecrets(currentPassword, params.salt, params.kdf);
  const rawDek = await unwrapRawDek(old.kek, params.wrappedDek, params.wrapIv);
  try {
    const next = await buildLock(newPassword, rawDek);
    return { lock: next.lock, authKey: next.authKey, oldAuthKey: old.authKey };
  } finally {
    rawDek.fill(0);
  }
}

export async function encryptFrame(dek, aad, plaintext) {
  const iv = randomBytes(LOCK_BYTES.wrapIv);
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, plaintext));
  const frame = new Uint8Array(iv.length + ciphertext.length);
  frame.set(iv);
  frame.set(ciphertext, iv.length);
  return frame;
}

export async function decryptFrame(dek, aad, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < LOCK_BYTES.wrapIv + GCM_TAG_BYTES) throw new RoomKeyError('tampered');
  const iv = bytes.subarray(0, LOCK_BYTES.wrapIv);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, bytes.subarray(LOCK_BYTES.wrapIv)));
  } catch {
    throw new RoomKeyError('tampered');
  }
}
