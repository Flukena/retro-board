import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomKeyError } from './e2e-crypto.js';
import { lockActionErrorForStatus } from './room-lock-api.js';
import { ROTATION_FAILURE, RotationError } from './rotate-room.js';
import {
  EMPTY_NEW_PASSWORD_FORM, LOCK_FORM_ERROR, NEW_PASSWORD_ERROR, canManageRoomLock, lockFormErrorFor, lockFormMessageKey,
  validateNewPasswordForm,
} from './room-lock-form.js';

const valid = { current: 'current password', password: 'new password 1', confirmation: 'new password 1', acknowledged: true };
const RETRY_SECONDS = 42;

test('only the owner of the open locked room gets the menu', () => {
  assert.equal(canManageRoomLock({ isOwner: true }), true);
  for (const key of [null, undefined, {}, { isOwner: false }, { isOwner: 'yes' }]) assert.equal(canManageRoomLock(key), false);
});

test('a new password needs the current one, 10+ characters, a matching confirmation, the acknowledgement, and must differ', () => {
  assert.deepEqual(validateNewPasswordForm(valid), []);
  assert.deepEqual(validateNewPasswordForm({ ...valid, password: 'short', confirmation: 'short' }), [NEW_PASSWORD_ERROR.TOO_SHORT]);
  assert.deepEqual(validateNewPasswordForm({ ...valid, confirmation: 'other' }), [NEW_PASSWORD_ERROR.MISMATCH]);
  assert.deepEqual(validateNewPasswordForm({ ...valid, acknowledged: false }), [NEW_PASSWORD_ERROR.UNACKNOWLEDGED]);
  assert.deepEqual(validateNewPasswordForm({ ...valid, current: valid.password }), [NEW_PASSWORD_ERROR.SAME]);
  assert.ok(validateNewPasswordForm(EMPTY_NEW_PASSWORD_FORM).includes(NEW_PASSWORD_ERROR.CURRENT_MISSING));
});

test('failures map to the message the dialog shows, with the lock-out seconds', () => {
  const cases = [
    [new RoomKeyError('wrong-password'), LOCK_FORM_ERROR.WRONG, 'roomLock.prompt.wrong'],
    [lockActionErrorForStatus(403), LOCK_FORM_ERROR.WRONG, 'roomLock.prompt.wrong'],
    [lockActionErrorForStatus(409), LOCK_FORM_ERROR.LOCK_CHANGED, 'roomLock.manage.lockChanged'],
    [new RotationError(ROTATION_FAILURE.BOARD_CHANGED), LOCK_FORM_ERROR.BOARD_CHANGED, 'roomLock.rotate.boardChanged'],
    [new RotationError(ROTATION_FAILURE.STORAGE_FULL), LOCK_FORM_ERROR.STORAGE_FULL, 'roomLock.rotate.storageFull'],
    [new RotationError(ROTATION_FAILURE.DRAIN_TIMEOUT), LOCK_FORM_ERROR.TIMEOUT, 'roomLock.rotate.timeout'],
    [new RotationError(ROTATION_FAILURE.CATCH_UP_TIMEOUT), LOCK_FORM_ERROR.TIMEOUT, 'roomLock.rotate.timeout'],
    [new RotationError(ROTATION_FAILURE.INCOMPLETE), LOCK_FORM_ERROR.INCOMPLETE, 'roomLock.rotate.incomplete'],
    [new RotationError(ROTATION_FAILURE.CANCELLED), LOCK_FORM_ERROR.UNAVAILABLE, 'roomLock.manage.unavailable'],
    [new TypeError('boom'), LOCK_FORM_ERROR.UNAVAILABLE, 'roomLock.manage.unavailable'],
  ];
  for (const [error, kind, messageKey] of cases) {
    const mapped = lockFormErrorFor(error);
    assert.deepEqual(mapped, { kind, seconds: 0 }, error.message);
    assert.equal(lockFormMessageKey(mapped), messageKey);
  }
  assert.deepEqual(lockFormErrorFor(lockActionErrorForStatus(429, RETRY_SECONDS)), { kind: LOCK_FORM_ERROR.LOCKED_OUT, seconds: RETRY_SECONDS });
  assert.deepEqual(
    lockFormErrorFor(new RotationError(ROTATION_FAILURE.LOCKED_OUT, { retryAfterSeconds: RETRY_SECONDS })),
    { kind: LOCK_FORM_ERROR.LOCKED_OUT, seconds: RETRY_SECONDS },
  );
  assert.equal(lockFormMessageKey(null), null);
});
