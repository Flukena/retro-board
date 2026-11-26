import { ROOM_HANDLE_RE } from './relay-config.js';

export const MAX_SAVED_BOARDS = 100;
export const SAVED_BOARD_LIMIT = 'saved-board-limit';

export function validSavedBoardHandles(handles) {
  return Array.isArray(handles) && handles.length <= MAX_SAVED_BOARDS
    && handles.every(handle => typeof handle === 'string' && ROOM_HANDLE_RE.test(handle))
    && new Set(handles).size === handles.length;
}

// Apply the change to the latest durable record, including saves made by another device.
export function updateSavedHandles(current, { handle, saved, staleHandles }) {
  const next = current.filter(item => !staleHandles.has(item) && (saved || item !== handle));
  if (saved && !next.includes(handle)) {
    if (next.length >= MAX_SAVED_BOARDS) throw Object.assign(new Error(SAVED_BOARD_LIMIT), { code: SAVED_BOARD_LIMIT });
    next.push(handle);
  }
  return next;
}
