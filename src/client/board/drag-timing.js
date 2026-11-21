export const DRAG_THRESHOLD = 4;
// Drag/resize push cadence: send granular geometry at most every DRAG_FLUSH_MS
// while moving, plus a trailing flush DRAG_TRAILING_MS after the last move so
// the final position always lands even if the throttle swallowed it.
export const DRAG_FLUSH_MS = 60;
export const DRAG_TRAILING_MS = 80;
// A just-finished drag stays protected against remote-snapshot overwrite for
// this long after mouseup — covers the window where a concurrent peer write
// (e.g. the vote-finalize auto-sort) can land on the same item with a Yjs
// clock that outranks this client's, even though it happened earlier in
// real time. Mirrors RECENT_AUTHOR_WINDOW_MS in domain/pending-local-items.js (same class of problem:
// a remote snapshot that doesn't yet reflect what this client just did).
export const RECENT_MOVE_WINDOW_MS = 8000;
