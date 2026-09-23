import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROOM_SESSION_ERROR,
  RoomSessionError,
  normalizeRoomFetchPath,
  validateCreatedRoomResponse,
  validateRoomSessionResponse,
} from './room-session.js';

const TOKEN = 'Abcdefgh12345678';
const HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';

const assertUnavailable = (fn) => assert.throws(fn, (error) => (
  error instanceof RoomSessionError
  && error.code === ROOM_SESSION_ERROR.UNAVAILABLE
  && !error.message.includes(TOKEN)
));

test('validates and narrows room creation responses', () => {
  const response = validateCreatedRoomResponse({
    code: 'ABC12345', token: TOKEN, ignored: 'not retained',
  });
  assert.deepEqual(response, { code: 'ABC12345', token: TOKEN });
  assert.equal(Object.isFrozen(response), true);

  assertUnavailable(() => validateCreatedRoomResponse(null));
  assertUnavailable(() => validateCreatedRoomResponse({ code: 'ab', token: TOKEN }));
  assertUnavailable(() => validateCreatedRoomResponse({ code: 'ABC12345', token: 'short' }));
});

test('accepts only a bounded future session with an exact room handle', () => {
  const now = 1_700_000_000_000;
  const response = validateRoomSessionResponse({
    roomHandle: HANDLE,
    expiresAt: now + 8 * 60 * 60 * 1_000,
    ignored: true,
  }, now);
  assert.deepEqual(response, {
    roomHandle: HANDLE,
    expiresAt: now + 8 * 60 * 60 * 1_000,
  });

  assertUnavailable(() => validateRoomSessionResponse({
    roomHandle: `${HANDLE}x`, expiresAt: now + 1,
  }, now));
  assertUnavailable(() => validateRoomSessionResponse({
    roomHandle: HANDLE, expiresAt: now,
  }, now));
  assertUnavailable(() => validateRoomSessionResponse({
    roomHandle: HANDLE, expiresAt: now + 8 * 24 * 60 * 60 * 1_000,
  }, now));
  assertUnavailable(() => validateRoomSessionResponse({
    roomHandle: HANDLE, expiresAt: now + 1.5,
  }, now));
});

test('normalizes only relative room subpaths', () => {
  assert.equal(normalizeRoomFetchPath('/upload'), '/upload');
  assert.equal(normalizeRoomFetchPath('assets/image'), '/assets/image');

  [
    '', '//evil.example/upload', '../upload', 'a/../upload',
    'upload?token=secret', 'upload#secret', 'upload\\file',
  ].forEach((path) => assertUnavailable(() => normalizeRoomFetchPath(path)));
});

test('typed room errors expose only generic safe metadata', () => {
  const error = new RoomSessionError(ROOM_SESSION_ERROR.RATE_LIMITED, {
    retryAfterSeconds: 12,
  });
  assert.equal(error.code, ROOM_SESSION_ERROR.RATE_LIMITED);
  assert.equal(error.retryAfterSeconds, 12);
  assert.equal(error.message, 'Room access is temporarily rate limited.');
});
