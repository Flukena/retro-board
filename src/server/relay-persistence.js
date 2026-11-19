import { LARGE_UPDATE_LOG_THRESHOLD_BYTES, STORE_OPERATION_OVERHEAD_BYTES } from './relay-config.js';
import { roomLogId } from './relay-log-id.js';

const MIN_COMPACTION_TIMER_DELAY_MS = 1;

export function createRelayPersistence({ config, accounting, docs, Y, blockRoom, markStorageFailure, storage }) {
  const { MAX_DOCUMENT_BYTES, MAX_ACTIVE_DOCUMENT_BYTES, ROOM_COMPACTION_MIN_INTERVAL_MS, DOCUMENT_REMEASURE_MIN_INTERVAL_MS, ROOM_COMPACT_AFTER_BYTES, ROOM_COMPACT_AFTER_UPDATES, ROOM_MAX_UNCOMPACTED_BYTES, ROOM_MAX_UNCOMPACTED_UPDATES, MAX_PENDING_STORE_OPS, MAX_PENDING_STORE_BYTES, MAX_DB_BYTES } = config;
  const { roomUsage, commitRoomUsage } = accounting;
  const { checkedFlushDocument, checkedStoreUpdate, databaseSizeBytes } = storage;
  // A small current Y.Doc can still have a very large LevelDB update log (for
  // example repeated insert/delete cycles). Track that write amplification
  // independently and compact while peers remain connected instead of waiting
  // for the last socket to leave.
  const roomPersistenceChurn = new Map();
  const persistenceChurnFor = (docName) => {
    let state = roomPersistenceChurn.get(docName);
    if (!state) {
      state = {
        uncompactedBytes: 0,
        uncompactedUpdates: 0,
        compactionPromise: null,
        compactionTimer: null,
        compactionTimerDueAt: 0,
        // Permit one prompt compaction after process start, then enforce the
        // cooldown. Cold-open budgets bound how often an attacker can reset
        // this state by cycling rooms, while legitimate first edits stay fluid.
        lastCompactedAt: 0,
        remeasureRequested: false,
      };
      roomPersistenceChurn.set(docName, state);
    }
    return state;
  };
  const deferCompaction = (docName, churn, hasPersistenceWork, activeDoc, compactionDueAt, remeasureDueAt) => {
    const nextDueAt = Math.min(
      hasPersistenceWork ? compactionDueAt : Number.POSITIVE_INFINITY,
      churn.remeasureRequested && activeDoc ? remeasureDueAt : Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(nextDueAt)) armRoomCompactionTimer(docName, churn, nextDueAt);
    return null;
  };

  const planCompaction = (docName, churn) => {
    const activeDoc = docs.get(docName);
    if (!activeDoc) churn.remeasureRequested = false;

    const hasPersistenceWork = churn.uncompactedBytes > 0 || churn.uncompactedUpdates > 0;
    if (!hasPersistenceWork && !churn.remeasureRequested) return null;

    const now = Date.now();
    const compactionDueAt = churn.lastCompactedAt + ROOM_COMPACTION_MIN_INTERVAL_MS;
    const canCompact = hasPersistenceWork && now >= compactionDueAt;
    const usage = activeDoc ? roomUsage.get(activeDoc) : null;
    const remeasureDueAt = (usage?.lastMeasuredAt || now) + DOCUMENT_REMEASURE_MIN_INTERVAL_MS;
    const canRemeasure = Boolean(churn.remeasureRequested && activeDoc && now >= remeasureDueAt);

    if (!canCompact && !canRemeasure) {
      return deferCompaction(docName, churn, hasPersistenceWork, activeDoc, compactionDueAt, remeasureDueAt);
    }
    return { canCompact };
  };

  const remeasureRoom = (docName, churn) => {
    const activeDoc = docs.get(docName);
    const currentUsage = activeDoc ? roomUsage.get(activeDoc) : null;
    const measurementNow = Date.now();
    if (churn.remeasureRequested && activeDoc && currentUsage
        && measurementNow - currentUsage.lastMeasuredAt >= DOCUMENT_REMEASURE_MIN_INTERVAL_MS) {
      try {
        const exactBytes = Y.encodeStateAsUpdate(activeDoc).byteLength;
        commitRoomUsage(activeDoc, {
          upperBytes: exactBytes,
          exactBytes,
          lastMeasuredAt: measurementNow,
        });
        churn.remeasureRequested = false;
        if (exactBytes > MAX_DOCUMENT_BYTES) {
          blockRoom(docName, activeDoc, 'document too large');
        } else if (accounting.activeDocumentBytes > MAX_ACTIVE_DOCUMENT_BYTES) {
          blockRoom(docName, activeDoc, 'active document capacity exceeded');
        }
        console.log('[yjs] document remeasured', {
          docName: roomLogId(docName),
          bytes: exactBytes,
        });
      } catch (err) {
        churn.remeasureRequested = false;
        blockRoom(docName, activeDoc, 'document size check failed');
        console.error('[yjs] document size check failed', {
          docName: roomLogId(docName),
          err: err.message,
        });
      }
    }
    if (!activeDoc) churn.remeasureRequested = false;
  };

  const finishCompaction = (docName, churn, canCompact, coveredBytes, coveredUpdates) => {
    if (canCompact) {
      churn.uncompactedBytes = Math.max(0, churn.uncompactedBytes - coveredBytes);
      churn.uncompactedUpdates = Math.max(0, churn.uncompactedUpdates - coveredUpdates);
      churn.lastCompactedAt = Date.now();
      accounting.dbUsageBytes = databaseSizeBytes();
    }
    remeasureRoom(docName, churn);
    if (canCompact) {
      console.log('[yjs] room compacted', {
        docName: roomLogId(docName),
        bytes: coveredBytes,
        updates: coveredUpdates,
      });
    }
  };

  const armRoomCompactionTimer = (docName, churn, dueAt) => {
    if (churn.compactionTimer && churn.compactionTimerDueAt <= dueAt) return;
    if (churn.compactionTimer) globalThis.clearTimeout(churn.compactionTimer);
    churn.compactionTimerDueAt = dueAt;
    churn.compactionTimer = globalThis.setTimeout(() => {
      churn.compactionTimer = null;
      churn.compactionTimerDueAt = 0;
      scheduleRoomCompaction(docName);
    }, Math.max(MIN_COMPACTION_TIMER_DELAY_MS, dueAt - Date.now()));
    churn.compactionTimer.unref();
  };

  const scheduleRoomCompaction = (docName, { remeasure = false } = {}) => {
    const churn = persistenceChurnFor(docName);
    if (remeasure) churn.remeasureRequested = true;
    if (churn.compactionPromise || accounting.shuttingDown || accounting.storageFailure) return churn.compactionPromise;
    const plan = planCompaction(docName, churn);
    if (!plan) return null;
    const { canCompact } = plan;

    if (churn.compactionTimer) globalThis.clearTimeout(churn.compactionTimer);
    churn.compactionTimer = null;
    churn.compactionTimerDueAt = 0;
    const coveredBytes = canCompact ? churn.uncompactedBytes : 0;
    const coveredUpdates = canCompact ? churn.uncompactedUpdates : 0;

    // checkedFlushDocument enters y-leveldb's single serialized transaction
    // queue at this exact point. Later storeUpdate calls are queued behind it,
    // so subtracting only this captured generation cannot hide concurrent edits.
    // Exact in-memory measurement is independent and can run without a flush;
    // both expensive operations have their own per-room cooldown.
    const compaction = (canCompact ? checkedFlushDocument(docName) : Promise.resolve())
      .then(() => {
        finishCompaction(docName, churn, canCompact, coveredBytes, coveredUpdates);
      })
      .catch((err) => {
        markStorageFailure(err);
        console.error('[yjs] room compaction failed', { docName: roomLogId(docName), err: err.message });
      })
      .finally(() => {
        churn.compactionPromise = null;
        if (churn.uncompactedBytes >= ROOM_COMPACT_AFTER_BYTES
            || churn.uncompactedUpdates >= ROOM_COMPACT_AFTER_UPDATES
            || churn.remeasureRequested) {
          scheduleRoomCompaction(docName);
        }
      });
    churn.compactionPromise = compaction;
    return compaction;
  };

  const storeWrites = new WeakMap(); // the last store write each doc queued (true once stored); a relay rename awaits its own
  const queueStoreUpdate = (docName, update, ydoc) => {
    const estimatedBytes = update.byteLength + STORE_OPERATION_OVERHEAD_BYTES;
    const churn = persistenceChurnFor(docName);
    if (churn.uncompactedBytes + estimatedBytes > ROOM_MAX_UNCOMPACTED_BYTES
        || churn.uncompactedUpdates + 1 > ROOM_MAX_UNCOMPACTED_UPDATES) {
      scheduleRoomCompaction(docName, { remeasure: true });
      blockRoom(docName, ydoc, 'room persistence backlog');
      return;
    }
    if (accounting.pendingStoreOps >= MAX_PENDING_STORE_OPS
        || accounting.pendingStoreBytes + estimatedBytes > MAX_PENDING_STORE_BYTES) {
      blockRoom(docName, ydoc, 'persistence backlog');
      return;
    }
    if (accounting.dbUsageBytes + accounting.pendingStoreBytes + estimatedBytes > MAX_DB_BYTES) {
      markStorageFailure(new Error('configured database quota exceeded'));
      return;
    }
    accounting.pendingStoreOps += 1;
    accounting.pendingStoreBytes += estimatedBytes;
    churn.uncompactedBytes += estimatedBytes;
    churn.uncompactedUpdates += 1;
    storeWrites.set(ydoc, checkedStoreUpdate(docName, update)
      .then(() => {
        accounting.dbUsageBytes += estimatedBytes;
        if (update.byteLength > LARGE_UPDATE_LOG_THRESHOLD_BYTES) {
          console.log('[yjs] storeUpdate ok', { docName: roomLogId(docName), bytes: update.byteLength });
        }
        return true;
      })
      .catch((err) => {
        markStorageFailure(err);
        console.error('[yjs] storeUpdate failed', { docName: roomLogId(docName), err: err.message });
        return false;
      })
      .finally(() => {
        accounting.pendingStoreOps = Math.max(0, accounting.pendingStoreOps - 1);
        accounting.pendingStoreBytes = Math.max(0, accounting.pendingStoreBytes - estimatedBytes);
      }));
    if (churn.uncompactedBytes >= ROOM_COMPACT_AFTER_BYTES
        || churn.uncompactedUpdates >= ROOM_COMPACT_AFTER_UPDATES) {
      scheduleRoomCompaction(docName, { remeasure: true });
    }
  };


  return { roomPersistenceChurn, persistenceChurnFor, scheduleRoomCompaction, storeWrites, queueStoreUpdate };
}
