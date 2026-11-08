import test from 'node:test';
import assert from 'node:assert/strict';

import { ROOM_SESSION_ERROR, RoomSessionError } from '../session/room-session.js';
import { roomBootstrapFailure } from './use-room-bootstrap.js';

test('a rate-limited session keeps its error code and retry delay', () => {
  const error = new RoomSessionError(ROOM_SESSION_ERROR.RATE_LIMITED, { retryAfterSeconds: 7 });
  assert.deepEqual(roomBootstrapFailure(error), { status: ROOM_SESSION_ERROR.RATE_LIMITED, retryAfterSeconds: 7 });
});

test('an unexpected failure is reported as the room being unavailable', () => {
  assert.deepEqual(roomBootstrapFailure(new Error('network down')), { status: ROOM_SESSION_ERROR.UNAVAILABLE, retryAfterSeconds: null });
});

test('a locked room keeps its salt and KDF on the failure, for the password screen', () => {
  const lock = { salt: 'salt', kdf: { name: 'PBKDF2' } };
  const failure = roomBootstrapFailure(new RoomSessionError(ROOM_SESSION_ERROR.LOCKED, { lock }));
  assert.deepEqual(failure, { status: ROOM_SESSION_ERROR.LOCKED, retryAfterSeconds: null, lock });
});
