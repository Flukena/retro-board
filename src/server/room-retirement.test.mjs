import test from 'node:test';
import assert from 'node:assert/strict';
import { retireIdleRooms } from './room-retirement.js';
import { RETENTION_CLASS } from '../domain/room-ownership.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2);
const OLD_DAYS = 61;
const RECENT_DAYS = 59;
const handleOf = (label) => label.padEnd(32, 'x');
const docOf = (label) => `yjs/board-${label}-abcdefgh12345678`;
const FILES_PER_ROOM = 2;

function fixture(rooms, { publicWall = false, failing = new Set(), timedOut = new Set() } = {}) {
  const activity = new Map(rooms.map(({ label, createdAt }) => [docOf(label), { createdAt, lastSessionAt: null, lastActiveAt: null }]));
  const retention = new Map(rooms.map(({ label, guest }) => [docOf(label), guest ? RETENTION_CLASS.GUEST : RETENTION_CLASS.KEPT]));
  const retiredDocs = [];
  const registry = {
    registeredRoomsByHandle: new Map(rooms.map(({ label }) => [handleOf(label), docOf(label)])),
    activity: { get: (docName) => activity.get(docName) },
    ownershipOf: (docName) => ({ retention: retention.get(docName) }),
  };
  const errors = [];
  const context = {
    registry, publicWall, now: NOW,
    log: { log() {}, error: (...args) => errors.push(args) },
    docs: new Map(rooms.filter((r) => r.resident).map(({ label }) => [docOf(label), {}])),
    connections: new Map(rooms.filter((r) => r.connections).map(({ label, connections }) => [docOf(label), connections])),
    async deleteRoom(docName) {
      if (failing.has(docName)) throw new Error('disk gone');
      if (timedOut.has(docName)) return { deleted: false, status: 503 };
      retiredDocs.push(docName);
      return { deleted: true, files: FILES_PER_ROOM };
    },
  };
  return { context, retiredDocs, errors, activity };
}

const daysAgo = (days) => NOW - days * DAY_MS;
const HOUR_MS = 60 * 60 * 1000;
const GUEST_EXPIRED_HOURS = 25;

test('a guest room idle past a day is retired; a kept room idle as long is not', async () => {
  const f = fixture([
    { label: 'guest', createdAt: NOW - GUEST_EXPIRED_HOURS * HOUR_MS, guest: true },
    { label: 'kept', createdAt: NOW - GUEST_EXPIRED_HOURS * HOUR_MS },
  ]);
  const result = await retireIdleRooms(f.context);
  assert.equal(result.retired, 1);
  assert.deepEqual(f.retiredDocs, [docOf('guest')]);
});

test('retires only rooms idle past sixty days, through the deleter, and counts their files', async () => {
  const f = fixture([
    { label: 'old', createdAt: daysAgo(OLD_DAYS) },
    { label: 'recent', createdAt: daysAgo(RECENT_DAYS) },
    { label: 'live', createdAt: daysAgo(OLD_DAYS), connections: 2 },
    { label: 'loaded', createdAt: daysAgo(OLD_DAYS), resident: true },
    { label: 'legacy', createdAt: null },
  ]);
  const result = await retireIdleRooms(f.context);
  assert.deepEqual(result, { retired: 1, unknownAge: 1, files: FILES_PER_ROOM });
  assert.deepEqual(f.retiredDocs, [docOf('old')]);
});

test('one room that fails or times out does not stop the sweep, and is not counted as retired', async () => {
  const f = fixture([
    { label: 'broken', createdAt: daysAgo(OLD_DAYS) },
    { label: 'busy', createdAt: daysAgo(OLD_DAYS) },
    { label: 'fine', createdAt: daysAgo(OLD_DAYS) },
  ], { failing: new Set([docOf('broken')]), timedOut: new Set([docOf('busy')]) });
  const result = await retireIdleRooms(f.context);
  assert.deepEqual(result, { retired: 1, unknownAge: 0, files: FILES_PER_ROOM });
  assert.deepEqual(f.retiredDocs, [docOf('fine')]);
  assert.equal(f.errors.length, 1, 'the failure is logged');
});

test('a room opened after the candidates were chosen is kept', async () => {
  const f = fixture([{ label: 'first', createdAt: daysAgo(OLD_DAYS) }, { label: 'second', createdAt: daysAgo(OLD_DAYS) }]);
  const remove = f.context.deleteRoom;
  f.context.deleteRoom = async (docName) => {
    const result = await remove(docName);
    f.context.docs.set(docOf('second'), {});
    return result;
  };
  const result = await retireIdleRooms(f.context);
  assert.equal(result.retired, 1);
  assert.deepEqual(f.retiredDocs, [docOf('first')]);
});

test('a room visited and left after the candidates were chosen is kept', async () => {
  const f = fixture([{ label: 'first', createdAt: daysAgo(OLD_DAYS) }, { label: 'second', createdAt: daysAgo(OLD_DAYS) }]);
  const remove = f.context.deleteRoom;
  f.context.deleteRoom = async (docName) => {
    const result = await remove(docName);
    // The visit opened and closed while the first deletion ran: only its activity time shows it.
    f.activity.set(docOf('second'), { ...f.activity.get(docOf('second')), lastSessionAt: NOW, lastActiveAt: NOW });
    return result;
  };
  const result = await retireIdleRooms(f.context);
  assert.equal(result.retired, 1);
  assert.deepEqual(f.retiredDocs, [docOf('first')]);
});

test('the Public Wall relay never retires anything', async () => {
  const f = fixture([{ label: 'wall', createdAt: daysAgo(OLD_DAYS * 10) }], { publicWall: true });
  assert.deepEqual(await retireIdleRooms(f.context), { retired: 0, unknownAge: 0, files: 0 });
  assert.deepEqual(f.retiredDocs, []);
});
