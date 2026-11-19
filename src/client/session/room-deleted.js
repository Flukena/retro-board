import { ROOM_DELETED_CLOSE_CODE } from '../../domain/room-ownership.js';

/** Fired once on a room-deleted state when its room is gone for good. */
const ROOM_DELETED_EVENT = 'retroroom:room-deleted';

/** True for the close the relay sends to every socket of a room its owner deleted. */
export const isRoomDeletedClose = (event) => event?.code === ROOM_DELETED_CLOSE_CODE;

/**
 * The terminal state of the open room. Once marked it never clears for the life of the page: providers stop
 * reconnecting, the session stops renewing and the room view is replaced by the deleted screen.
 */
export function createRoomDeletedState() {
  const events = new EventTarget();
  let deleted = false;
  return Object.freeze({
    isDeleted: () => deleted,
    /** Calls `listener` once the room is deleted; returns the unsubscribe. */
    subscribe(listener) {
      events.addEventListener(ROOM_DELETED_EVENT, listener);
      return () => events.removeEventListener(ROOM_DELETED_EVENT, listener);
    },
    mark() {
      if (deleted) return;
      deleted = true;
      events.dispatchEvent(new Event(ROOM_DELETED_EVENT));
    },
  });
}

/** The page's one room-deleted state: a page opens at most one private room. */
export const pageRoomDeleted = createRoomDeletedState();

/** Forgets the room from this browser's recents once it is deleted (at once when it already is); returns the unsubscribe. */
export function forgetWhenDeleted(state, { code, token, forget }) {
  if (state.isDeleted()) {
    forget(code, token);
    return () => {};
  }
  return state.subscribe(() => forget(code, token));
}
