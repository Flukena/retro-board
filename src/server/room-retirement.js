import { idleRoomCandidates } from '../domain/room-retention.js';
import { roomLogId } from './relay-log-id.js';

const SWEEP_LOG = '[yjs] idle room sweep';
const ROOM_FAILED_LOG = '[yjs] idle room retirement failed';

// Rows in the same shape the maintainer console previews, keyed back to documents.
function roomRows({ registry, docs, connections }) {
  return [...registry.registeredRoomsByHandle].map(([handle, docName]) => ({
    handle,
    docName,
    ...registry.activity.get(docName),
    connections: connections.get(docName) ?? 0,
    resident: docs.has(docName),
    retention: registry.ownershipOf(docName).retention,
  }));
}

/**
 * Retires every room idle past the retention window through the shared deleter, one room at a time; a room that fails
 * or times out is logged and left for the deletion journal, and the sweep goes on. Never touches the Public Wall
 * relay, connected or loaded rooms, or rooms with no recorded time.
 * Ports: registry (rows), docs, connections, deleteRoom(docName) → { deleted, files }.
 */
export async function retireIdleRooms(context) {
  const { docs, connections, publicWall, deleteRoom, log, now = Date.now() } = context;
  if (publicWall) return { retired: 0, unknownAge: 0, files: 0 };
  const { idle, unknownAge } = idleRoomCandidates(roomRows(context), now);
  let retired = 0;
  let files = 0;
  for (const { docName } of idle) {
    // Re-checked just before deleting: a room opened meanwhile stays.
    if (docs.has(docName) || (connections.get(docName) ?? 0) > 0) continue;
    try {
      const result = await deleteRoom(docName);
      if (!result.deleted) continue;
      retired += 1;
      files += result.files;
    } catch (error) {
      log.error(ROOM_FAILED_LOG, { docName: roomLogId(docName), err: error.message });
    }
  }
  const result = { retired, unknownAge: unknownAge.length, files };
  log.log(SWEEP_LOG, result);
  return result;
}
