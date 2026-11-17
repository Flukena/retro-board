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
const imageOf = (label) => `${handleOf(label)}.0a1b.png`;
const QUIET = { log() {} };

function fixture(rooms, { files = [], publicWall = false } = {}) {
  const activity = new Map(rooms.map(({ label, createdAt }) => [docOf(label), { createdAt, lastSessionAt: null, lastActiveAt: null }]));
  const retention = new Map(rooms.map(({ label, guest }) => [docOf(label), guest ? RETENTION_CLASS.GUEST : RETENTION_CLASS.KEPT]));
  const retiredDocs = [];
  const registry = {
    registeredRoomsByHandle: new Map(rooms.map(({ label }) => [handleOf(label), docOf(label)])),
    activity: { get: (docName) => activity.get(docName) },
    ownershipOf: (docName) => ({ retention: retention.get(docName) }),
    async retireRoom(docName) {
      retiredDocs.push(docName);
      const handle = [...this.registeredRoomsByHandle].find(([, name]) => name === docName)[0];
      this.registeredRoomsByHandle.delete(handle);
      return handle;
    },
  };
  const remaining = new Set(files);
  const io = {
    async readdir() { return [...remaining].map((name) => ({ name, isFile: () => true })); },
    async unlink(path) { remaining.delete(path.split('/').at(-1)); },
  };
  let reconciled = 0;
  const context = {
    registry, io, publicWall, log: QUIET, now: NOW, uploadsDir: '/uploads',
    docs: new Map(rooms.filter((r) => r.resident).map(({ label }) => [docOf(label), {}])),
    connections: new Map(rooms.filter((r) => r.connections).map(({ label, connections }) => [docOf(label), connections])),
    blockedRooms: new Map(rooms.map(({ label }) => [docOf(label), NOW])),
    roomPersistenceChurn: new Map(rooms.map(({ label }) => [docOf(label), {}])),
    reconcileUploadUsage: async () => { reconciled += 1; },
  };
  return { context, retiredDocs, remaining, get reconciled() { return reconciled; } };
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

test('retires only rooms idle past sixty days, with their images and per-room state', async () => {
  const f = fixture([
    { label: 'old', createdAt: daysAgo(OLD_DAYS) },
    { label: 'recent', createdAt: daysAgo(RECENT_DAYS) },
    { label: 'live', createdAt: daysAgo(OLD_DAYS), connections: 2 },
    { label: 'loaded', createdAt: daysAgo(OLD_DAYS), resident: true },
    { label: 'legacy', createdAt: null },
  ], { files: [imageOf('old'), imageOf('recent'), 'legacy-upload.png'] });
  const result = await retireIdleRooms(f.context);
  assert.deepEqual(result, { retired: 1, unknownAge: 1, files: 1 });
  assert.deepEqual(f.retiredDocs, [docOf('old')]);
  assert.deepEqual([...f.remaining].sort(), [imageOf('recent'), 'legacy-upload.png'].sort());
  assert.equal(f.context.blockedRooms.has(docOf('old')), false);
  assert.equal(f.context.roomPersistenceChurn.has(docOf('old')), false);
  assert.equal(f.context.blockedRooms.has(docOf('recent')), true);
  assert.equal(f.reconciled, 1);
});

test('retirement also deletes the room\'s encrypted blob files and leaves other rooms\' blobs', async () => {
  const blobOf = (label) => `${handleOf(label)}.123e4567-e89b-12d3-a456-426614174000.e2e`;
  const f = fixture([
    { label: 'old', createdAt: daysAgo(OLD_DAYS) },
    { label: 'recent', createdAt: daysAgo(RECENT_DAYS) },
  ], { files: [blobOf('old'), imageOf('old'), blobOf('recent')] });
  const result = await retireIdleRooms(f.context);
  assert.deepEqual(result, { retired: 1, unknownAge: 0, files: 2 });
  assert.deepEqual([...f.remaining], [blobOf('recent')]);
});

test('a room opened after the candidates were chosen is kept', async () => {
  const f = fixture([{ label: 'first', createdAt: daysAgo(OLD_DAYS) }, { label: 'second', createdAt: daysAgo(OLD_DAYS) }]);
  const retire = f.context.registry.retireRoom.bind(f.context.registry);
  f.context.registry.retireRoom = async (docName) => {
    const handle = await retire(docName);
    f.context.docs.set(docOf('second'), {});
    return handle;
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

test('every retired room, and only those, is handed to forgetRoom so encrypted-room memory goes too', async () => {
  const f = fixture([
    { label: 'old', createdAt: daysAgo(OLD_DAYS) },
    { label: 'recent', createdAt: daysAgo(RECENT_DAYS) },
    { label: 'live', createdAt: daysAgo(OLD_DAYS), connections: 1 },
  ]);
  const forgotten = [];
  await retireIdleRooms({ ...f.context, forgetRoom: (docName) => forgotten.push(docName) });
  assert.deepEqual(forgotten, [docOf('old')]);
});
