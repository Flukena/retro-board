import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerBoard } from '../../test-support/owner-board-harness.mjs';
import { PASSWORD } from '../../test-support/locked-room-harness.mjs';
import { createRoomLock, deriveRoomSecrets } from './e2e-crypto.js';
import { getRoomKey } from './lock-session.js';
import { refreshActiveRoomSession } from '../session/room-session.js';
import { LOCK_ACTION_ERROR, createRoomLockApi } from './room-lock-api.js';
import { changeRoomPassword } from './change-password.js';
import { ROOM_SESSION_RENEWAL_SUFFIX } from '../../domain/room-lock-contract.js';

const ROOM_LOCK = await createRoomLock(PASSWORD);
const NEW_PASSWORD = 'a changed passphrase';
const THIRD_PASSWORD = 'a third passphrase';
const FORBIDDEN = 403;

const bodyText = ({ body }) => (body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : String(body ?? ''));
// Both the first exchange (/api/room-session) and a renewal (/rooms/<handle>/room-session) end with the suffix.
const sessionBodies = (sent) => sent.filter(({ url }) => url.endsWith(ROOM_SESSION_RENEWAL_SUFFIX)).map((request) => JSON.parse(bodyText(request)));

async function openBoard(t) {
  const board = await ownerBoard(t, { roomLock: ROOM_LOCK, password: PASSWORD });
  return { board, api: createRoomLockApi(getRoomKey().roomHandle) };
}

test('a password change sends no password, and renewals on this page use the new authKey', async (t) => {
  const { board, api } = await openBoard(t);
  const { sent } = board.browser;
  const before = sent.length;
  const revision = getRoomKey().lockRevision;
  await changeRoomPassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, key: getRoomKey(), api });
  const changeRequests = sent.slice(before);
  assert.equal(changeRequests.length, 1);
  assert.match(changeRequests[0].url, /\/api\/rooms\/[A-Za-z0-9_-]{32}\/lock\/password$/);
  for (const request of changeRequests) {
    assert.equal(bodyText(request).includes(PASSWORD), false, 'the current password never leaves the page');
    assert.equal(bodyText(request).includes(NEW_PASSWORD), false, 'nor the new one');
  }
  const key = getRoomKey();
  assert.equal(key.lockRevision, revision + 1);
  assert.equal(key.keyEpoch, 0, 'a password change keeps the room key');
  const { authKey: newAuthKey } = await deriveRoomSecrets(NEW_PASSWORD, key.lock.salt, key.lock.kdf);

  await refreshActiveRoomSession();
  const renewal = sessionBodies(sent).at(-1);
  assert.equal(renewal.authKey, newAuthKey);
  assert.notEqual(renewal.authKey, ROOM_LOCK.authKey);
  await assert.rejects(board.openPeerPage(PASSWORD), { status: FORBIDDEN }, 'the old password no longer opens the room');
  const peer = await board.openPeerPage(NEW_PASSWORD);
  assert.equal(peer.key().keyEpoch, 0);
});

test('a wrong current password is caught on the page and nothing is sent', async (t) => {
  const { board, api } = await openBoard(t);
  const before = board.browser.sent.length;
  await assert.rejects(
    changeRoomPassword({ currentPassword: `${PASSWORD}!`, newPassword: NEW_PASSWORD, key: getRoomKey(), api }),
    { name: 'RoomKeyError', code: 'wrong-password' },
  );
  assert.equal(board.browser.sent.length, before);
});

test('a change built on an older lock revision is refused with a conflict and changes nothing', async (t) => {
  const { board, api } = await openBoard(t);
  const stale = getRoomKey();
  await changeRoomPassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, key: stale, api });
  const current = getRoomKey();
  await assert.rejects(
    changeRoomPassword({ currentPassword: NEW_PASSWORD, newPassword: THIRD_PASSWORD, key: { ...current, lockRevision: stale.lockRevision }, api }),
    (error) => error.name === 'RoomLockActionError' && error.kind === LOCK_ACTION_ERROR.CONFLICT,
  );
  assert.equal(getRoomKey().lockRevision, current.lockRevision);
  await board.openPeerPage(NEW_PASSWORD);
});
