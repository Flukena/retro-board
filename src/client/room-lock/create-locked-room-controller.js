import { ACCOUNT_STATUS } from '../account/account-api.js';
import { ROOM_PASSWORD_MIN_LENGTH } from '../../domain/room-lock-contract.js';
import { createRoomLock } from './e2e-crypto.js';

export const FORM_ERROR = Object.freeze({
  TOO_SHORT: 'tooShort', MISMATCH: 'mismatch', UNACKNOWLEDGED: 'unacknowledged',
});

const IDLE = Object.freeze({ busy: false });
const codePointLength = (text) => [...text].length;

/** The option exists only for a signed-in account whose plan allows locked rooms. */
export const canOfferLockedRoom = (accountSession) => (
  accountSession?.status === ACCOUNT_STATUS.SIGNED_IN
  && accountSession.account?.entitlements?.canCreateLockedRoom === true
);

/** Every rule the form still fails; an empty list means it can be submitted. */
export function validateLockedRoomForm({ password, confirmation, acknowledged }) {
  const errors = [];
  if (codePointLength(password) < ROOM_PASSWORD_MIN_LENGTH) errors.push(FORM_ERROR.TOO_SHORT);
  if (password !== confirmation) errors.push(FORM_ERROR.MISMATCH);
  if (acknowledged !== true) errors.push(FORM_ERROR.UNACKNOWLEDGED);
  return errors;
}

/**
 * Behind the create-locked-board form: validate, derive the lock (slow KDF, so
 * `busy`), then hand only the public lock record to `createBoard`. The password,
 * key and authKey are never stored; they go out of scope when submit returns.
 */
export function createLockedRoomController() {
  let state = IDLE;
  const listeners = new Set();
  const set = (next) => {
    state = Object.freeze({ ...state, ...next });
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Resolves true when creation was attempted; failures surface through `createBoard`. */
    async submit(form, { name, createBoard }) {
      if (state.busy || validateLockedRoomForm(form).length > 0) return false;
      set({ busy: true });
      try {
        const { lock } = await createRoomLock(form.password);
        await createBoard({ name, lock });
        return true;
      } finally {
        set({ busy: false });
      }
    },
  };
}
