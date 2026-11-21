import { WS_CLOSE } from './relay-status-codes.js';
import { ROOM_BLOCK_TTL_MS, BLOCKED_ROOM_ENTRIES_PER_ACTIVE_ROOM } from './relay-config.js';
import { roomLogId } from './relay-log-id.js';

export function createRoomPolicy({ MAX_ACTIVE_ROOMS }) {
  const destroyedDocs = new WeakSet();
  const capacityRejectedDocs = new WeakSet();

  const blockedRooms = new Map();
  const MAX_BLOCKED_ROOM_ENTRIES = MAX_ACTIVE_ROOMS * BLOCKED_ROOM_ENTRIES_PER_ACTIVE_ROOM;

  const blockRoom = (docName, ydoc, reason) => {
    const now = Date.now();
    blockedRooms.delete(docName);
    blockedRooms.set(docName, now + ROOM_BLOCK_TTL_MS);
    while (blockedRooms.size > MAX_BLOCKED_ROOM_ENTRIES) {
      blockedRooms.delete(blockedRooms.keys().next().value);
    }
    console.warn('[yjs] room policy close', { docName: roomLogId(docName), reason });
    if (ydoc) {
      for (const conn of ydoc.conns.keys()) {
        try { conn.close(WS_CLOSE.TOO_LARGE, 'room resource limit'); } catch { /* already closing */ }
      }
    }
  };

  const isRoomBlocked = (docName) => {
    const expiresAt = blockedRooms.get(docName);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      blockedRooms.delete(docName);
      return false;
    }
    return true;
  };


  return { destroyedDocs, capacityRejectedDocs, blockedRooms, blockRoom, isRoomBlocked };
}

