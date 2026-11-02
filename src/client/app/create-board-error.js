import { ROOM_SESSION_ERROR, RoomSessionError } from '../session/room-session.js';

export const CREATE_RETRY_FALLBACK_SECONDS = 2;

export function createBoardError(error) {
  const rateLimited = error instanceof RoomSessionError && error.code === ROOM_SESSION_ERROR.RATE_LIMITED;
  return {
    code: rateLimited ? ROOM_SESSION_ERROR.RATE_LIMITED : ROOM_SESSION_ERROR.UNAVAILABLE,
    retryAfterSeconds: rateLimited ? (error.retryAfterSeconds || CREATE_RETRY_FALLBACK_SECONDS) : null,
  };
}
