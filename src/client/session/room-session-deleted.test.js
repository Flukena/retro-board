import test from 'node:test';
import assert from 'node:assert/strict';
import { pageRoomDeleted } from './room-deleted.js';
import { ROOM_SESSION_HEALTH, establishRoomSession, getRoomSessionHealth, refreshActiveRoomSession } from './room-session.js';

// One test per file: the page's deleted state is terminal for the whole process.
const NOW_MS = 1_700_000_000_000;
const SESSION_TTL_MS = 5_000;
const REFRESH_DELAY_MS = 4_000;
const ALL_TIMERS_MS = 10 * 60 * 1_000;
const HTTP_NOT_FOUND = 404;
const HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const flushRequests = () => new Promise((resolve) => setImmediate(resolve));

test('a session 404 while the room is active counts as deleted and stops every renewal', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW_MS });
  const oldWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5173') };
  t.after(() => {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    if (requests > 1) return new Response('', { status: HTTP_NOT_FOUND });
    return new Response(JSON.stringify({ roomHandle: HANDLE, expiresAt: Date.now() + SESSION_TTL_MS }),
      { headers: { 'content-type': 'application/json' } });
  });

  await establishRoomSession('TEST', 'Abcdefgh12345678');
  assert.equal(pageRoomDeleted.isDeleted(), false, 'the first exchange succeeded');
  t.mock.timers.tick(REFRESH_DELAY_MS);
  await flushRequests();
  assert.equal(requests, 2);
  assert.equal(pageRoomDeleted.isDeleted(), true);
  assert.notEqual(getRoomSessionHealth(), ROOM_SESSION_HEALTH.LOST, 'a deleted room is not shown as a lost connection');

  t.mock.timers.tick(ALL_TIMERS_MS);
  await flushRequests();
  await assert.rejects(refreshActiveRoomSession());
  assert.equal(requests, 2, 'no retry and no renewal after the deletion');
});