export function createRoomState({ Y, config, accounting, policy, votes, storage, queueStoreUpdate, roomPersistenceChurn, markStorageFailure, HYDRATION_ORIGIN }) {
  const { MAX_UPDATE_BYTES, MAX_DOCUMENT_BYTES } = config;
  const { usageFor, commitRoomUsage, tryCommitRoomUsage, releaseRoomUsage } = accounting;
  const { destroyedDocs, capacityRejectedDocs, blockRoom } = policy;
  const { finalizeExpiredVotes, armVoteExpiry, voteExpiryTimers } = votes;
  const { checkedGetYDoc, ldb } = storage;
  const releaseRoom = (ydoc) => {
    const timer = voteExpiryTimers.get(ydoc);
    if (timer) globalThis.clearTimeout(timer);
    voteExpiryTimers.delete(ydoc);
    destroyedDocs.add(ydoc);
    releaseRoomUsage(ydoc);
  };

  const observeVoteTimers = (docName, ydoc, events) => {
    const itemMap = ydoc.getMap('items');
    if (events.some((event) => event.keysChanged?.has('voteTimer')
        || (event.target === itemMap && [...event.keysChanged].some((id) => (
          itemMap.get(id) instanceof Y.Map && itemMap.get(id).get('voteTimer')
        ))))) {
      armVoteExpiry(docName, ydoc);
    }
  };

  const storeRoomUpdate = (docName, ydoc, u, origin) => {
    if (origin === HYDRATION_ORIGIN) return;
    if (u.byteLength > MAX_UPDATE_BYTES) {
      blockRoom(docName, ydoc, 'update too large');
      return;
    }
    const usage = usageFor(ydoc);
    const nextUsage = {
      ...usage,
      upperBytes: usage.upperBytes + u.byteLength,
    };
    if (nextUsage.upperBytes > MAX_DOCUMENT_BYTES) {
      // Network updates are conservatively admitted before y-websocket
      // applies them. Reaching this branch means a non-network origin or an
      // unexpected encoding expansion escaped that guard; never turn it
      // into an attacker-controlled full-document encode loop.
      commitRoomUsage(ydoc, nextUsage);
      blockRoom(docName, ydoc, 'document conservative limit');
      return;
    }
    if (!tryCommitRoomUsage(ydoc, nextUsage)) {
      // A non-network update is already resident by this point. Account for
      // the temporary excess, then evict; network updates are rejected by
      // the protocol preflight before they can reach this branch.
      commitRoomUsage(ydoc, nextUsage);
      blockRoom(docName, ydoc, 'active document capacity exceeded');
      return;
    }
    queueStoreUpdate(docName, u, ydoc);
  };

  const hydrateRoom = async (docName, ydoc) => {
    try {
      const persisted = await checkedGetYDoc(docName);
      let persistedUpdate;
      try {
        persistedUpdate = Y.encodeStateAsUpdate(persisted);
      } finally {
        persisted.destroy();
      }
      if (persistedUpdate.byteLength > MAX_DOCUMENT_BYTES) {
        blockRoom(docName, ydoc, 'persisted document too large');
        return;
      }
      if (destroyedDocs.has(ydoc)) return;
      const hydratedUsage = {
        upperBytes: persistedUpdate.byteLength,
        exactBytes: persistedUpdate.byteLength,
        lastMeasuredAt: Date.now(),
      };
      if (!tryCommitRoomUsage(ydoc, hydratedUsage)) {
        // Aggregate pressure is transient. Reject this cold-room admission
        // without poisoning the room for the blocked-room TTL or declaring
        // the persistence layer globally unhealthy.
        capacityRejectedDocs.add(ydoc);
        console.warn('[yjs] active document capacity reached', {
          docName: roomLogId(docName),
        });
        return;
      }
      Y.applyUpdate(ydoc, persistedUpdate, HYDRATION_ORIGIN);
      try { finalizeExpiredVotes(docName, ydoc); }
      catch (err) {
        console.error('[yjs] vote finalization failed', { docName: roomLogId(docName), err: err.message });
      }
      armVoteExpiry(docName, ydoc);
    } catch (err) {
      markStorageFailure(err);
      console.error('[yjs] hydrate failed', { docName: roomLogId(docName), err: err.message });
    }
  };

  // Hydration promise per room. y-websocket calls bindState without awaiting it
  // and starts answering the sync protocol immediately, so a client connecting
  // to a cold room is told "synced" against an empty doc while the LevelDB read
  // is still in flight — it then sees a blank board and can write over real
  // state. The upgrade handler awaits this before letting the socket through.
  const roomReady = new WeakMap();

  const persistence = {
    bindState: (docName, ydoc) => {
      // Aggregate accounting follows the Y.Doc lifetime. This covers normal
      // last-peer teardown as well as a failed first-upgrade cleanup exactly
      // once, without depending on each caller to mirror the bookkeeping.
      ydoc.on('destroy', () => releaseRoom(ydoc));
      ydoc.getMap('items').observeDeep(events => observeVoteTimers(docName, ydoc, events));
      // The listener must be registered BEFORE the first await. y-websocket
      // calls bindState without awaiting it, so the room already accepts and
      // broadcasts client updates while the LevelDB read is in flight. Any
      // update applied during that gap was never handed to storeUpdate — it
      // reaches every peer, then vanishes on the next server restart.
      ydoc.on('update', (u, origin) => storeRoomUpdate(docName, ydoc, u, origin));
      // y-websocket calls bindState as a floating promise (bin/utils.js:149) with
      // no .catch(), so anything thrown here becomes an unhandled rejection and
      // kills the process. Contain it: latch the failure and drain for restart.
      const ready = hydrateRoom(docName, ydoc);
      // Runs before hydration's first await yields, so the entry is in place by
      // the time y-websocket's getYDoc returns this doc to the upgrade handler.
      roomReady.set(ydoc, ready);
      return ready;
    },
    // y-websocket invokes writeState in closeConn when the last client of a
    // room disconnects. Updates are already stored individually; consolidation
    // is thresholded and rate-limited separately so disconnect cannot force a
    // full-document merge.
    // Rethrowing here would also be fatal: the caller does
    // `writeState(...).then(() => doc.destroy())` with no .catch()
    // (bin/utils.js:205), so the rejection would go unhandled.
    writeState: async (docName) => {
      try {
        const churn = roomPersistenceChurn.get(docName);
        // Every update is already durable through storeUpdate. Do not force a
        // full-room merge merely because the last peer disconnected: repeated
        // connect/disconnect would otherwise be an unbounded CPU amplifier.
        // If a threshold-triggered merge is already running, wait before the
        // library destroys its Y.Doc so our completion path cannot race it.
        if (churn?.compactionPromise) await churn.compactionPromise;
      }
      catch (err) {
        markStorageFailure(err);
        console.error('[yjs] flushDocument failed', { docName: roomLogId(docName), err: err.message });
      }
    },
    provider: ldb,
  };

  return { roomReady, persistence };
}
