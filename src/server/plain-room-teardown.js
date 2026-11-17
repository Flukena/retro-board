import { safeClose } from './relay-ws-traffic.js';

/**
 * Deletion of a normal (Y.Doc) room's in-memory state. Ports: docs (y-websocket's map), roomReady (doc → hydration
 * promise), roomPersistenceChurn (docName → compaction state), blockedRooms.
 */
export function createPlainRoomTeardown({ docs, roomReady, roomPersistenceChurn, blockedRooms }) {
  // Zeroed counters stop the compaction's own completion from scheduling another flush of the deleted room.
  const cancelCompaction = (docName) => {
    const churn = roomPersistenceChurn.get(docName);
    roomPersistenceChurn.delete(docName);
    if (!churn) return null;
    clearTimeout(churn.compactionTimer);
    churn.compactionTimer = null;
    churn.uncompactedBytes = 0;
    churn.uncompactedUpdates = 0;
    churn.remeasureRequested = false;
    return churn.compactionPromise;
  };

  return {
    /**
     * Closes every socket with `code`, then drops and destroys the doc in the same tick, even with no socket: a
     * destroyed Y.Doc has no update listener, so nothing a peer still sends is stored, and its vote timer is cleared.
     * Settles once hydration and any in-flight compaction have landed. Store writes already issued need no wait:
     * y-leveldb runs every transaction in order, so the deleter's clear is queued behind them.
     */
    async retire(docName, code, reason) {
      blockedRooms.delete(docName);
      const doc = docs.get(docName);
      if (doc) {
        for (const conn of doc.conns.keys()) safeClose(conn, code, reason);
        docs.delete(docName);
        doc.destroy();
      }
      const compaction = cancelCompaction(docName);
      await Promise.all([doc && roomReady.get(doc), compaction]);
    },
  };
}
