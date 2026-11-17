import test from 'node:test';
import assert from 'node:assert/strict';
import { pageRoomDeleted } from './room-deleted.js';
import { establishRoomSession } from './room-session.js';

// One test per file: the page's deleted state is terminal for the whole process.
const NOW_MS = 1_700_000_000_000;
const SESSION_TTL_MS = 60_000;
const HTTP_NOT_FOUND = 404;
const AUTH_KEY_BYTES = 32;
const CODE = 'TEST';
const TOKEN = 'Abcdefgh12345678';
const HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const AUTH_KEY = Buffer.alloc(AUTH_KEY_BYTES, 7).toString('base64url');

test('a 404 to the re-unlock of an active room counts as deleted; a first-visit 404 does not', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW_MS });
  const oldWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5173') };
  t.after(() => {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  let live = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (!live) return new Response('', { status: HTTP_NOT_FOUND });
    return new Response(JSON.stringify({ roomHandle: HANDLE, expiresAt: Date.now() + SESSION_TTL_MS }),
      { headers: { 'content-type': 'application/json' } });
  });

  await assert.rejects(establishRoomSession(CODE, TOKEN));
  assert.equal(pageRoomDeleted.isDeleted(), false, 'an invalid or unknown link is not a deleted room');
  live = true;
  await establishRoomSession(CODE, TOKEN);
  live = false;
  // The owner deleted the room while this page waited on the re-unlock dialog.
  await assert.rejects(establishRoomSession(CODE, TOKEN, { authKey: AUTH_KEY }));
  assert.equal(pageRoomDeleted.isDeleted(), true);
});
