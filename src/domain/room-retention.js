import { RETENTION_CLASS } from './room-ownership.js';

// Which rooms the owner may retire as unused. Shared by the maintainer console
// preview and the relay, so the list shown is the list deleted.
export const IDLE_ROOM_RETENTION_DAYS = 60;
export const MILLISECONDS_PER_DAY = 86_400_000;
export const IDLE_ROOM_RETENTION_MS = IDLE_ROOM_RETENTION_DAYS * MILLISECONDS_PER_DAY;

// Rooms created without signing in (owner decision 2026-11-11).
export const GUEST_ROOM_RETENTION_MS = MILLISECONDS_PER_DAY;

const knownTime = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

// Latest recorded use of a room, or null when nothing was ever recorded.
// trackedSinceAt is when the relay began tracking a room older than tracking.
export function lastRoomUseAt(room) {
  const times = [room.createdAt, room.lastSessionAt, room.lastActiveAt, room.trackedSinceAt].map(knownTime).filter((time) => time !== null);
  return times.length ? Math.max(...times) : null;
}

const retentionMs = (room) => (room.retention === RETENTION_CLASS.GUEST ? GUEST_ROOM_RETENTION_MS : IDLE_ROOM_RETENTION_MS);
const isInUse = (room) => room.connections > 0 || room.resident;

// Rooms with no recorded time are never guessed old: they are reported apart.
// A row without a retention field is a kept room.
export function idleRoomCandidates(rooms, now) {
  const idle = [];
  const unknownAge = [];
  for (const room of rooms) {
    if (isInUse(room)) continue;
    const lastUse = lastRoomUseAt(room);
    if (lastUse === null) unknownAge.push(room);
    else if (now - lastUse > retentionMs(room)) idle.push(room);
  }
  return { idle, unknownAge };
}

// Guest rooms past their 24 h retention; the only rooms the automatic sweep retires.
export const guestRoomCandidates = (rooms, now) => idleRoomCandidates(
  rooms.filter((room) => room.retention === RETENTION_CLASS.GUEST), now,
).idle;
