import { isAccountId } from '../domain/account-identity.js';
import { hasExactKeys, isCounter, isPlainObject, parseLockParams } from '../domain/room-lock-contract.js';

export const ROOM_LOCK_META = 'retro-room-lock-v1';
export const ROOM_LOCK_VERSION = 1;
const RECORD_FIELDS = ['v', 'salt', 'kdf', 'verifier', 'wrappedDek', 'wrapIv', 'keyEpoch', 'ownerAccountId', 'createdAt', 'lockRevision'];

/** True when a stored lock meta value exists at all: a present but unreadable record still means "locked". */
export const hasLockMeta = (value) => value !== undefined && value !== null;

/** Strict decoder: returns a frozen record, or null for anything that is not exactly a v1 record. */
export function decodeLockRecord(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, RECORD_FIELDS) || value.v !== ROOM_LOCK_VERSION) return null;
  const params = parseLockParams({
    salt: value.salt, kdf: value.kdf, verifier: value.verifier, wrappedDek: value.wrappedDek, wrapIv: value.wrapIv,
  });
  if (!params || !isAccountId(value.ownerAccountId)) return null;
  if (!isCounter(value.keyEpoch) || !isCounter(value.createdAt) || !isCounter(value.lockRevision)) return null;
  return Object.freeze({
    v: ROOM_LOCK_VERSION,
    ...params,
    keyEpoch: value.keyEpoch,
    ownerAccountId: value.ownerAccountId,
    createdAt: value.createdAt,
    lockRevision: value.lockRevision,
  });
}

/** Plain JSON-safe copy for storage; throws on anything decodeLockRecord would reject. */
export function encodeLockRecord(record) {
  const decoded = decodeLockRecord(record);
  if (!decoded) throw new TypeError('invalid room lock record');
  return { ...decoded, kdf: { ...decoded.kdf } };
}

/** Held in the lock map for a committed room whose stored record is unreadable: still locked, never served. */
export const CORRUPT_LOCK = Object.freeze({ corrupt: true });
