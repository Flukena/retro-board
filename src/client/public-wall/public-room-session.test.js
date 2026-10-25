import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Observable } from 'lib0/observable';
import { attachClientSync } from '../session/client-sync.js';

const HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
test('public bootstrap exchanges no capability and uses public paths including refresh', async () => {
  globalThis.window = { location: { pathname: '/public', origin: 'https://retro.example', host: 'retro.example', hostname: 'retro.example', protocol: 'https:' } };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ roomHandle: HANDLE, expiresAt: Date.now() + 60000 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const session = await import('../session/room-session.js');
  try {
    const { establishPublicRoomSession } = await import('./public-room-session.js');
    const value = await establishPublicRoomSession();
    assert.equal(value.roomHandle, HANDLE);
    assert.equal(session.getActiveRoomSession().roomHandle, HANDLE);
    assert.equal(session.getRoomWebSocketBaseUrl(), 'wss://retro.example/yjs-public/rooms');
    await session.refreshActiveRoomSession();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://retro.example/yjs-public/api/public-session');
    assert.equal(requests[1].url, `https://retro.example/yjs-public/rooms/${HANDLE}/public-session`);
    for (const request of requests) {
      assert.equal(request.init.body, '{}');
      assert.equal(request.init.credentials, 'include');
    }
  } finally {
    session.clearRoomSession?.();
    globalThis.fetch = originalFetch;
    delete globalThis.window;
  }
});

const REPLACEMENT_HANDLE = 'Zbcdefghijklmnopqrstuvwxyz012345';
const RECOVERY_TEST_TIMEOUT_MS = 1000;
const RECOVERY_EVENT_TIMEOUT_MS = 500;
for (const [retiredStatus, socketRejection] of [[401, false], [404, false], [404, true]]) {
  test(`retired public session ${retiredStatus}${socketRejection ? ' after socket rejection' : ''} re-establishes and reloads without reconnecting its stale document`, { timeout: RECOVERY_TEST_TIMEOUT_MS }, async t => {
    const session = await import('../session/room-session.js');
    const originalFetch = globalThis.fetch;
    const requests = [];
    let reloaded = false;
    globalThis.window = { location: { pathname: '/public', origin: 'https://retro.example', host: 'retro.example', hostname: 'retro.example', protocol: 'https:' } };
    globalThis.fetch = async url => {
      requests.push(url);
      if (url.includes(`/rooms/${HANDLE}/`)) return new Response(null, { status: retiredStatus });
      const roomHandle = requests.length === 1 ? HANDLE : REPLACEMENT_HANDLE;
      return new Response(JSON.stringify({ roomHandle, expiresAt: Date.now() + 60000 }), { headers: { 'content-type': 'application/json' } });
    };
    const doc = new Y.Doc();
    const provider = new Observable();
    provider.wsconnected = false;
    provider.synced = false;
    let disconnects = 0;
    let connects = 0;
    provider.disconnect = () => { disconnects++; };
    provider.connect = () => { connects++; };
    const browser = new EventTarget();
    let finishedReload;
    const reload = new Promise(resolve => { finishedReload = resolve; });
    browser.location = { reload() { reloaded = true; finishedReload(); } };
    t.after(() => { doc.destroy(); session.clearRoomSession(); globalThis.fetch = originalFetch; delete globalThis.window; });
    await session.establishPublicSession();
    attachClientSync(provider, doc, browser);
    doc.getMap('items').set('stale', 'post-vandalism state');
    if (socketRejection) {
      provider.emit('connection-error', [{}]);
      let deadline;
      try {
        await Promise.race([reload, new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Socket rejection did not trigger public re-entry')), RECOVERY_EVENT_TIMEOUT_MS);
        })]);
      } finally { clearTimeout(deadline); }
    } else await session.refreshActiveRoomSession();
    assert.equal(session.getActiveRoomSession().roomHandle, REPLACEMENT_HANDLE);
    assert.equal(reloaded, true);
    assert.equal(disconnects, 1);
    assert.equal(connects, 0);
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    browser.dispatchEvent(beforeUnload);
    assert.equal(beforeUnload.defaultPrevented, false, 'stale unsynced changes must not block the recovery reload');
    assert.deepEqual(requests.map(url => new URL(url).pathname), ['/yjs-public/api/public-session', `/yjs-public/rooms/${HANDLE}/public-session`, '/yjs-public/api/public-session']);
  });
}

test('failed public re-entry reports session loss and does not reload into a rejected room', async t => {
  const session = await import('../session/room-session.js');
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.window = { location: { pathname: '/public', origin: 'https://retro.example', host: 'retro.example', hostname: 'retro.example', protocol: 'https:' } };
  globalThis.fetch = async url => {
    requests++;
    if (requests === 1) return new Response(JSON.stringify({ roomHandle: HANDLE, expiresAt: Date.now() + 60000 }), { headers: { 'content-type': 'application/json' } });
    return new Response(null, { status: url.includes('/rooms/') ? 404 : 503 });
  };
  t.after(() => { session.clearRoomSession(); globalThis.fetch = originalFetch; delete globalThis.window; });
  await session.establishPublicSession();
  await assert.rejects(session.refreshActiveRoomSession());
  assert.equal(requests, 3);
  assert.equal(session.getRoomSessionHealth(), session.ROOM_SESSION_HEALTH.LOST);
  assert.equal(session.getActiveRoomSession().roomHandle, HANDLE);
});
