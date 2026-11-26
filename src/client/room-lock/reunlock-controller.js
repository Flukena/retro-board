import { ROOM_SESSION_HEALTH, getRoomSessionHealth, onRoomSessionHealth } from '../session/room-session.js';
import { KEY_ROTATED_EVENT, reunlock } from './lock-session.js';

/**
 * Decides when the in-page re-unlock dialog is open: while the session needs
 * re-auth, or after a key rotation was announced, until the user unlocks again.
 */
export function createReunlockController(eventTarget) {
  let rotated = false;
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const onRotated = () => {
    rotated = true;
    notify();
  };
  return {
    getSnapshot: () => rotated || getRoomSessionHealth() === ROOM_SESSION_HEALTH.REAUTH_REQUIRED,
    subscribe(listener) {
      listeners.add(listener);
      const stopHealth = onRoomSessionHealth(listener);
      eventTarget.addEventListener(KEY_ROTATED_EVENT, onRotated);
      return () => {
        listeners.delete(listener);
        stopHealth();
        eventTarget.removeEventListener(KEY_ROTATED_EVENT, onRotated);
      };
    },
    /** Re-unlocks with the password; on success the dialog closes even if no health change follows. */
    async unlock(password, remember) {
      const result = await reunlock(password, remember);
      rotated = false;
      notify();
      return result;
    },
  };
}
