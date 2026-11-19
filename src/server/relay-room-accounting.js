import { databaseCapacityError } from './relay-room-registry.js';

export function createRoomAccounting({ databaseSizeBytes, MAX_DB_BYTES, MAX_PENDING_STORE_OPS, MAX_PENDING_STORE_BYTES, MAX_ACTIVE_DOCUMENT_BYTES }) {
  const state = { dbUsageBytes: databaseSizeBytes(), pendingStoreOps: 0, pendingStoreBytes: 0, storageFailure: null, shuttingDown: false, activeDocumentBytes: 0 };
  // `upperBytes` is a conservative in-memory document bound. It starts at the
  // exact hydrated size and grows by each accepted update until a separately
  // throttled measurement refreshes it. This avoids synchronously encoding a
  // near-limit document on every tiny edit or every persistence compaction.
  const roomUsage = new WeakMap();
  const projectedActiveDocumentBytes = (ydoc, nextUpperBytes) => {
    const previous = roomUsage.get(ydoc);
    return Math.max(0, state.activeDocumentBytes - (previous?.upperBytes || 0) + nextUpperBytes);
  };

  const commitRoomUsage = (ydoc, nextUsage) => {
    state.activeDocumentBytes = projectedActiveDocumentBytes(ydoc, nextUsage.upperBytes);
    roomUsage.set(ydoc, nextUsage);
  };

  const tryCommitRoomUsage = (ydoc, nextUsage) => {
    if (projectedActiveDocumentBytes(ydoc, nextUsage.upperBytes) > MAX_ACTIVE_DOCUMENT_BYTES) {
      return false;
    }
    commitRoomUsage(ydoc, nextUsage);
    return true;
  };

  const releaseRoomUsage = (ydoc) => {
    const previous = roomUsage.get(ydoc);
    if (!previous) return;
    state.activeDocumentBytes = Math.max(0, state.activeDocumentBytes - previous.upperBytes);
    roomUsage.delete(ydoc);
  };
  return {
    roomUsage, projectedActiveDocumentBytes, commitRoomUsage, tryCommitRoomUsage, releaseRoomUsage,
    get dbUsageBytes() { return state.dbUsageBytes; },
    set dbUsageBytes(value) { state.dbUsageBytes = value; },
    get pendingStoreOps() { return state.pendingStoreOps; },
    set pendingStoreOps(value) { state.pendingStoreOps = value; },
    get pendingStoreBytes() { return state.pendingStoreBytes; },
    set pendingStoreBytes(value) { state.pendingStoreBytes = value; },
    get storageFailure() { return state.storageFailure; },
    set storageFailure(value) { state.storageFailure = value; },
    get shuttingDown() { return state.shuttingDown; },
    set shuttingDown(value) { state.shuttingDown = value; },
    get activeDocumentBytes() { return state.activeDocumentBytes; },
    set activeDocumentBytes(value) { state.activeDocumentBytes = value; },
    hasCapacity: () => state.dbUsageBytes + state.pendingStoreBytes < MAX_DB_BYTES,

    reserveStore(estimatedBytes) {
      if (state.pendingStoreOps >= MAX_PENDING_STORE_OPS
          || state.pendingStoreBytes + estimatedBytes > MAX_PENDING_STORE_BYTES
          || state.dbUsageBytes + state.pendingStoreBytes + estimatedBytes > MAX_DB_BYTES) throw databaseCapacityError();
      state.pendingStoreOps += 1;
      state.pendingStoreBytes += estimatedBytes;
      return () => {
        state.pendingStoreOps = Math.max(0, state.pendingStoreOps - 1);
        state.pendingStoreBytes = Math.max(0, state.pendingStoreBytes - estimatedBytes);
      };
    },
    measureDatabase() {
      state.dbUsageBytes = databaseSizeBytes();
      return state.dbUsageBytes;
    },
  };
}
