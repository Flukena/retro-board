import { MAX_OWNED_ROOMS_PER_ACCOUNT, decodeOwnerRecord, encodeOwnerRecord } from '../domain/room-ownership.js';

export const OWNED_ROOM_LIMIT_CODE = 'OWNED_ROOM_LIMIT';
const OWNED_ROOM_LIMIT_MESSAGE = 'owned room limit reached';
const INVALID_OWNER_RECORD_MESSAGE = 'invalid room owner record';
const NO_OWNER = Object.freeze({ record: null, ownerAccountId: null });
const releaseNothing = () => {};

/**
 * Who owns a room: its owner record decides; a locked room without one (made before records) falls back to the
 * account that locked it. Guest and orphaned rooms belong to nobody.
 */
export function ownerEntry(record, lock) {
  if (record) return { record, ownerAccountId: record.accountId };
  const lockOwner = lock?.ownerAccountId;
  return { record: null, ownerAccountId: typeof lockOwner === 'string' ? lockOwner : null };
}

/** The meta value to store for a decoded owner record, orphaned ones included; throws for anything invalid. */
export function storedOwnerValue(record) {
  const base = encodeOwnerRecord(record);
  const value = record.orphanedAt === undefined ? base : { ...base, orphanedAt: record.orphanedAt };
  if (!decodeOwnerRecord(value)) throw new TypeError(INVALID_OWNER_RECORD_MESSAGE);
  return value;
}

/** In-memory owner of every registered room, the rooms of each account and its creations in flight. */
export class RoomOwnerIndex {
  #entries = new Map();
  #roomsByAccount = new Map();
  #pendingByAccount = new Map();

  set(docName, entry) {
    this.forget(docName);
    this.#entries.set(docName, entry);
    if (entry.ownerAccountId === null) return;
    const rooms = this.#roomsByAccount.get(entry.ownerAccountId) ?? new Set();
    rooms.add(docName);
    this.#roomsByAccount.set(entry.ownerAccountId, rooms);
  }

  forget(docName) {
    const accountId = this.#entries.get(docName)?.ownerAccountId;
    this.#entries.delete(docName);
    const rooms = this.#roomsByAccount.get(accountId);
    if (!rooms) return;
    rooms.delete(docName);
    if (rooms.size === 0) this.#roomsByAccount.delete(accountId);
  }

  entryOf(docName) { return this.#entries.get(docName) ?? NO_OWNER; }

  roomsOwnedBy(accountId) { return [...(this.#roomsByAccount.get(accountId) ?? [])]; }

  /**
   * Synchronously counts one more room for the account, or throws OWNED_ROOM_LIMIT. Returns the release, safe to
   * call more than once. A guest creation (null) is never limited.
   */
  reserve(accountId) {
    if (accountId === null) return releaseNothing;
    const pending = this.#pendingByAccount.get(accountId) ?? 0;
    if ((this.#roomsByAccount.get(accountId)?.size ?? 0) + pending >= MAX_OWNED_ROOMS_PER_ACCOUNT) {
      throw Object.assign(new Error(OWNED_ROOM_LIMIT_MESSAGE), { code: OWNED_ROOM_LIMIT_CODE });
    }
    this.#pendingByAccount.set(accountId, pending + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.#pendingByAccount.get(accountId) - 1;
      if (left === 0) this.#pendingByAccount.delete(accountId);
      else this.#pendingByAccount.set(accountId, left);
    };
  }
}
