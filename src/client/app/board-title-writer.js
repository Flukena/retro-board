import { renameTitleFrom } from '../../domain/board-title.js';

/**
 * The open board's title and its rename, writing `meta.title` through the board's own patch path: an ordinary
 * (not silent) patch, so the rename is a local edit that undo and redo cover. Returns false when nothing was written.
 */
export function boardTitleWriterFor({ title, patchMeta }) {
  return Object.freeze({
    title,
    rename(raw) {
      const next = renameTitleFrom(raw);
      return next !== null && patchMeta({ title: next }) !== false;
    },
  });
}

let current = null;
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());

/** Published by the open board, so dialogs mounted outside it (the locked-room owner menu) can rename it. */
export const boardTitleWriter = Object.freeze({
  getSnapshot: () => current,
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Makes `writer` current; the returned unpublish clears it unless a newer writer replaced it. */
  publish(writer) {
    current = writer;
    notify();
    return () => {
      if (current !== writer) return;
      current = null;
      notify();
    };
  },
});
