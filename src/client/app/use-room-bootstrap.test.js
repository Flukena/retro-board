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
