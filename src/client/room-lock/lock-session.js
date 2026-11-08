import { deriveRoomSecrets, unwrapRoomKey } from './e2e-crypto.js';
import { parseLockParams } from '../../domain/room-lock-contract.js';
import {
  ROOM_SESSION_ERROR, RoomSessionError, establishRoomSession, replaceRoomAuthKey,
} from '../session/room-session.js';

export const ROOM_KEY_CHANGED_EVENT = 'retroroom:room-key-changed';
/** Dispatched on window (by the rotation flow) when the room key was replaced and this page must re-unlock. */
export const KEY_ROTATED_EVENT = 'retroroom:key-rotated';

// Memory only: the password, authKey and key material never reach storage, logs or URLs.
let credentials = null;
let state = null;

const lockRecord = ({ salt, kdf }, { wrappedDek, wrapIv }) => Object.freeze({
  salt, kdf, wrappedDek, wrapIv,
});

const snapshot = () => (state ? Object.freeze({ ...state }) : null);

/** The unlocked key state of the open room, or null while locked or on a normal room. */
export const getRoomKey = snapshot;

export const isRoomUnlocked = (code, token) => (
  credentials !== null && state !== null && credentials.code === code && credentials.token === token
);

export function clearRoomKey() {
  credentials = null;
  state = null;
}

/** Releases the key of the previous epoch once image repair no longer needs it. */
export function dropPreviousKey() {
  if (state) state = Object.freeze({ ...state, previousKey: undefined });
}

async function exchangeWithPassword({ code, token, password, lockHint }) {
  const { kek, authKey } = await deriveRoomSecrets(password, lockHint.salt, lockHint.kdf);
  const session = await establishRoomSession(code, token, { authKey });
  const dek = await unwrapRoomKey(kek, session.lock.wrappedDek, session.lock.wrapIv);
  return { session, dek };
}

/** Opens a locked room with its password and keeps the room key in memory. */
export async function unlockRoom({ code, token, password, lockHint }) {
  const { session, dek } = await exchangeWithPassword({ code, token, password, lockHint });
  credentials = Object.freeze({ code, token });
  state = Object.freeze({
    roomHandle: session.roomHandle,
    keyEpoch: session.lock.keyEpoch,
    dek,
    isOwner: session.lock.isOwner,
    lock: lockRecord(lockHint, session.lock),
  });
  return snapshot();
}

async function readCurrentLockHint({ code, token }) {
  try {
    await establishRoomSession(code, token);
  } catch (error) {
    if (error instanceof RoomSessionError && error.code === ROOM_SESSION_ERROR.LOCKED) return error.lock;
    throw error;
  }
  throw new RoomSessionError(ROOM_SESSION_ERROR.UNAVAILABLE);
}

const announceKeyChange = ({ keyEpoch, epochChanged }) => {
  globalThis.window?.dispatchEvent?.(new CustomEvent(ROOM_KEY_CHANGED_EVENT, { detail: { keyEpoch, epochChanged } }));
};

/**
 * Re-opens the open room after a password change or key rotation elsewhere.
 * The current salt and KDF come first (the 409), because they may have changed.
 */
export async function reunlock(password) {
  if (state === null || credentials === null) throw new RoomSessionError(ROOM_SESSION_ERROR.INVALID);
  const lockHint = await readCurrentLockHint(credentials);
  const { session, dek } = await exchangeWithPassword({ ...credentials, password, lockHint });
  const epochChanged = session.lock.keyEpoch !== state.keyEpoch;
  state = Object.freeze({
    roomHandle: session.roomHandle,
    keyEpoch: session.lock.keyEpoch,
    dek,
    isOwner: session.lock.isOwner,
    lock: lockRecord(lockHint, session.lock),
    previousKey: epochChanged ? state.dek : state.previousKey,
  });
  announceKeyChange({ keyEpoch: state.keyEpoch, epochChanged });
  return snapshot();
}

/** After this page changed the password: renewals and the cached lock follow the new record. */
export function updateLockAfterPasswordChange({ lock, authKey }) {
  const params = parseLockParams(lock);
  if (state === null || params === null) throw new RoomSessionError(ROOM_SESSION_ERROR.INVALID);
  replaceRoomAuthKey(authKey);
  state = Object.freeze({ ...state, lock: lockRecord(params, params) });
}

/** Opens the room's session: unlocked rooms keep their session, others do the plain exchange. */
export async function establishBoardSession(code, token) {
  if (isRoomUnlocked(code, token)) return;
  await establishRoomSession(code, token);
}
