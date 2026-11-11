import { RoomKeyError } from './e2e-crypto.js';
import { FORM_ERROR, validateLockedRoomForm } from './create-locked-room-controller.js';
import { PROMPT_ERROR } from './password-prompt-state.js';
import { LOCK_ACTION_ERROR, RoomLockActionError } from './room-lock-api.js';
import { ROTATION_FAILURE, RotationError } from './rotate-room.js';

export const NEW_PASSWORD_ERROR = Object.freeze({ ...FORM_ERROR, CURRENT_MISSING: 'currentMissing', SAME: 'same' });

/** What a failed owner action shows; `wrong` and `locked-out` are the prompt's own kinds, so its countdown applies. */
export const LOCK_FORM_ERROR = Object.freeze({
  WRONG: PROMPT_ERROR.WRONG,
  LOCKED_OUT: PROMPT_ERROR.LOCKED_OUT,
  LOCK_CHANGED: 'lock-changed',
  BOARD_CHANGED: 'board-changed',
  STORAGE_FULL: 'storage-full',
  TIMEOUT: 'timeout',
  INCOMPLETE: 'incomplete',
  UNKNOWN_OUTCOME: 'unknown-outcome',
  UNAVAILABLE: PROMPT_ERROR.UNAVAILABLE,
});

const FALLBACK_LOCKOUT_SECONDS = 60;

export const EMPTY_NEW_PASSWORD_FORM = Object.freeze({ current: '', password: '', confirmation: '', acknowledged: false });

/** Every rule a new-password form still fails (the create-board rules, plus a current password that differs). */
export function validateNewPasswordForm(form) {
  const errors = validateLockedRoomForm(form);
  if (form.current.length === 0) errors.push(NEW_PASSWORD_ERROR.CURRENT_MISSING);
  else if (form.current === form.password) errors.push(NEW_PASSWORD_ERROR.SAME);
  return errors;
}

const ROTATION_KINDS = new Map([
  [ROTATION_FAILURE.WRONG_PASSWORD, LOCK_FORM_ERROR.WRONG],
  [ROTATION_FAILURE.LOCKED_OUT, LOCK_FORM_ERROR.LOCKED_OUT],
  [ROTATION_FAILURE.LOCK_CHANGED, LOCK_FORM_ERROR.LOCK_CHANGED],
  [ROTATION_FAILURE.BOARD_CHANGED, LOCK_FORM_ERROR.BOARD_CHANGED],
  [ROTATION_FAILURE.STORAGE_FULL, LOCK_FORM_ERROR.STORAGE_FULL],
  [ROTATION_FAILURE.DRAIN_TIMEOUT, LOCK_FORM_ERROR.TIMEOUT],
  [ROTATION_FAILURE.CATCH_UP_TIMEOUT, LOCK_FORM_ERROR.TIMEOUT],
  [ROTATION_FAILURE.INCOMPLETE, LOCK_FORM_ERROR.INCOMPLETE],
  [ROTATION_FAILURE.UNKNOWN_OUTCOME, LOCK_FORM_ERROR.UNKNOWN_OUTCOME],
]);

const ACTION_KINDS = new Map([
  [LOCK_ACTION_ERROR.WRONG_PASSWORD, LOCK_FORM_ERROR.WRONG],
  [LOCK_ACTION_ERROR.LOCKED_OUT, LOCK_FORM_ERROR.LOCKED_OUT],
  [LOCK_ACTION_ERROR.CONFLICT, LOCK_FORM_ERROR.LOCK_CHANGED],
]);

const withSeconds = (kind, retryAfterSeconds) => ({
  kind, seconds: kind === LOCK_FORM_ERROR.LOCKED_OUT ? retryAfterSeconds || FALLBACK_LOCKOUT_SECONDS : 0,
});

/** `{ kind, seconds }` for a failed password change or rotation. */
export function lockFormErrorFor(error) {
  if (error instanceof RoomKeyError && error.code === 'wrong-password') return withSeconds(LOCK_FORM_ERROR.WRONG);
  if (error instanceof RotationError) return withSeconds(ROTATION_KINDS.get(error.kind) ?? LOCK_FORM_ERROR.UNAVAILABLE, error.retryAfterSeconds);
  if (error instanceof RoomLockActionError) return withSeconds(ACTION_KINDS.get(error.kind) ?? LOCK_FORM_ERROR.UNAVAILABLE, error.retryAfterSeconds);
  return withSeconds(LOCK_FORM_ERROR.UNAVAILABLE);
}

const MESSAGE_KEYS = new Map([
  [LOCK_FORM_ERROR.WRONG, 'roomLock.prompt.wrong'],
  [LOCK_FORM_ERROR.LOCKED_OUT, 'roomLock.prompt.lockedOut'],
  [LOCK_FORM_ERROR.LOCK_CHANGED, 'roomLock.manage.lockChanged'],
  [LOCK_FORM_ERROR.BOARD_CHANGED, 'roomLock.rotate.boardChanged'],
  [LOCK_FORM_ERROR.STORAGE_FULL, 'roomLock.rotate.storageFull'],
  [LOCK_FORM_ERROR.TIMEOUT, 'roomLock.rotate.timeout'],
  [LOCK_FORM_ERROR.INCOMPLETE, 'roomLock.rotate.incomplete'],
  [LOCK_FORM_ERROR.UNKNOWN_OUTCOME, 'roomLock.rotate.unknownOutcome'],
  [LOCK_FORM_ERROR.UNAVAILABLE, 'roomLock.manage.unavailable'],
]);

/** The i18n key of a form error, or null. */
export const lockFormMessageKey = (error) => (error ? MESSAGE_KEYS.get(error.kind) ?? MESSAGE_KEYS.get(LOCK_FORM_ERROR.UNAVAILABLE) : null);

/** Only the owner of the open locked room manages its password and key. */
export const canManageRoomLock = (key) => key?.isOwner === true;
