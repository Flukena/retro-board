import test from 'node:test';
import assert from 'node:assert/strict';
import { GuestRoomSweep } from './guest-room-sweep.js';
import { retentionClass } from '../domain/room-ownership.js';
import { GUEST_ROOM_RETENTION_MS, GUEST_SWEEP_INTERVAL_MS } from '../domain/room-retention.js';

const T0 = Date.UTC(2026, 10, 2);
const DAY_MS = 24 * 60 * 60 * 1000;
const FILES_PER_ROOM = 2;
const OLD_AGE_MS = 400 * DAY_MS;
const ACCOUNT_ID = 'a'.repeat(32);
const handleOf = (label) => label.padEnd(32, 'x');
const docOf = (label) => `yjs/board-${label}-abcdefgh12345678`;
const KIND = 'board';
const OWNER_RECORDS = {
  guest: { v: 1, kind: KIND, accountId: null, createdAt: T0 },
  owned: { v: 1, kind: KIND, accountId: ACCOUNT_ID, createdAt: T0 },
  orphaned: { v: 1, kind: KIND, accountId: null, createdAt: T0, orphanedAt: T0 },
  legacy: null,
};

// rooms: { label, owner: guest|owned|orphaned|legacy, connections? } all created at T0.
function fixture(rooms, { publicWall = false, deleteRoom, timing } = {}) {
  const activity = new Map(rooms.map(({ label }) => [docOf(label), { createdAt: T0, lastSessionAt: null, lastActiveAt: null }]));
  const registry = {
    registeredRoomsByHandle: new Map(rooms.map(({ label }) => [handleOf(label), docOf(label)])),
    activity: { get: (docName) => activity.get(docName) },
    ownershipOf: (docName) => {
      const { owner } = rooms.find(({ label }) => docOf(label) === docName);
      return { retention: retentionClass(OWNER_RECORDS[owner]) };
    },
  };
  const retiredDocs = [];
  const logs = [];
  const sweep = new GuestRoomSweep({
    registry, publicWall, docs: new Map(),
    connections: new Map(rooms.filter((r) => r.connections).map(({ label, connections }) => [docOf(label), connections])),
    log: { log: (...args) => logs.push(args), error() {} },
    deleteRoom: deleteRoom ?? (async (docName) => { retiredDocs.push(docName); return { deleted: true, files: FILES_PER_ROOM }; }),
  }, timing);
  return { sweep, retiredDocs, logs, activity };
}

test('a guest room is retired once idle past 24 h, and not before', async () => {
  const f = fixture([{ label: 'guest', owner: 'guest' }]);
  assert.deepEqual(await f.sweep.tick(T0 + GUEST_ROOM_RETENTION_MS), { retired: 0, files: 0 });
  assert.deepEqual(f.retiredDocs, []);
  assert.deepEqual(await f.sweep.tick(T0 + GUEST_ROOM_RETENTION_MS + GUEST_SWEEP_INTERVAL_MS), { retired: 1, files: FILES_PER_ROOM });
  assert.deepEqual(f.retiredDocs, [docOf('guest')]);
});

test('owned, orphaned and legacy rooms survive any age', async () => {
  const f = fixture([{ label: 'owned', owner: 'owned' }, { label: 'orphan', owner: 'orphaned' }, { label: 'legacy', owner: 'legacy' }]);
  assert.deepEqual(await f.sweep.tick(T0 + OLD_AGE_MS), { retired: 0, files: 0 });
  assert.deepEqual(f.retiredDocs, []);
});

test('a hydrated database holding only legacy rooms sweeps nothing', async () => {
  const legacy = ['a', 'b', 'c'].map((label) => ({ label, owner: 'legacy' }));
  const f = fixture(legacy);
  assert.equal((await f.sweep.tick(T0 + OLD_AGE_MS)).retired, 0);
  assert.deepEqual(f.retiredDocs, []);
});

test('a connected guest room survives', async () => {
  const f = fixture([{ label: 'live', owner: 'guest', connections: 1 }]);
  assert.equal((await f.sweep.tick(T0 + OLD_AGE_MS)).retired, 0);
  assert.deepEqual(f.retiredDocs, []);
});

test('the sweep never runs twice concurrently', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const f = fixture([{ label: 'guest', owner: 'guest' }], {
    deleteRoom: async () => { calls += 1; await gate; return { deleted: true, files: 0 }; },
  });
  const now = T0 + OLD_AGE_MS;
  const first = f.sweep.tick(now);
  assert.equal(await f.sweep.tick(now), null, 'a second tick while one runs is skipped');
  release();
  await first;
  assert.equal(calls, 1);
});

test('sweeps at most once per interval and skips the Public Wall relay', async () => {
  const f = fixture([{ label: 'guest', owner: 'guest' }]);
  const now = T0 + OLD_AGE_MS;
  assert.notEqual(await f.sweep.tick(now), null);
  assert.equal(await f.sweep.tick(now + GUEST_SWEEP_INTERVAL_MS - 1), null);
  assert.notEqual(await f.sweep.tick(now + GUEST_SWEEP_INTERVAL_MS), null);
  const wall = fixture([{ label: 'guest', owner: 'guest' }], { publicWall: true });
  assert.equal(await wall.sweep.tick(now), null);
  assert.deepEqual(wall.retiredDocs, []);
});

test('logs one summary line, and only when a room was retired', async () => {
  const f = fixture([{ label: 'guest', owner: 'guest' }, { label: 'owned', owner: 'owned' }]);
  await f.sweep.tick(T0);
  assert.deepEqual(f.logs, []);
  await f.sweep.tick(T0 + GUEST_ROOM_RETENTION_MS + GUEST_SWEEP_INTERVAL_MS);
  assert.equal(f.logs.length, 1);
  assert.deepEqual(f.logs[0][1], { retired: 1, files: FILES_PER_ROOM });
});

test('a configured timing retires sooner and sweeps again after its own interval', async () => {
  const timing = { retentionMs: 1_000, intervalMs: 2_000 };
  const f = fixture([{ label: 'guest', owner: 'guest' }], { timing });
  assert.deepEqual(await f.sweep.tick(T0 + timing.retentionMs), { retired: 0, files: 0 });
  assert.equal(await f.sweep.tick(T0 + timing.retentionMs + timing.intervalMs - 1), null);
  assert.deepEqual(await f.sweep.tick(T0 + timing.retentionMs + timing.intervalMs), { retired: 1, files: FILES_PER_ROOM });
  assert.deepEqual(f.retiredDocs, [docOf('guest')]);
});

test('a guest room visited and left after the candidates were chosen is kept', async () => {
  const now = T0 + OLD_AGE_MS;
  const retiredDocs = [];
  let f;
  const deleteRoom = async (docName) => {
    retiredDocs.push(docName);
    // The visit opened and closed while this deletion ran: only its activity time shows it.
    f.activity.set(docOf('second'), { createdAt: T0, lastSessionAt: now, lastActiveAt: now });
    return { deleted: true, files: FILES_PER_ROOM };
  };
  f = fixture([{ label: 'first', owner: 'guest' }, { label: 'second', owner: 'guest' }], { deleteRoom });
  assert.deepEqual(await f.sweep.tick(now), { retired: 1, files: FILES_PER_ROOM });
  assert.deepEqual(retiredDocs, [docOf('first')]);
});
