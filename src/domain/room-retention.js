// Which rooms the owner may retire as unused. Shared by the maintainer console
// preview and the relay, so the list shown is the list deleted.
export const IDLE_ROOM_RETENTION_DAYS = 60;
export const MILLISECONDS_PER_DAY = 86_400_000;
export const IDLE_ROOM_RETENTION_MS = IDLE_ROOM_RETENTION_DAYS * MILLISECONDS_PER_DAY;

const knownTime = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

// Latest recorded use of a room, or null when nothing was ever recorded.
// trackedSinceAt is when the relay began tracking a room older than tracking.
export function lastRoomUseAt(room) {
  const times = [room.createdAt, room.lastSessionAt, room.lastActiveAt, room.trackedSinceAt].map(knownTime).filter((time) => time !== null);
  return times.length ? Math.max(...times) : null;
}

// Rooms with no recorded time are never guessed old: they are reported apart.
export function idleRoomCandidates(rooms, now) {
  const idle = [];
  const unknownAge = [];
  for (const room of rooms) {
    if (room.connections > 0 || room.resident) continue;
    const lastUse = lastRoomUseAt(room);
    if (lastUse === null) unknownAge.push(room);
    else if (now - lastUse > IDLE_ROOM_RETENTION_MS) idle.push(room);
  }
  return { idle, unknownAge };
}
