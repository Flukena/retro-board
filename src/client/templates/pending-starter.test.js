import test from 'node:test';
import assert from 'node:assert/strict';
import { savePendingStarter, seedPendingStarter, takePendingStarter, whenReadyAndSynced } from './pending-starter.js';
import { STARTER_FORMAT } from './starter-formats.js';

const memoryStorage = () => {
  const data = new Map();
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) };
};
const roomWith = (items) => ({ get: async (key, shared) => (key === 'boardState' && shared ? { value: { items } } : null) });

test('an empty new room gets its format laid out exactly once', async () => {
  const localStore = memoryStorage();
  savePendingStarter('Room1234', STARTER_FORMAT.FOUR_LS, localStore);
  const applied = [];
  const first = await seedPendingStarter({ storage: roomWith([]), code: 'Room1234', applyTemplate: (template) => applied.push(template), localStore });
  const second = await seedPendingStarter({ storage: roomWith([]), code: 'Room1234', applyTemplate: (template) => applied.push(template), localStore });
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].zones.length, 4);
});

test('a room that already has content is never laid out over, and the pending format is dropped', async () => {
  const localStore = memoryStorage();
  savePendingStarter('Room1234', STARTER_FORMAT.MAD_SAD_GLAD, localStore);
  const applied = [];
  const seeded = await seedPendingStarter({ storage: roomWith([{ id: 'a', type: 'sticky', x: 0, y: 0 }]), code: 'Room1234', applyTemplate: (template) => applied.push(template), localStore });
  assert.equal(seeded, false);
  assert.equal(applied.length, 0);
  assert.equal(takePendingStarter('Room1234', localStore), null);
});

test('rooms opened without a pending format, and unknown formats, are left alone', async () => {
  const localStore = memoryStorage();
  savePendingStarter('Other999', 'not-a-format', localStore);
  const applied = [];
  for (const code of ['Room1234', 'Other999']) {
    assert.equal(await seedPendingStarter({ storage: roomWith([]), code, applyTemplate: (template) => applied.push(template), localStore }), false);
  }
  assert.equal(applied.length, 0);
});

test('pending formats are kept per room and bounded', () => {
  const localStore = memoryStorage();
  for (let index = 0; index < 30; index += 1) savePendingStarter(`Room${1000 + index}`, STARTER_FORMAT.MAD_SAD_GLAD, localStore);
  assert.equal(Object.keys(JSON.parse(localStore.getItem('rb_pending_starters'))).length, 20);
  assert.equal(takePendingStarter('Room1029', localStore), STARTER_FORMAT.MAD_SAD_GLAD);
  assert.equal(takePendingStarter('Room1000', localStore), null);
});

test('the layout waits until the board has mounted and the room has synced, then runs once', () => {
  let synced = false;
  let onSynced = null;
  const liveStorage = { synced: () => synced, onSynced: (handler) => { onSynced = handler; return () => { onSynced = null; }; } };
  let seeds = 0;
  const seed = () => { seeds += 1; };
  whenReadyAndSynced({ ready: false, liveStorage, seed })();
  assert.equal(onSynced, null, 'nothing waits while the board is still loading');
  const cleanup = whenReadyAndSynced({ ready: true, liveStorage, seed });
  assert.equal(seeds, 0, 'not before the room syncs');
  synced = true; onSynced(); onSynced();
  assert.equal(seeds, 1);
  cleanup();
  assert.equal(onSynced, null);
  whenReadyAndSynced({ ready: true, liveStorage, seed });
  assert.equal(seeds, 2, 'an already-synced room seeds at once');
});
