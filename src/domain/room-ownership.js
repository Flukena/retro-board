import { isAccountId } from './account-identity.js';

export const ROOM_OWNER_META = 'retro-room-owner-v1';
export const ROOM_KIND = Object.freeze({ BOARD: 'board', POKER: 'poker' });
export const RETENTION_CLASS = Object.freeze({ GUEST: 'guest', KEPT: 'kept' });
export const MAX_OWNED_ROOMS_PER_ACCOUNT = 500;
/** WebSocket close code for every socket of a room its owner just deleted. */
export const ROOM_DELETED_CLOSE_CODE = 4004;
export const ROOM_DELETED_REASON = 'room deleted';

const OWNER_RECORD_VERSION = 1;
const BASE_KEYS = ['v', 'kind', 'accountId', 'createdAt'];
const ORPHANED_KEYS = [...BASE_KEYS, 'orphanedAt'];
const KINDS = new Set(Object.values(ROOM_KIND));

const isTime = (value) => Number.isSafeInteger(value) && value > 0;
const hasExactKeys = (value, keys) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

function validFields({ kind, accountId, createdAt }) {
  return KINDS.has(kind) && (accountId === null || isAccountId(accountId)) && isTime(createdAt);
}

/** Owner meta value to store. accountId null marks a guest room. */
export function encodeOwnerRecord({ kind, accountId, createdAt }) {
  if (!validFields({ kind, accountId, createdAt })) throw new TypeError('invalid room owner record');
  return { v: OWNER_RECORD_VERSION, kind, accountId, createdAt };
}

/** Exact-shape decode of a stored owner meta value; null for anything else. */
export function decodeOwnerRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.v !== OWNER_RECORD_VERSION || !validFields(value)) return null;
  if (hasExactKeys(value, BASE_KEYS)) {
    return { kind: value.kind, accountId: value.accountId, createdAt: value.createdAt };
  }
  if (!hasExactKeys(value, ORPHANED_KEYS) || value.accountId !== null || !isTime(value.orphanedAt)) return null;
  return { kind: value.kind, accountId: null, createdAt: value.createdAt, orphanedAt: value.orphanedAt };
}

/** The record of a room whose account was deleted: no owner, and no longer a guest room. */
export const orphanOwnerRecord = (record, now) => ({
  kind: record.kind, accountId: null, createdAt: record.createdAt, orphanedAt: now,
});

/** Only a pure guest record expires early; a missing record (legacy room, Public Wall), owned and orphaned rooms are kept. */
export function retentionClass(record) {
  const isGuest = record !== null && record.accountId === null && record.orphanedAt === undefined;
  return isGuest ? RETENTION_CLASS.GUEST : RETENTION_CLASS.KEPT;
}
