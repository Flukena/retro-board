import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomActivity, ROOM_ACTIVITY_META } from './room-activity.js';

function fixture() {
  const persisted = new Map();
  const writes = [];
  const storage = {
    async getMeta(name) { return persisted.get(name); },
    async setMeta(name, key, value) { assert.equal(key, ROOM_ACTIVITY_META); persisted.set(name, value); writes.push(value); },
  };
  return { activity: new RoomActivity(storage), storage, persisted, writes };
}

test('creation and latest session survive restart; a legacy room records when tracking began, not a creation time', async () => {
  const { activity, storage } = fixture();
  await activity.create('room', 1000);
  activity.touch('room', { session: true, now: 2000 });
  activity.touch('room', { now: 3000 });
  await activity.stop();
  const restored = new RoomActivity(storage);
  await restored.hydrate('room', 4000);
  await restored.hydrate('legacy', 4000);
  assert.deepEqual(restored.get('room'), { createdAt: 1000, lastSessionAt: 2000, lastActiveAt: 3000, trackedSinceAt: null });
  assert.deepEqual(restored.get('legacy'), { createdAt: null, lastSessionAt: null, lastActiveAt: null, trackedSinceAt: 4000 });
  const again = new RoomActivity(storage);
  await again.hydrate('legacy', 9000);
  assert.equal(again.get('legacy').trackedSinceAt, 4000, 'tracking start is recorded once and kept');
});

test('coalesces activity writes, ignores unknown rooms and never moves times backwards', async () => {
  const { activity, writes } = fixture();
  await activity.create('room', 1000);
  for (let now = 2000; now <= 3000; now++) activity.touch('room', { now });
  activity.touch('room', { now: 1500 });
  activity.touch('unknown', { session: true, now: 4000 });
  assert.equal(writes.length, 1);
  await activity.flush();
  await activity.flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].lastActiveAt, 3000);
});

test('failed writes reject and remain pending for retry', async () => {
  const { activity, storage, writes } = fixture();
  await activity.create('room', 1000);
  activity.touch('room', { session: true, now: 2000 });
  const original = storage.setMeta;
  storage.setMeta = async () => { throw new Error('disk failure'); };
  await assert.rejects(activity.flush(), /disk failure/);
  storage.setMeta = original;
  await activity.stop();
  assert.equal(writes.at(-1).lastSessionAt, 2000);
});

test('socket admission and close update session activity without message listeners', async () => {
  const { activity } = fixture();
  await activity.create('room');
  const wss = new EventEmitter();
  wss.clients = new Set();
  activity.watch(wss, assert.fail);
  try {
    const conn = new EventEmitter();
    wss.emit('connection', conn, { wsSecurityContext: { docName: 'room' } });
    assert.ok(activity.get('room').lastSessionAt);
    assert.equal(conn.listenerCount('message'), 0);
    conn.emit('close');
    assert.ok(activity.get('room').lastActiveAt >= activity.get('room').lastSessionAt);
  } finally { await activity.stop(); }
});

test('a touch during an in-flight write remains pending and shutdown flushes it', async () => {
  const { activity, storage, writes } = fixture();
  await activity.create('room', 1000);
  activity.touch('room', { now: 2000 });
  const original = storage.setMeta;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  storage.setMeta = async (...args) => { await blocked; return original(...args); };
  const flushing = activity.flush();
  activity.touch('room', { session: true, now: 3000 });
  const stopping = activity.stop();
  release();
  await Promise.all([flushing, stopping]);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.at(-1), { createdAt: 1000, lastSessionAt: 3000, lastActiveAt: 3000, trackedSinceAt: null });
});

test('invalid legacy metadata is not trusted as a time and rollback drops pending activity', async () => {
  const { activity, persisted, writes } = fixture();
  persisted.set('legacy', { createdAt: -1, lastSessionAt: '1234', lastActiveAt: Infinity });
  await activity.hydrate('legacy', 1500);
  const stamped = { createdAt: null, lastSessionAt: null, lastActiveAt: null, trackedSinceAt: 1500 };
  assert.deepEqual(activity.get('legacy'), stamped);
  activity.touch('legacy', { now: 2000 });
  activity.forget('legacy');
  await activity.stop();
  assert.deepEqual(writes, [stamped]);
});
