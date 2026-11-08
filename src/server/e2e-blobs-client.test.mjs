import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PASSWORD, createLockedRoom, lockedRelay } from '../test-support/locked-room-harness.mjs';
import { installBrowserStandIn } from '../test-support/browser-stand-in.mjs';
import { createRoomLock } from '../client/room-lock/e2e-crypto.js';
import { establishRoomSession, roomFetch } from '../client/session/room-session.js';

const ROOM_LOCK = await createRoomLock(PASSWORD);
const BLOB = Buffer.alloc(300, 9);
const CREATED = 201;

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
