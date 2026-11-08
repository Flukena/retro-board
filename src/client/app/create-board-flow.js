import { createRoom } from '../session/room-session.js';
import { markBoardCreated, rememberRecent, gotoBoard, ROOM_KIND } from './router.js';
import { savePendingStarter } from '../templates/pending-starter.js';
import { createBoardError } from './create-board-error.js';

const REAL_STEPS = Object.freeze({
  createRoom, markBoardCreated, rememberRecent, savePendingStarter, gotoBoard,
});

/**
 * Creates a room and opens it. Resolves null on success or the create error to show.
 * `lock` (a locked room's public record) is forwarded to the relay as is.
 */
export async function runCreateBoard({ name = '', starter = null, kind = ROOM_KIND.BOARD, lock = null }, steps = REAL_STEPS) {
  try {
    const { code, token } = await steps.createRoom({ lock });
    steps.markBoardCreated(code, token);
    steps.rememberRecent(code, name, token, kind);
    if (starter) steps.savePendingStarter(code, starter);
    steps.gotoBoard(code, token, kind);
    return null;
  } catch (error) {
    return createBoardError(error, { locked: lock !== null });
  }
}
