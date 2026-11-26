import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCK_BYTES, encodeBase64Url } from '../../domain/room-lock-contract.js';
import { rememberedRoomStore } from './remembered-room-store.js';

const CODE = 'mock-room';
const TOKEN = 'browser-fixture-token';
const OTHER_TOKEN = 'different-browser-fixture-token';
const MASTER_KEY_BYTES = 32;
const SALT = encodeBase64Url(new Uint8Array(LOCK_BYTES.salt));
const NEW_SALT = encodeBase64Url(new Uint8Array(LOCK_BYTES.salt).fill(1));
const MASTER_KEY = await crypto.subtle.importKey(
  'raw', new Uint8Array(MASTER_KEY_BYTES), 'HKDF', false, ['deriveBits', 'deriveKey'],
);
const ENTRY = Object.freeze({ salt: SALT, masterKey: MASTER_KEY });

function useIndexedDb(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else delete globalThis.indexedDB;
  });
}

function indexedDbFixture(t) {
  const records = new Map();
  const state = { records, rollback: false, deleteCalls: 0, closes: 0, blocked: null };

  function transaction(_name, mode) {
    const tx = {};
    const pending = [];
    const staged = new Map(records);
    const queue = (apply) => {
      const request = {};
      pending.push(() => {
        request.result = apply();
        request.onsuccess?.();
      });
      return request;
    };
    const store = {
      get: (id) => queue(() => structuredClone(staged.get(id))),
      put: (value, id) => queue(() => {
        assert.equal(mode, 'readwrite');
        staged.set(id, structuredClone(value));
      }),
      delete: (id) => queue(() => {
        assert.equal(mode, 'readwrite');
        state.deleteCalls += 1;
        staged.delete(id);
      }),
    };
    tx.objectStore = () => store;
    queueMicrotask(() => {
      while (pending.length) pending.shift()();
      if (state.rollback) tx.onabort?.();
      else {
        if (mode === 'readwrite') {
          records.clear();
          for (const [id, value] of staged) records.set(id, value);
        }
        tx.oncomplete?.();
      }
    });
    return tx;
  }

  const database = { transaction, close() { state.closes += 1; } };
  useIndexedDb(t, {
    open() {
      const request = { result: database };
      queueMicrotask(() => {
        if (state.blocked) {
          request.onblocked?.();
          state.blocked.push(() => request.onsuccess?.());
        } else request.onsuccess?.();
      });
      return request;
    },
  });
  return state;
}

test('a saved room can be restored only with its exact capability', async (t) => {
  const { records } = indexedDbFixture(t);
  assert.equal(await rememberedRoomStore.read(CODE, TOKEN), null);
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, { ...ENTRY, unexpected: TOKEN }), true);
  assert.equal(await rememberedRoomStore.read(CODE, OTHER_TOKEN), null);
  assert.equal(await rememberedRoomStore.read('other-room', TOKEN), null);
  const restored = await rememberedRoomStore.read(CODE, TOKEN);
  assert.equal(restored.salt, SALT);
  assert.equal(restored.masterKey.extractable, false);
  assert.equal(restored.masterKey.algorithm.name, 'HKDF');
  assert.deepEqual(restored.masterKey.usages.toSorted(), ['deriveBits', 'deriveKey']);
  const [[id, stored]] = records;
  assert.equal(id.includes(TOKEN), false);
  assert.deepEqual(Object.keys(stored).sort(), ['masterKey', 'salt']);
});

test('invalid credentials do not replace a saved key or restore as room access', async (t) => {
  const { records } = indexedDbFixture(t);
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, ENTRY), true);
  const invalid = { salt: SALT, masterKey: {} };
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, invalid), false);
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, { ...ENTRY, salt: 'invalid' }), false);
  assert.equal((await rememberedRoomStore.read(CODE, TOKEN)).salt, SALT);
  records.set(records.keys().next().value, invalid);
  assert.equal(await rememberedRoomStore.read(CODE, TOKEN), null);
});

test('conditional removal keeps a replacement written for a newer salt', async (t) => {
  const state = indexedDbFixture(t);
  assert.equal(await rememberedRoomStore.remove(CODE, TOKEN), true);
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, { ...ENTRY, salt: NEW_SALT }), true);
  assert.equal(await rememberedRoomStore.remove(CODE, TOKEN, SALT), true);
  assert.equal((await rememberedRoomStore.read(CODE, TOKEN)).salt, NEW_SALT);
  assert.equal(state.deleteCalls, 0);
  assert.equal(await rememberedRoomStore.remove(CODE, TOKEN, NEW_SALT), true);
  assert.equal(await rememberedRoomStore.read(CODE, TOKEN), null);
  assert.equal(state.deleteCalls, 1);
});

test('an aborted write does not report persistence after request success', async (t) => {
  const state = indexedDbFixture(t);
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, ENTRY), true);
  state.rollback = true;
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, { ...ENTRY, salt: NEW_SALT }), false);
  assert.equal(await rememberedRoomStore.remove(CODE, TOKEN, SALT), false);
  state.rollback = false;
  assert.equal((await rememberedRoomStore.read(CODE, TOKEN)).salt, SALT);
});

test('blocked opens return promptly and close the eventual connection', async (t) => {
  const state = indexedDbFixture(t);
  state.blocked = [];
  assert.equal(await rememberedRoomStore.read(CODE, TOKEN), null);
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, ENTRY), false);
  assert.equal(await rememberedRoomStore.remove(CODE, TOKEN), false);
  const lateSuccesses = state.blocked;
  state.blocked = null;
  assert.equal(lateSuccesses.length, 3);
  for (const complete of lateSuccesses) complete();
  assert.equal(state.closes, lateSuccesses.length);
  assert.equal(state.records.size, 0);
});

test('storage may be denied without blocking room entry', async (t) => {
  useIndexedDb(t, { open() { throw new DOMException('denied', 'SecurityError'); } });
  assert.equal(await rememberedRoomStore.read(CODE, TOKEN), null);
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, ENTRY), false);
  assert.equal(await rememberedRoomStore.remove(CODE, TOKEN), false);
});

test('device remembering is optional when IndexedDB is unavailable', async (t) => {
  useIndexedDb(t, undefined);
  assert.equal(await rememberedRoomStore.read(CODE, TOKEN), null);
  assert.equal(await rememberedRoomStore.save(CODE, TOKEN, ENTRY), false);
  assert.equal(await rememberedRoomStore.remove(CODE, TOKEN), false);
});
