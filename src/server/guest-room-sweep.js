import { guestRoomCandidates, GUEST_SWEEP_INTERVAL_MS } from '../domain/room-retention.js';
import { retireCandidates, retireIdleRooms, roomRows } from './room-retirement.js';

const GUEST_SWEEP_LOG = '[yjs] guest room sweep';
const GUEST_SWEEP_FAILED_LOG = '[yjs] guest room sweep failed';

/**
 * Retires idle guest rooms (and only those) at most once per GUEST_SWEEP_INTERVAL_MS, driven by the relay's existing
 * maintenance tick. Single-flight; a no-op on the Public Wall relay. Owned, orphaned, legacy and Public Wall rooms are
 * never swept here; their 60-day retirement stays operator-triggered through retireIdle().
 * Deletion-journal recovery is not repeated here: it already runs on the maintenance tick and at startup, so the
 * summary carries no `recovered` field.
 * Ports (same as retireIdleRooms): registry, docs, connections, publicWall, log, deleteRoom(docName).
 */
export class GuestRoomSweep {
  #ports;
  #running = false;
  #nextSweepAt = 0;

  constructor(ports) {
    this.#ports = ports;
  }

  /** The maintainer's on-demand retirement of every idle class. */
  retireIdle(now) {
    return retireIdleRooms({ ...this.#ports, now });
  }

  /** Runs one sweep when one is due; resolves to its summary, or null when skipped. */
  async tick(now = Date.now()) {
    const { publicWall, log } = this.#ports;
    if (publicWall || this.#running || now < this.#nextSweepAt) return null;
    this.#running = true;
    try {
      const candidates = guestRoomCandidates(roomRows(this.#ports), now);
      const summary = await retireCandidates(this.#ports, candidates);
      this.#nextSweepAt = now + GUEST_SWEEP_INTERVAL_MS;
      if (summary.retired > 0) log.log(GUEST_SWEEP_LOG, summary);
      return summary;
    } catch (error) {
      log.error(GUEST_SWEEP_FAILED_LOG, { err: error.message });
      return null;
    } finally {
      this.#running = false;
    }
  }
}
