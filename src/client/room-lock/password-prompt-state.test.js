import test from 'node:test';
import assert from 'node:assert/strict';

import { ROOM_SESSION_ERROR, RoomSessionError } from '../session/room-session.js';
import { PROMPT_ERROR, promptErrorFor } from './password-prompt-state.js';

const LIMIT_SECONDS = 37;

test('a rejected password is the inline wrong-password error', () => {
  assert.deepEqual(promptErrorFor(new RoomSessionError(ROOM_SESSION_ERROR.WRONG_PASSWORD)), { kind: PROMPT_ERROR.WRONG, seconds: 0 });
});

test('a limited attempt carries the seconds to wait', () => {
  const error = new RoomSessionError(ROOM_SESSION_ERROR.LOCKED_OUT, { retryAfterSeconds: LIMIT_SECONDS });
  assert.deepEqual(promptErrorFor(error), { kind: PROMPT_ERROR.LOCKED_OUT, seconds: LIMIT_SECONDS });
  assert.ok(promptErrorFor(new RoomSessionError(ROOM_SESSION_ERROR.LOCKED_OUT)).seconds > 0, 'a missing delay still blocks submit');
});

test('anything else is unavailable', () => {
  assert.equal(promptErrorFor(new Error('offline')).kind, PROMPT_ERROR.UNAVAILABLE);
  assert.equal(promptErrorFor(new RoomSessionError(ROOM_SESSION_ERROR.RATE_LIMITED)).kind, PROMPT_ERROR.UNAVAILABLE);
});
