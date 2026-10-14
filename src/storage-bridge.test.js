import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createServer } from 'vite';

const SESSION_TTL_MS = 60_000;
const ROOM_HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const VALID_ITEM = { id: 'valid', type: 'sticky', x: 20, y: 30, text: 'Keep me', authorName: 'Alice' };
class OfflineSocket {
  close() { /* Transport fixture never opens a socket. */ }
  send() { /* Offline transport deliberately cannot deliver updates. */ }
}

async function withStorage(check) {
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const cache = new Map();
  const browser = new EventTarget();
  browser.location = new URL('http://localhost:5180/b/TEST#Abcdefgh12345678');
  Object.assign(globalThis, { window: browser, WebSocket: OfflineSocket });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, value),
  } });
  globalThis.fetch = async () => new Response(JSON.stringify({
    roomHandle: ROOM_HANDLE, expiresAt: Date.now() + SESSION_TTL_MS,
  }), { headers: { 'content-type': 'application/json' } });
  const server = await createServer({ configFile: false,
    server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  let refreshTimer;
  const originalTimeout = globalThis.setTimeout;
  try {
    const session = await server.ssrLoadModule('/src/room-session.js');
    globalThis.setTimeout = (...args) => { refreshTimer = originalTimeout(...args); return refreshTimer; };
    await session.establishRoomSession('TEST', 'Abcdefgh12345678');
    globalThis.setTimeout = originalTimeout;
    await server.ssrLoadModule('/src/storage-bridge.js');
    await check(browser, cache);
  } finally {
    globalThis.setTimeout = originalTimeout;
    clearTimeout(refreshTimer);
    browser.__rbProvider?.destroy();
    browser.__rbYDoc?.destroy();
    await server.close();
    for (const key of ['window', 'WebSocket', 'localStorage', 'fetch']) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
}

function putItem(browser, item) {
  const map = new Y.Map(Object.entries(item).filter(([key]) => key !== 'id'));
  browser.__rbYItems.set(item.id, map);
}

test('remote metadata cannot replace the item list', async () => {
  await withStorage(async (browser) => {
    putItem(browser, VALID_ITEM);
    browser.__rbYMeta.set('items', 5);
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    const { value } = await browser.storage.get('boardState', true);
    assert.deepEqual(value.items.map((item) => item.id), ['valid']);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
  });
});

test('remote malformed display values are excluded without changing valid items or canonical data', async () => {
  await withStorage(async (browser) => {
    putItem(browser, VALID_ITEM);
    putItem(browser, { ...VALID_ITEM, id: 'bad-text', text: {} });
    putItem(browser, { ...VALID_ITEM, id: 'bad-author', authorName: {} });
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    const { value } = await browser.storage.get('boardState', true);
    assert.deepEqual(value.items.map((item) => ({ ...item })), [VALID_ITEM]);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
  });
});

test('viewport stays local on write, cached read, cache miss and cache failure', async () => {
  await withStorage(async (browser, cache) => {
    const kv = browser.__rbYDoc.getMap('kv');
    const legacyKey = `u|${browser.__rbClientId}|viewport`;
    const viewport = { x: 40, y: 50, zoom: 2 };
    kv.set(legacyKey, { x: 0, y: 0, zoom: 1 });
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    await browser.storage.set('viewport', viewport, false);
    assert.deepEqual((await browser.storage.get('viewport', false)).value, viewport);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
    cache.clear();
    assert.equal((await browser.storage.get('viewport', false)).value, null);
    globalThis.localStorage.setItem = () => { throw new Error('quota'); };
    await browser.storage.set('viewport', viewport, false);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
  });
});

test('offline local changes expose status and guard unload until a socket sync', async () => {
  await withStorage(async (browser) => {
    const provider = browser.__rbProvider;
    provider.emit('status', [{ status: 'disconnected' }]);
    browser.__rbYDoc.transact(() => putItem(browser, VALID_ITEM), 'local');
    assert.equal(browser.storage.getSyncStatus?.().hasUnsyncedLocalChanges, true);
    const event = new Event('beforeunload', { cancelable: true });
    browser.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  });
});
