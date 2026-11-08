import { PROMPT_ERROR, promptErrorFor } from './password-prompt-state.js';

const COUNTDOWN_TICK_MS = 1_000;
const IDLE = Object.freeze({ busy: false, error: null, lockedOutSeconds: 0 });

/**
 * The behaviour behind a password prompt: submit, busy, error mapping and the
 * lock-out countdown that re-enables submit. `timers` is injectable for tests;
 * `errorFor` maps a failure to `{ kind, seconds }` (forms with more outcomes pass their own).
 */
export function createPasswordPromptController(submitPassword, timers = { setTimeout, clearTimeout }, errorFor = promptErrorFor) {
  let state = IDLE;
  let timer = null;
  const listeners = new Set();
  const set = (next) => {
    state = Object.freeze({ ...state, ...next });
    listeners.forEach((listener) => listener());
  };
  const stopTimer = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const tick = () => {
    timer = null;
    const lockedOutSeconds = state.lockedOutSeconds - 1;
    set({ lockedOutSeconds, error: lockedOutSeconds > 0 ? { kind: PROMPT_ERROR.LOCKED_OUT, seconds: lockedOutSeconds } : null });
    if (lockedOutSeconds > 0) timer = timers.setTimeout(tick, COUNTDOWN_TICK_MS);
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Resolves true when the password opened the room. */
    async submit(password) {
      if (state.busy || state.lockedOutSeconds > 0) return false;
      set({ busy: true, error: null });
      try {
        await submitPassword(password);
        set({ busy: false });
        return true;
      } catch (failure) {
        const error = errorFor(failure);
        set({ busy: false, error, lockedOutSeconds: error.seconds });
        stopTimer();
        if (error.seconds > 0) timer = timers.setTimeout(tick, COUNTDOWN_TICK_MS);
        return false;
      }
    },
    dispose: stopTimer,
  };
}
