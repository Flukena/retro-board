import { ROOM_SESSION_ERROR, RoomSessionError } from '../session/room-session.js';

export const PROMPT_ERROR = Object.freeze({ WRONG: 'wrong', LOCKED_OUT: 'locked-out', UNAVAILABLE: 'unavailable' });
const FALLBACK_LOCKOUT_SECONDS = 60;

/** What a failed unlock shows: an error kind and, while rate limited, the seconds to wait. */
export function promptErrorFor(error) {
  if (error instanceof RoomSessionError && error.code === ROOM_SESSION_ERROR.WRONG_PASSWORD) {
    return { kind: PROMPT_ERROR.WRONG, seconds: 0 };
  }
  if (error instanceof RoomSessionError && error.code === ROOM_SESSION_ERROR.LOCKED_OUT) {
    return { kind: PROMPT_ERROR.LOCKED_OUT, seconds: error.retryAfterSeconds || FALLBACK_LOCKOUT_SECONDS };
  }
  return { kind: PROMPT_ERROR.UNAVAILABLE, seconds: 0 };
}
