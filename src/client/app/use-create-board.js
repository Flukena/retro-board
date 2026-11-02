import { useRef, useState } from 'react';
import { ROOM_KIND, gotoBoard, markBoardCreated, rememberRecent } from './router.js';
import { ROOM_SESSION_ERROR, RoomSessionError, createRoom } from '../session/room-session.js';
import { savePendingStarter } from '../templates/pending-starter.js';

const createErrorOf = (error) => {
  const rateLimited = error instanceof RoomSessionError && error.code === ROOM_SESSION_ERROR.RATE_LIMITED;
  return {
    code: rateLimited ? ROOM_SESSION_ERROR.RATE_LIMITED : ROOM_SESSION_ERROR.UNAVAILABLE,
    retryAfterSeconds: rateLimited ? error.retryAfterSeconds : null,
  };
};

// Creates a room and opens it. Shared by the home page and the template pages.
// The relay, not the browser, allocates and registers the room; creator status
// and the optional starter format are remembered only after a successful 201.
export function useCreateBoard() {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const creatingRef = useRef(false);
  // Recents always reopen as boards, so only board rooms are listed there.
  const createBoard = async ({ name = '', starter = null, kind = ROOM_KIND.BOARD } = {}) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const { code, token } = await createRoom();
      markBoardCreated(code, token);
      if (kind === ROOM_KIND.BOARD) rememberRecent(code, name, token);
      if (starter) savePendingStarter(code, starter);
      gotoBoard(code, token, kind);
    } catch (error) {
      setCreateError(createErrorOf(error));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };
  return { creating, createError, createBoard };
}
