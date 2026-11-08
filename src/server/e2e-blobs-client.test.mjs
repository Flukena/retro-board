import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ORIGIN, PASSWORD, createLockedRoom, lockedRelay } from '../test-support/locked-room-harness.mjs';
import { createRoomLock } from '../client/room-lock/e2e-crypto.js';
import { clearRoomSession, establishRoomSession, roomFetch } from '../client/session/room-session.js';

const ROOM_LOCK = await createRoomLock(PASSWORD);
const CLIENT_DEFAULT_RELAY = 'http://127.0.0.1:1234';
const BLOB = Buffer.alloc(300, 9);
const CREATED = 201;

/**
 * Stands in for the browser around the real client code: a cookie jar, the page's Origin header, the relay's real
 * port, and the password proof the session exchange will carry once the client sends it (it does not yet).
 */
function installBrowserStandIn(t, relayUrl, authKey) {
  const realFetch = globalThis.fetch;
  const jar = new Map();
  globalThis.window = { location: { origin: ORIGIN, hostname: '127.0.0.1', protocol: 'http:', pathname: '/b/room' } };
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url).replace(CLIENT_DEFAULT_RELAY, relayUrl);
    const headers = new Headers(init.headers);
    headers.set('origin', ORIGIN);
    if (jar.size) headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const body = target.endsWith('/api/room-session') ? JSON.stringify({ ...JSON.parse(init.body), authKey }) : init.body;
    const response = await realFetch(target, { ...init, headers, body });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
  t.after(() => {
    clearRoomSession();
    globalThis.fetch = realFetch;
    delete globalThis.window;
  });
}

test('the real client roomFetch uploads and downloads a blob with a header-carried id and the room cookie', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env, ROOM_LOCK);
  installBrowserStandIn(t, env.relay.url, ROOM_LOCK.authKey);
  const session = await establishRoomSession(room.code, room.token);
  assert.equal(session.roomHandle, room.handle);

  const id = randomUUID();
  const created = await roomFetch('e2e-blobs', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-blob-id': id }, body: BLOB,
  });
  assert.equal(created.status, CREATED, env.relay.output());
  assert.deepEqual(await created.json(), { id });

  const fetched = await roomFetch(`e2e-blobs/${id}`);
  assert.equal(fetched.status, 200);
  assert.ok(Buffer.from(await fetched.arrayBuffer()).equals(BLOB));
  const missing = await roomFetch(`e2e-blobs/${randomUUID()}`).catch((error) => error);
  assert.equal(missing.name, 'RoomSessionError', 'a 404 is treated as a rejected session, as for images');
});
