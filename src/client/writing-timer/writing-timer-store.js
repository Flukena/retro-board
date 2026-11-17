import { WritingTimerClock, decodeWritingTimer, startedWritingTimer } from '../../domain/writing-timer.js';

// Its own root map, outside the board snapshot and the UndoManager's tracked types: starting, extending or stopping
// the timer never reaches anyone's undo history, exports or imports, and travels (encrypted in locked rooms) with the
// rest of the room document.
export const WRITING_TIMER_MAP = 'writingTimer';
const CURRENT_KEY = 'current';
const WRITING_TIMER_ORIGIN = 'writing-timer';

const wallClock = () => Date.now();
const randomId = () => globalThis.crypto.randomUUID();

/**
 * The board's shared card-writing timer on this page. `isLive()` is true while the provider is synced: a change that
 * arrives then is counted from its receipt; one applied during the initial sync or a resync is counted on this page's
 * clock. This page's own writes are always live. Who may start, extend or stop is decided by the caller (admins only).
 */
export function createWritingTimerStore({ doc, isLive, now = wallClock, createId = randomId }) {
  const map = doc.getMap(WRITING_TIMER_MAP);
  const clock = new WritingTimerClock();
  const listeners = new Set();
  const read = (live) => clock.apply(decodeWritingTimer(map.get(CURRENT_KEY)), { live, now: now() });
  const onChange = (event) => {
    read(event.transaction.local || isLive());
    listeners.forEach((listener) => listener());
  };
  const write = (timer) => {
    if (!timer) return false;
    doc.transact(() => map.set(CURRENT_KEY, { ...timer }), WRITING_TIMER_ORIGIN);
    return true;
  };
  read(false);
  map.observe(onChange);
  return {
    view: () => clock.view(now()),
    /** True once, at the end of a timer this page saw running. */
    takeExpiry: () => clock.takeExpiry(now()),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: (minutes) => write(startedWritingTimer(createId(), minutes, now())),
    extend: () => write(clock.extended(now())),
    stop() {
      if (!map.has(CURRENT_KEY)) return false;
      doc.transact(() => map.delete(CURRENT_KEY), WRITING_TIMER_ORIGIN);
      return true;
    },
    destroy() {
      listeners.clear();
      map.unobserve(onChange);
    },
  };
}
