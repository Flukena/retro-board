import { isBoardTitle } from '../../domain/board-title.js';
import { typedConfirmationMatches } from '../ui/modal-model.js';
import { forgetRecent } from '../app/router.js';
import { deleteRoom, listRooms, renameRoom } from './account-api.js';

export const MY_BOARDS_STATUS = Object.freeze({ LOADING: 'loading', READY: 'ready', FAILED: 'failed' });
export const MY_BOARDS_ERROR = Object.freeze({
  SIGN_IN: 'sign-in', GONE: 'gone', LOCKED: 'locked', RATE_LIMITED: 'rate-limited', UNAVAILABLE: 'unavailable',
});
const HTTP = Object.freeze({ UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409, TOO_MANY: 429 });
const LOCKED_ROOM_CODE = 'locked-room';
const FRAGMENT_MARK = '#';
const DEFAULT_API = Object.freeze({ listRooms, renameRoom, deleteRoom });
const INITIAL = Object.freeze({ status: MY_BOARDS_STATUS.LOADING, rooms: Object.freeze([]), error: null, busyCode: null });

/** What the user can do about a failed request. */
export function myBoardsErrorFor(failure) {
  switch (failure?.status) {
    case HTTP.UNAUTHORIZED: return MY_BOARDS_ERROR.SIGN_IN;
    case HTTP.NOT_FOUND: return MY_BOARDS_ERROR.GONE;
    case HTTP.TOO_MANY: return MY_BOARDS_ERROR.RATE_LIMITED;
    case HTTP.CONFLICT: return failure.code === LOCKED_ROOM_CODE ? MY_BOARDS_ERROR.LOCKED : MY_BOARDS_ERROR.UNAVAILABLE;
    default: return MY_BOARDS_ERROR.UNAVAILABLE;
  }
}

/** The room token in a link's fragment, or null for a tokenless link. */
export function tokenFromLink(link) {
  const mark = link.indexOf(FRAGMENT_MARK);
  return mark < 0 ? null : link.slice(mark + 1) || null;
}

/** The title to send, or null when the typed text is outside the board title bounds. */
export function renameTitleFrom(raw) {
  const title = String(raw).trim();
  return isBoardTitle(title) ? title : null;
}

/**
 * The behaviour behind "My boards": one list request, then rename and delete update the list from their own
 * results (the relay shares one small rate budget across all three). Ports are injectable for tests.
 */
export function createMyBoardsController({ api = DEFAULT_API, forget = forgetRecent } = {}) {
  let state = INITIAL;
  const listeners = new Set();
  const set = (next) => {
    state = Object.freeze({ ...state, ...next });
    listeners.forEach((listener) => listener());
  };
  const roomOf = (code) => state.rooms.find((room) => room.code === code);
  const withoutRoom = (code) => state.rooms.filter((room) => room.code !== code);

  async function act(code, request, applyResult) {
    if (state.busyCode !== null || !roomOf(code)) return false;
    set({ busyCode: code, error: null });
    try {
      const result = await request();
      set({ busyCode: null, rooms: applyResult(result) });
      return true;
    } catch (failure) {
      const error = myBoardsErrorFor(failure);
      set({ busyCode: null, error, rooms: error === MY_BOARDS_ERROR.GONE ? withoutRoom(code) : state.rooms });
      return false;
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      set({ status: MY_BOARDS_STATUS.LOADING, error: null });
      try {
        set({ status: MY_BOARDS_STATUS.READY, rooms: Object.freeze(await api.listRooms()) });
      } catch (failure) {
        set({ status: MY_BOARDS_STATUS.FAILED, error: myBoardsErrorFor(failure) });
      }
    },
    /** Resolves true once the relay stored the new title. */
    rename(code, rawTitle) {
      const title = renameTitleFrom(rawTitle);
      if (title === null) return Promise.resolve(false);
      return act(code, () => api.renameRoom(code, title), (stored) => state.rooms.map(
        (room) => (room.code === code ? { ...room, title: stored } : room),
      ));
    },
    /** Resolves true once the room is deleted; runs only when the typed code matches exactly. */
    remove(code, typedCode) {
      if (!typedConfirmationMatches(typedCode, code)) return Promise.resolve(false);
      const { link } = roomOf(code) ?? {};
      return act(code, () => api.deleteRoom(code, typedCode), () => {
        forget(code, tokenFromLink(link));
        return withoutRoom(code);
      });
    },
  };
}
