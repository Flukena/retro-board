import { E2E_ROOM_FULL_EVENT, E2E_SKIPPED_EVENT } from '../session/e2e-provider.js';

export const ROOM_LOCK_DIALOG = Object.freeze({ PASSWORD: 'password', ROTATE: 'rotate' });
export const ROOM_LOCK_NOTICE = Object.freeze({
  PASSWORD_CHANGED: 'roomLock.change.done',
  SKIPPED: 'roomLock.notice.skipped',
  ROOM_FULL: 'roomLock.notice.roomFull',
});

function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      listeners.forEach((listener) => listener());
    },
  };
}

/**
 * Which owner dialog is open. The menu lives in a popover that closes on click, so the dialogs are hosted
 * outside it and opened through this store.
 */
export const roomLockDialog = createStore(null);

/** The notice (an i18n key) the board shows for a while, or null. */
export const roomLockNotice = createStore(null);

const NOTICE_BY_EVENT = new Map([[E2E_SKIPPED_EVENT, ROOM_LOCK_NOTICE.SKIPPED], [E2E_ROOM_FULL_EVENT, ROOM_LOCK_NOTICE.ROOM_FULL]]);

/** Turns the encrypted provider's skipped-change and room-full events (on `target`) into notices; returns the unsubscribe. */
export function listenForE2ENotices(target) {
  const onEvent = (event) => roomLockNotice.set(NOTICE_BY_EVENT.get(event.type));
  NOTICE_BY_EVENT.forEach((_notice, type) => target.addEventListener(type, onEvent));
  return () => NOTICE_BY_EVENT.forEach((_notice, type) => target.removeEventListener(type, onEvent));
}
