import { ROOM_SESSION_ERROR, RoomSessionError } from '../session/room-session.js';

export const CREATE_RETRY_FALLBACK_SECONDS = 2;
export const CREATE_LOCK_ERROR = Object.freeze({ SIGN_IN_REQUIRED: 'sign-in-required', PLAN_REQUIRED: 'plan-required' });
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const LOCK_ERROR_BY_STATUS = Object.freeze({
  [HTTP_UNAUTHORIZED]: CREATE_LOCK_ERROR.SIGN_IN_REQUIRED,
  [HTTP_FORBIDDEN]: CREATE_LOCK_ERROR.PLAN_REQUIRED,
});

export function createBoardError(error) {
  const rateLimited = error instanceof RoomSessionError && error.code === ROOM_SESSION_ERROR.RATE_LIMITED;
  const lockCode = error instanceof RoomSessionError ? LOCK_ERROR_BY_STATUS[error.httpStatus] : undefined;
  return {
    code: lockCode ?? (rateLimited ? ROOM_SESSION_ERROR.RATE_LIMITED : ROOM_SESSION_ERROR.UNAVAILABLE),
    retryAfterSeconds: rateLimited ? (error.retryAfterSeconds || CREATE_RETRY_FALLBACK_SECONDS) : null,
  };
}
