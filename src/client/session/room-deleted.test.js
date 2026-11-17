import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON } from '../../domain/room-ownership.js';
import { createRoomDeletedState, forgetWhenDeleted, isRoomDeletedClose } from './room-deleted.js';

const CODE = 'Ab3dEf7h';
const TOKEN = 'tok12345tok12345';
const NORMAL_CLOSE_CODE = 1000;
const ABNORMAL_CLOSE_CODE = 1006;

test('only the relay room-deleted close counts as a deletion', () => {
  assert.equal(isRoomDeletedClose({ code: ROOM_DELETED_CLOSE_CODE, reason: ROOM_DELETED_REASON }), true);
  assert.equal(isRoomDeletedClose({ code: NORMAL_CLOSE_CODE }), false);
  assert.equal(isRoomDeletedClose({ code: ABNORMAL_CLOSE_CODE }), false);
  assert.equal(isRoomDeletedClose(undefined), false);
});

test('the deleted state is terminal and notifies each listener once', () => {
  const state = createRoomDeletedState();
  let calls = 0;
  const unsubscribe = state.subscribe(() => { calls += 1; });
  assert.equal(state.isDeleted(), false);
  state.mark();
  state.mark();
  assert.equal(state.isDeleted(), true);
  assert.equal(calls, 1);
  unsubscribe();
});

test('the deleted room is forgotten from recents with its own code and token', () => {
  const state = createRoomDeletedState();
  const forgotten = [];
  const forget = (code, token) => forgotten.push([code, token]);
  const stop = forgetWhenDeleted(state, { code: CODE, token: TOKEN, forget });
  assert.deepEqual(forgotten, [], 'a live room stays in recents');
  state.mark();
  assert.deepEqual(forgotten, [[CODE, TOKEN]]);
  stop();
  forgetWhenDeleted(state, { code: CODE, token: TOKEN, forget });
  assert.deepEqual(forgotten, [[CODE, TOKEN], [CODE, TOKEN]], 'an already deleted room is forgotten at once');
});
