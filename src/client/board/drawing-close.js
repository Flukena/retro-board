// Closing Draw keeps the drawing: leaving draw mode saves pending strokes first.
// Closing drops the unsaved draft only when a save is already running (closing
// again stops it) or has failed, or the image never opened, so a slow or
// failed save cannot trap the user.
const SAVE_FAILURES = new Set(['draw.conflict', 'draw.encodeFailed', 'draw.saveFailed']);

/** Whether pressing close should drop the unsaved draft instead of saving it. */
export function closeDiscardsDraft({ error, failed, closing }) {
  return Boolean(failed) || Boolean(closing) || SAVE_FAILURES.has(error);
}
