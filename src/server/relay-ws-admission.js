import { STORE_OPERATION_OVERHEAD_BYTES } from './relay-config.js';
import { admitPublicAction } from './public-action-limit.js';
import { PUBLIC_ACTION_LIMIT_REASON } from './public-wall-config.js';

export function createWsAdmission({ config, accounting, persistenceChurnFor, scheduleRoomCompaction, markStorageFailure, inspectProtocolMessage, planAwarenessUpdate, rejectionCounters, PUBLIC_WALL, Y }) {
  const { MAX_PENDING_STORE_OPS, MAX_PENDING_STORE_BYTES, MAX_DB_BYTES, MAX_DOCUMENT_BYTES, MAX_ACTIVE_DOCUMENT_BYTES, ROOM_MAX_UNCOMPACTED_UPDATES, ROOM_MAX_UNCOMPACTED_BYTES } = config;
  const { usageFor } = accounting;

  const admitSyncUpdate = (doc, docName, inspection) => {
    const usage = usageFor(doc);
    const churn = persistenceChurnFor(docName);
    const estimatedStoreBytes = inspection.updateBytes + STORE_OPERATION_OVERHEAD_BYTES;
    if (accounting.pendingStoreOps >= MAX_PENDING_STORE_OPS
        || accounting.pendingStoreBytes + estimatedStoreBytes > MAX_PENDING_STORE_BYTES) {
      rejectionCounters.storageBacklog();
      throw new Error('persistence backlog');
    }
    if (accounting.dbUsageBytes + accounting.pendingStoreBytes + estimatedStoreBytes > MAX_DB_BYTES) {
      markStorageFailure(new Error('configured database quota exceeded'));
      throw new Error('database capacity reached');
    }
    if (usage.upperBytes + inspection.updateBytes > MAX_DOCUMENT_BYTES) {
      scheduleRoomCompaction(docName, { remeasure: true });
      throw Object.assign(new Error('document conservative limit'), { closeCode: 1009 });
    }
    if (accounting.activeDocumentBytes + inspection.updateBytes > MAX_ACTIVE_DOCUMENT_BYTES) {
      scheduleRoomCompaction(docName, { remeasure: true });
      throw Object.assign(new Error('active document capacity reached'), { closeCode: 1009 });
    }
    if (churn.uncompactedUpdates + 1 > ROOM_MAX_UNCOMPACTED_UPDATES) {
      scheduleRoomCompaction(docName, { remeasure: true });
      throw new Error('room persistence compacting');
    }
    if (churn.uncompactedBytes + inspection.updateBytes + STORE_OPERATION_OVERHEAD_BYTES > ROOM_MAX_UNCOMPACTED_BYTES) {
      scheduleRoomCompaction(docName, { remeasure: true });
      throw new Error('room persistence compacting');
    }
  };

  const admitSyncResponse = (doc, meter) => {
    const usage = usageFor(doc);
    const estimatedBytes = Math.min(
      MAX_DOCUMENT_BYTES,
      Math.max(usage.upperBytes, usage.exactBytes),
    );
    if (!meter.takeSyncResponse(estimatedBytes)) {
      throw new Error('sync response rate-limit');
    }
  };

  const inspectMessage = (data, { doc, docName, conn, context, meter, clientIp }) => {
    const inspection = inspectProtocolMessage(data);
    let awarenessPlan = null;
    if (inspection.kind === 'sync-update') {
      admitSyncUpdate(doc, docName, inspection);
    } else if (inspection.kind === 'sync-step-1') {
      admitSyncResponse(doc, meter);
    } else if (inspection.kind === 'awareness') {
      awarenessPlan = planAwarenessUpdate(doc, conn, context, inspection.entries);
      if (awarenessPlan.dropFrame) return { inspection, awarenessPlan };
    }
    if (PUBLIC_WALL && inspection.kind === 'sync-update' && !admitPublicAction(Y, doc, clientIp, data)) throw Object.assign(new Error(PUBLIC_ACTION_LIMIT_REASON), { closeReason: PUBLIC_ACTION_LIMIT_REASON });
    return { inspection, awarenessPlan };
  };

  return { inspectMessage };
}
