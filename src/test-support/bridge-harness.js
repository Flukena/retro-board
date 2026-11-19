import * as Y from 'yjs';
import { createServer } from 'vite';
import { createRoomLock } from '../client/room-lock/e2e-crypto.js';
import { fakeLockedRelay, LOCKED_TEST_CODE, LOCKED_TEST_TOKEN } from './fake-locked-relay.js';

const SESSION_TTL_MS = 60_000;
export const ROOM_HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
export const VALID_ITEM = { id: 'valid', type: 'sticky', x: 20, y: 30, text: 'Keep me', authorName: 'Alice' };
class OfflineSocket {
  close() { /* Transport fixture never opens a socket. */ }
  send() { /* Offline transport deliberately cannot deliver updates. */ }
}

const LOCK_PASSWORD = 'correct horse battery staple';
export const LOCKED_EPOCH = 1;
export const ROOM_KEY_CHANGED_EVENT = 'retroroom:room-key-changed';

const BOARD_URL = 'http://localhost:5180/b/TEST#Abcdefgh12345678';
const PUBLIC_WALL_URL = 'http://localhost:5180/public';
// The home page: the bridge installs its no-op stub there and never needs a room session.
const LANDING_URL = 'http://localhost:5180/';

export async function unlockLockedRoom(server) {
  const { lock, authKey } = await createRoomLock(LOCK_PASSWORD);
  globalThis.fetch = fakeLockedRelay({ lock, authKey, keyEpoch: LOCKED_EPOCH }).fetch;
  const lockSession = await server.ssrLoadModule('/src/client/room-lock/lock-session.js');
  await lockSession.unlockRoom({
    code: LOCKED_TEST_CODE, token: LOCKED_TEST_TOKEN, password: LOCK_PASSWORD, lockHint: { salt: lock.salt, kdf: lock.kdf },
  });
  return lockSession;
}

function routeUrl({ publicWall, landing }) {
  if (landing) return LANDING_URL;
  return publicWall ? PUBLIC_WALL_URL : BOARD_URL;
}

async function establishSession(server, session, { publicWall, locked }) {
  if (publicWall) await session.establishPublicSession();
  else if (locked) await unlockLockedRoom(server);
  else await session.establishRoomSession('TEST', 'Abcdefgh12345678');
}

export async function withStorage(check, { publicWall = false, locked = false, landing = false } = {}) {
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const cache = new Map();
  const browser = new EventTarget();
  browser.location = new URL(routeUrl({ publicWall, landing }));
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
    const session = await server.ssrLoadModule('/src/client/session/room-session.js');
    globalThis.setTimeout = (...args) => { refreshTimer = originalTimeout(...args); return refreshTimer; };
    if (!landing) await establishSession(server, session, { publicWall, locked });
    globalThis.setTimeout = originalTimeout;
    await server.ssrLoadModule('/src/client/session/storage-bridge.js');
    await check(browser, cache, server);
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

export function putItem(browser, item) {
  const map = new Y.Map(Object.entries(item).filter(([key]) => key !== 'id'));
  browser.__rbYItems.set(item.id, map);
}
