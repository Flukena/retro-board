import { finalizeRelayVotes } from './relay-vote-maintenance.js';
import { VOTE_EXPIRY_RETRY_INTERVAL_MS } from './relay-config.js';
import { roomLogId } from './relay-log-id.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_TIMER_DELAY_MS = 1;

export function createVoteExpiry({ Y, accounting, destroyedDocs, isRoomBlocked }) {
  // The relay is the durable fallback for deadlines. Connected clients also
  // finalize promptly for immediate UI feedback; this pass covers a room whose
  // creator is gone and a room reopened after everyone was offline.
  const finalizeExpiredVotes = (docName, ydoc, atTime = Date.now()) => {
    if (accounting.storageFailure || accounting.shuttingDown || isRoomBlocked(docName)) return;
    finalizeRelayVotes(ydoc, Y, atTime, () => {
      console.warn('[yjs] vote finalization skipped invalid geometry', { docName: roomLogId(docName) });
    });
  };

  const voteExpiryTimers = new WeakMap();
  const armVoteExpiry = (docName, ydoc, deferExpired = false) => {
    const existing = voteExpiryTimers.get(ydoc);
    if (existing) globalThis.clearTimeout(existing);
    voteExpiryTimers.delete(ydoc);
    if (destroyedDocs.has(ydoc) || accounting.storageFailure || accounting.shuttingDown) return;
    let earliest = Infinity;
    ydoc.getMap('items').forEach((yItem) => {
      if (!(yItem instanceof Y.Map) || yItem.get('type') !== 'zone') return;
      const deadline = yItem.get('voteTimer')?.endsAt;
      if (Number.isFinite(deadline)) earliest = Math.min(earliest, deadline);
    });
    if (!Number.isFinite(earliest)) return;
    // A malformed unfinalizable room must not create a zero-delay retry loop.
    const waitMs = earliest <= Date.now()
      ? (deferExpired ? VOTE_EXPIRY_RETRY_INTERVAL_MS : MIN_TIMER_DELAY_MS)
      : Math.max(MIN_TIMER_DELAY_MS, Math.min(earliest - Date.now(), MAX_TIMER_DELAY_MS));
    const timer = globalThis.setTimeout(() => {
      voteExpiryTimers.delete(ydoc);
      try { finalizeExpiredVotes(docName, ydoc); }
      catch (err) {
        console.error('[yjs] vote finalization failed', { docName: roomLogId(docName), err: err.message });
      }
      armVoteExpiry(docName, ydoc, true);
    }, waitMs);
    timer.unref();
    voteExpiryTimers.set(ydoc, timer);
  };


  return { finalizeExpiredVotes, armVoteExpiry, voteExpiryTimers };
}
