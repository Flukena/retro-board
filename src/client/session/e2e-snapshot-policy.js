import { E2E_SNAPSHOT_MIN_INTERVAL_MS } from '../../domain/e2e-limits.js';

/** A snapshot is due after this many log entries since the last one (plan Deviation 11). */
export const SNAPSHOT_AFTER_UPDATES = 500;
/** …or after this many log bytes since the last one. */
export const SNAPSHOT_AFTER_BYTES = 1024 * 1024;
/** Uniform random delay before a due snapshot, so peers do not all snapshot at once. */
export const SNAPSHOT_JITTER_MAX_MS = 5_000;

/** When this page should write a snapshot of the room log. Counters cover the log since its last snapshot. */
export class SnapshotPolicy {
  #afterUpdates;
  #afterBytes;
  #minIntervalMs;
  #updates = 0;
  #bytes = 0;
  #quotaReached = false;
  #lastAttemptAt = Number.NEGATIVE_INFINITY;

  constructor({
    afterUpdates = SNAPSHOT_AFTER_UPDATES, afterBytes = SNAPSHOT_AFTER_BYTES, minIntervalMs = E2E_SNAPSHOT_MIN_INTERVAL_MS,
  } = {}) {
    this.#afterUpdates = afterUpdates;
    this.#afterBytes = afterBytes;
    this.#minIntervalMs = minIntervalMs;
  }

  get quotaReached() { return this.#quotaReached; }

  /** A new connection replays the log since the last snapshot and gets a fresh relay allowance. */
  restart() {
    this.logPruned();
    this.#lastAttemptAt = Number.NEGATIVE_INFINITY;
  }

  noteLogEntry(byteLength) {
    this.#updates += 1;
    this.#bytes += byteLength;
  }

  /** Any accepted snapshot, this page's or a peer's, prunes the log. */
  logPruned() {
    this.#updates = 0;
    this.#bytes = 0;
    this.#quotaReached = false;
  }

  reachQuota() { this.#quotaReached = true; }

  attempted(now) { this.#lastAttemptAt = now; }

  wants({ forced = false } = {}) {
    return forced || this.#quotaReached || this.#updates >= this.#afterUpdates || this.#bytes >= this.#afterBytes;
  }

  /** Milliseconds until the relay's one-snapshot-per-connection interval allows another attempt. */
  waitMs(now) { return Math.max(0, this.#lastAttemptAt + this.#minIntervalMs - now); }
}
