import { ACCOUNT_STATUS, fetchAccount as fetchAccountFromRelay } from './account-api.js';
import { syncSignedInHint } from './signed-in-hint.js';

/**
 * One account session shared by every consumer, so signing out anywhere updates all of them.
 * The snapshot is null until the first load settles.
 */
export function createAccountSessionStore({ fetchAccount, storage }) {
  let session = null;
  let inflight = null;
  const listeners = new Set();

  const publish = (next) => {
    session = next;
    syncSignedInHint(next, storage);
    listeners.forEach((listener) => listener());
  };

  const startFetch = () => {
    const request = fetchAccount().then((next) => {
      if (inflight === request) publish(next);
      return next;
    }).finally(() => {
      if (inflight === request) inflight = null;
    });
    inflight = request;
    return request;
  };

  return {
    getSnapshot: () => session,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load({ force = false } = {}) {
      if (inflight) return inflight;
      if (session && !force) return Promise.resolve(session);
      return startFetch();
    },
    markSignedOut() {
      inflight = null;
      publish({ status: ACCOUNT_STATUS.SIGNED_OUT });
    },
  };
}

// No storage given: the hint helpers fall back to localStorage, guarded for prerender and blocked storage.
export const accountSessionStore = createAccountSessionStore({ fetchAccount: fetchAccountFromRelay });
