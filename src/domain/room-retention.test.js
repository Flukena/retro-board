import test from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_ROOM_RETENTION_DAYS, idleRoomCandidates, lastRoomUseAt } from './room-retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2);
const daysAgo = (days) => NOW - days * DAY_MS;
const room = (handle, fields = {}) => ({
  handle, createdAt: null, lastSessionAt: null, lastActiveAt: null, trackedSinceAt: null, connections: 0, resident: false, ...fields,
});
const handles = (rooms) => rooms.map((entry) => entry.handle);

test('retention window is sixty days', () => {
  assert.equal(IDLE_ROOM_RETENTION_DAYS, 60);
});

test('a room is idle only when its latest recorded use is older than sixty days', () => {
  const rooms = [
    room('old', { createdAt: daysAgo(90), lastSessionAt: daysAgo(70), lastActiveAt: daysAgo(61) }),
    room('recent', { createdAt: daysAgo(59) }),
    room('reopened', { createdAt: daysAgo(200), lastActiveAt: daysAgo(10) }),
    room('rejoined', { createdAt: daysAgo(200), lastSessionAt: daysAgo(30) }),
  ];
  assert.deepEqual(handles(idleRoomCandidates(rooms, NOW).idle), ['old']);
});

test('connected or loaded rooms are never idle, however old', () => {
  const rooms = [
    room('connected', { createdAt: daysAgo(100), connections: 1 }),
    room('resident', { createdAt: daysAgo(100), resident: true }),
  ];
  assert.deepEqual(idleRoomCandidates(rooms, NOW), { idle: [], unknownAge: [] });
});

test('rooms without any recorded time are reported apart, not retired', () => {
  const rooms = [room('legacy'), room('garbage', { createdAt: -5, lastActiveAt: Number.NaN })];
  const { idle, unknownAge } = idleRoomCandidates(rooms, NOW);
  assert.deepEqual(idle, []);
  assert.deepEqual(handles(unknownAge), ['legacy', 'garbage']);
});

test('a room older than tracking is idle sixty days after tracking began', () => {
  const rooms = [room('quiet', { trackedSinceAt: daysAgo(61) }), room('fresh', { trackedSinceAt: daysAgo(30) })];
  const { idle, unknownAge } = idleRoomCandidates(rooms, NOW);
  assert.deepEqual(handles(idle), ['quiet']);
  assert.deepEqual(unknownAge, []);
});

test('latest use ignores missing or invalid times', () => {
  assert.equal(lastRoomUseAt(room('r', { createdAt: daysAgo(5), lastActiveAt: 'soon' })), daysAgo(5));
  assert.equal(lastRoomUseAt(room('r')), null);
});
