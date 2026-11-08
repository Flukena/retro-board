import { createHash } from 'node:crypto';
import { MILLISECONDS_PER_MINUTE, MILLISECONDS_PER_SECOND } from './relay-config.js';
import { fixedDigestEqual } from './relay-room-registry.js';
import { decodeBase64Url } from '../domain/room-lock-contract.js';

export { ROOM_LOCK_META, decodeLockRecord, encodeLockRecord } from './room-lock-record.js';

const WINDOW_MINUTES = 15;
export const WRONG_PASSWORD_WINDOW_MS = WINDOW_MINUTES * MILLISECONDS_PER_MINUTE;
export const WRONG_PASSWORDS_PER_IP_ROOM = 5;
export const WRONG_PASSWORDS_PER_ROOM = 50;
export const DEFAULT_VERIFIER_MAX_KEYS = 10_000;
const WINDOW_SECONDS = WRONG_PASSWORD_WINDOW_MS / MILLISECONDS_PER_SECOND;
const MIN_RETRY_SECONDS = 1;
const KEY_SEPARATOR = '\0';
const MISSING_RECORD_MESSAGE = 'RoomLockVerifier.check requires a lock record';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

/** Strict rolling-window limiter for wrong-password attempts; only failures are counted. */
export class RoomLockVerifier {
  #now;
  #maxKeys;
  #byIpRoom = new Map();
  #byRoom = new Map();

  constructor({ now = Date.now, maxKeys = DEFAULT_VERIFIER_MAX_KEYS } = {}) {
    this.#now = now;
    this.#maxKeys = maxKeys;
  }

  /** @returns {'ok' | 'wrong' | { limited: number }} */
  check(ip, docName, record, authKeyB64) {
    if (!record) throw new Error(MISSING_RECORD_MESSAGE);
    const now = this.#now();
    const ipKey = `${ip}${KEY_SEPARATOR}${docName}`;
    const blocked = this.#blockedFor(now, [
      [this.#byIpRoom, ipKey, WRONG_PASSWORDS_PER_IP_ROOM],
      [this.#byRoom, docName, WRONG_PASSWORDS_PER_ROOM],
    ]);
    if (blocked !== null) return { limited: blocked };
    if (this.#matches(record, authKeyB64)) return 'ok';
    this.#record(this.#byIpRoom, ipKey, now, WRONG_PASSWORDS_PER_IP_ROOM);
    this.#record(this.#byRoom, docName, now, WRONG_PASSWORDS_PER_ROOM);
    return 'wrong';
  }

  /** Drops keys whose failures have all left the window. */
  sweep(now = this.#now()) {
    for (const map of [this.#byIpRoom, this.#byRoom]) {
      for (const [key, stamps] of map) if (this.#live(stamps, now).length === 0) map.delete(key);
    }
  }

  #live(stamps, now) {
    return stamps.filter((stamp) => now - stamp < WRONG_PASSWORD_WINDOW_MS);
  }

  // Seconds to wait when any window blocks the attempt (the stricter wins), else null.
  #blockedFor(now, windows) {
    let retry = null;
    for (const [map, key, cap] of windows) {
      const seconds = this.#retrySeconds(map, key, cap, now);
      if (seconds !== null) retry = Math.max(retry ?? seconds, seconds);
    }
    return retry;
  }

  #retrySeconds(map, key, cap, now) {
    const stamps = map.get(key);
    if (!stamps) return this.#isFull(map, now) ? WINDOW_SECONDS : null;
    const live = this.#live(stamps, now);
    if (live.length === 0) {
      map.delete(key);
      return this.#isFull(map, now) ? WINDOW_SECONDS : null;
    }
    stamps.splice(0, stamps.length, ...live);
    if (live.length < cap) return null;
    const waitMs = live[0] + WRONG_PASSWORD_WINDOW_MS - now;
    return Math.max(MIN_RETRY_SECONDS, Math.ceil(waitMs / MILLISECONDS_PER_SECOND));
  }

  // A new key never evicts a live one: a full map of live keys refuses it.
  #isFull(map, now) {
    if (map.size < this.#maxKeys) return false;
    this.sweep(now);
    return map.size >= this.#maxKeys;
  }

  #matches(record, authKeyB64) {
    const authKey = decodeBase64Url(authKeyB64);
    if (authKey === null) return false;
    return fixedDigestEqual(sha256(authKey), Buffer.from(decodeBase64Url(record.verifier)));
  }

  #record(map, key, now, cap) {
    const stamps = map.get(key) ?? [];
    stamps.push(now);
    if (stamps.length > cap) stamps.shift();
    map.set(key, stamps);
  }
}
