import { ACCOUNT_STATUS } from './account-api.js';

export const SIGNED_IN_HINT_KEY = 'rb_signed_in';
export const SIGNED_IN_HINT_VALUE = '1';

const defaultStorage = () => {
  try { return globalThis.localStorage; } catch { return undefined; }
};

// Storage can be missing or blocked; the hint is only a convenience, so every failure is swallowed.
export function readSignedInHint(storage = defaultStorage()) {
  try { return storage?.getItem(SIGNED_IN_HINT_KEY) === SIGNED_IN_HINT_VALUE; }
  catch { return false; }
}

export function rememberSignedIn(storage = defaultStorage()) {
  try { storage?.setItem(SIGNED_IN_HINT_KEY, SIGNED_IN_HINT_VALUE); } catch { /* swallow */ }
}

export function forgetSignedIn(storage = defaultStorage()) {
  try { storage?.removeItem(SIGNED_IN_HINT_KEY); } catch { /* swallow */ }
}

/** Keeps the hint in step with a session; an unavailable relay says nothing, so the hint stays. */
export function syncSignedInHint(session, storage = defaultStorage()) {
  if (session?.status === ACCOUNT_STATUS.SIGNED_IN) rememberSignedIn(storage);
  else if (session?.status === ACCOUNT_STATUS.SIGNED_OUT || session?.status === ACCOUNT_STATUS.DISABLED) {
    forgetSignedIn(storage);
  }
}
