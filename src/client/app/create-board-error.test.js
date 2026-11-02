import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomSessionError, ROOM_SESSION_ERROR } from '../session/room-session.js';
import { createBoardError } from './create-board-error.js';

test('rate-limit errors always carry a positive cooldown for clearing the message', () => {
  assert.deepEqual(createBoardError(new RoomSessionError(ROOM_SESSION_ERROR.RATE_LIMITED)),
    { code: ROOM_SESSION_ERROR.RATE_LIMITED, retryAfterSeconds: 2 });
  assert.deepEqual(createBoardError(new RoomSessionError(ROOM_SESSION_ERROR.RATE_LIMITED, { retryAfterSeconds: 60 })),
    { code: ROOM_SESSION_ERROR.RATE_LIMITED, retryAfterSeconds: 60 });
});
