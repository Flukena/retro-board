import { join } from 'node:path';
import { idleRoomCandidates } from '../domain/room-retention.js';
import { roomHandleOfImageFile } from './relay-uploads.js';

const SWEEP_LOG = '[yjs] idle room sweep';

// Rows in the same shape the maintainer console previews, keyed back to documents.
function roomRows({ registry, docs, connections }) {
  return [...registry.registeredRoomsByHandle].map(([handle, docName]) => ({
    handle,
    docName,
    ...registry.activity.get(docName),
    connections: connections.get(docName) ?? 0,
    resident: docs.has(docName),
  }));
}

async function removeRoomImages(io, uploadsDir, handles) {
  let removed = 0;
  const entries = await io.readdir(uploadsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !handles.has(roomHandleOfImageFile(entry.name))) continue;
    await io.unlink(join(uploadsDir, entry.name));
    removed += 1;
  }
  return removed;
}

/**
 * Retires every room idle past the retention window. Never touches the Public
 * Wall relay, connected or loaded rooms, or rooms with no recorded time.
 * Ports: registry.retireRoom, io (fs.promises), reconcileUploadUsage(), forgetRoom(docName)
 * for per-room state held outside the registry (the encrypted-room relay).
 */
export async function retireIdleRooms(context) {
  const { registry, docs, connections, blockedRooms, roomPersistenceChurn, publicWall, uploadsDir, io, reconcileUploadUsage, log, forgetRoom = () => {}, now = Date.now() } = context;
  if (publicWall) return { retired: 0, unknownAge: 0, files: 0 };
  const { idle, unknownAge } = idleRoomCandidates(roomRows(context), now);
  const handles = new Set();
  for (const { docName } of idle) {
    // Re-checked in the tick that unpublishes: a room opened meanwhile stays.
    if (docs.has(docName) || (connections.get(docName) ?? 0) > 0) continue;
    const retiring = registry.retireRoom(docName);
    blockedRooms.delete(docName);
    roomPersistenceChurn.delete(docName);
    forgetRoom(docName);
    const handle = await retiring;
    if (handle) handles.add(handle);
  }
  const files = handles.size ? await removeRoomImages(io, uploadsDir, handles) : 0;
  if (files) await reconcileUploadUsage();
  const result = { retired: handles.size, unknownAge: unknownAge.length, files };
  log.log(SWEEP_LOG, result);
  return result;
}
