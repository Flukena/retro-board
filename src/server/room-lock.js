import { createHash } from 'node:crypto';
import { MILLISECONDS_PER_MINUTE, MILLISECONDS_PER_SECOND } from './relay-config.js';
import { fixedDigestEqual } from './relay-room-registry.js';
import { decodeBase64Url } from '../domain/room-lock-contract.js';

export { CORRUPT_LOCK, ROOM_LOCK_META, decodeLockRecord, encodeLockRecord } from './room-lock-record.js';

const WINDOW_MINUTES = 15;
export const WRONG_PASSWORD_WINDOW_MS = WINDOW_MINUTES * MILLISECONDS_PER_MINUTE;
export const WRONG_PASSWORDS_PER_IP_ROOM = 5;
export const WRONG_PASSWORDS_PER_ROOM = 50;
export const DEFAULT_VERIFIER_MAX_KEYS = 10_000;
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

  /**
   * `countFailure: false` answers a wrong key without charging it: for a member whose session already proves access.
   * @returns {'ok' | 'wrong' | { limited: number }}
   */
  check(ip, docName, record, authKeyB64, { countFailure = true } = {}) {
    if (!record) throw new Error(MISSING_RECORD_MESSAGE);
    const now = this.#now();
    const ipKey = `${ip}${KEY_SEPARATOR}${docName}`;
    const blocked = this.#blockedFor(now, [
      [this.#byIpRoom, ipKey, WRONG_PASSWORDS_PER_IP_ROOM],
      [this.#byRoom, docName, WRONG_PASSWORDS_PER_ROOM],
    ]);
    if (blocked !== null) return { limited: blocked };
    if (this.#matches(record, authKeyB64)) return 'ok';
    if (!countFailure) return 'wrong';
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
    const live = stamps ? this.#live(stamps, now) : [];
    if (stamps && live.length === 0) map.delete(key);
    if (live.length === 0) return this.#secondsUntil(this.#slotFreeAt(map, now), now);
    stamps.splice(0, stamps.length, ...live);
    return live.length < cap ? null : this.#secondsUntil(live[0] + WRONG_PASSWORD_WINDOW_MS, now);
  }

  #secondsUntil(at, now) {
    if (at === null) return null;
    return Math.max(MIN_RETRY_SECONDS, Math.ceil((at - now) / MILLISECONDS_PER_SECOND));
  }

  // A new key never evicts a live one: while the map is full of live keys it is refused
  // until the earliest key empties. Returns null when a slot is free.
  #slotFreeAt(map, now) {
    if (map.size < this.#maxKeys) return null;
    this.sweep(now);
    if (map.size < this.#maxKeys) return null;
    let earliest = Infinity;
    for (const stamps of map.values()) earliest = Math.min(earliest, stamps.at(-1) + WRONG_PASSWORD_WINDOW_MS);
    return earliest;
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
