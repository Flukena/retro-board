import test from 'node:test';
import assert from 'node:assert/strict';
import { storage, DEFAULT_BOARD, adminRoleStorage } from './room-storage.js';

function withBridge(bridge, check) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = { storage: bridge };
  return Promise.resolve().then(check).finally(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
  });
}

test('memory storage isolates user/shared keys and deletes undefined patch keys', () => withBridge(null, async () => {
  await storage.set('name', 'local', false);
  await storage.set('name', 'room', true);
  assert.deepEqual(await storage.get('name', false), { value: 'local' });
  assert.deepEqual(await storage.get('name', true), { value: 'room' });
  assert.equal(await storage.get('absent', true), null);
  assert.equal(storage.replaceBoard({ ...DEFAULT_BOARD, items: [], title: 'old' }), true);
  assert.equal(storage.addItems([{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }]), true);
  assert.equal(storage.addItems([{ id: 'a' }]), false);
  assert.equal(storage.updateItem('missing', {}), false);
  assert.equal(storage.updateItems([{ id: 'missing', patch: {} }]), false);
  assert.equal(storage.updateItem('a', { text: undefined, w: 20 }), true);
  assert.equal(storage.updateItems([{ id: 'b', patch: { text: 'edited' } }]), true);
  assert.equal(storage.setMeta({ title: undefined }), true);
  storage.removeItem('b');
  const board = (await storage.get('boardState', true)).value;
  assert.equal(Object.hasOwn(board, 'title'), false);
  assert.deepEqual(board.items, [{ id: 'a', w: 20 }]);
}));

test('bridge writes preserve boolean failure and never mutate the fallback after rejection', () => withBridge({
  setMeta: () => false,
  addItem: () => { throw new Error('rejected write'); },
  get: async () => null,
}, async () => {
  assert.equal(storage.setMeta({ title: 'denied' }), false);
  assert.equal(storage.addItem({ id: 'denied' }), false);
  assert.equal(await storage.get('boardState', true), null);
}));

test('failed generic reads/writes use scoped memory and pass shared flags unchanged', () => withBridge({
  get: async () => { throw new Error('offline'); },
  set: async () => { throw new Error('offline'); },
}, async () => {
  await storage.set('offline', 'cached', true);
  assert.deepEqual(await storage.get('offline', true), { value: 'cached' });
}));

test('live admin adapter has stable identity and resolves the bridge on every call', () => withBridge({
  getAdminUserId: () => 'first', synced: () => false,
}, async () => {
  assert.equal(Object.isFrozen(adminRoleStorage), true);
  assert.equal(adminRoleStorage.getAdminUserId(), 'first');
  assert.equal(adminRoleStorage.synced(), false);
  let subscribed;
  let cleaned = false;
  window.storage = { getAdminUserId: () => 'second', synced: () => true,
    onSynced: (handler) => { subscribed = handler; return () => { cleaned = true; }; } };
  assert.equal(adminRoleStorage.getAdminUserId(), 'second');
  assert.equal(adminRoleStorage.synced(), true);
  const handler = () => {};
  const off = adminRoleStorage.onSynced(handler);
  assert.equal(subscribed, handler);
  off();
  assert.equal(cleaned, true);
}));
