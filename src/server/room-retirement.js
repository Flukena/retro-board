import { idleRoomCandidates } from '../domain/room-retention.js';
import { roomLogId } from './relay-log-id.js';

const SWEEP_LOG = '[yjs] idle room sweep';
const ROOM_FAILED_LOG = '[yjs] idle room retirement failed';

// One room's row, read now; null once the room is no longer registered.
function roomRow({ registry, docs, connections }, handle, docName) {
  const ownership = registry.ownershipOf(docName);
  if (!ownership) return null;
  return {
    handle,
    docName,
    ...registry.activity.get(docName),
    connections: connections.get(docName) ?? 0,
    resident: docs.has(docName),
    retention: ownership.retention,
  };
}

// Rows in the same shape the maintainer console previews, keyed back to documents.
export function roomRows(context) {
  return [...context.registry.registeredRoomsByHandle].map(([handle, docName]) => roomRow(context, handle, docName));
}

/**
 * Retires the given candidate rows through the shared deleter, one room at a time; a room that fails or times out is
 * logged and left for the deletion journal, and the walk goes on. `select(rows)` is the rule that chose the candidates:
 * each room's row is read again and re-checked against it right before the deleter fences it, so a room visited,
 * opened or re-classed since the candidates were chosen stays.
 */
export async function retireCandidates(context, candidates, select) {
  const { deleteRoom, log } = context;
  let retired = 0;
  let files = 0;
  for (const { handle, docName } of candidates) {
    const row = roomRow(context, handle, docName);
    if (!row || select([row]).length === 0) continue;
    try {
      const result = await deleteRoom(docName);
      if (!result.deleted) continue;
      retired += 1;
      files += result.files;
    } catch (error) {
      log.error(ROOM_FAILED_LOG, { docName: roomLogId(docName), err: error.message });
    }
  }
  return { retired, files };
}

/**
 * Retires every room idle past its retention window (guest rooms 24 h, others 60 days). Never touches the Public Wall
 * relay, connected or loaded rooms, or rooms with no recorded time.
 * Ports: registry (rows), docs, connections, deleteRoom(docName) → { deleted, files }.
 */
export async function retireIdleRooms(context) {
  const { publicWall, log, now = Date.now() } = context;
  if (publicWall) return { retired: 0, unknownAge: 0, files: 0 };
  const { idle, unknownAge } = idleRoomCandidates(roomRows(context), now);
  const { retired, files } = await retireCandidates(context, idle, (rows) => idleRoomCandidates(rows, now).idle);
  const result = { retired, unknownAge: unknownAge.length, files };
  log.log(SWEEP_LOG, result);
  return result;
}
