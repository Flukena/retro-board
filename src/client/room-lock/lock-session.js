import { deriveRoomMasterKey, roomSecretsFromMaster, RoomKeyError, unwrapRoomKey } from './e2e-crypto.js';
import { isCounter, parseLockParams } from '../../domain/room-lock-contract.js';
import {
  ROOM_SESSION_ERROR, RoomSessionError, clearRoomSession, establishRoomSession, replaceRoomAuthKey,
} from '../session/room-session.js';
import { rememberedRoomStore } from './remembered-room-store.js';

export const ROOM_KEY_CHANGED_EVENT = 'retroroom:room-key-changed';
export const ROOM_REMEMBER_CHANGED_EVENT = 'retroroom:room-remember-changed';
/** Dispatched on window (by the rotation flow) when the room key was replaced and this page must re-unlock. */
export const KEY_ROTATED_EVENT = 'retroroom:key-rotated';

let credentials = null;
let state = null;
let pendingBootstrap = null;

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

/** The key of an earlier epoch that still has unrepaired images, or undefined. */
export const getPreviousKey = (keyEpoch) => state?.previousKeys.get(keyEpoch);

/** Releases the key of one earlier epoch once image repair no longer needs it. */
export function dropPreviousKey(keyEpoch) {
  if (!state?.previousKeys.has(keyEpoch)) return;
  const previousKeys = new Map(state.previousKeys);
  previousKeys.delete(keyEpoch);
  state = Object.freeze({ ...state, previousKeys });
}

async function exchangeRoomKey({ code, token }, lockHint, masterKey) {
  const { kek, authKey } = await roomSecretsFromMaster(masterKey);
  const session = await establishRoomSession(code, token, { authKey });
  let dek;
  try {
    dek = await unwrapRoomKey(kek, session.lock.wrappedDek, session.lock.wrapIv);
  } catch (error) {
    // A grant whose key cannot open the board must not keep renewing in the background.
    clearRoomSession();
    throw error;
  }
  return {
    roomHandle: session.roomHandle, keyEpoch: session.lock.keyEpoch, lockRevision: session.lock.lockRevision,
    isOwner: session.lock.isOwner, lock: lockRecord(lockHint, session.lock), dek,
  };
}

async function applyRememberChoice({ code, token }, record, remember, previous) {
  if (remember) return { remembered: await rememberedRoomStore.save(code, token, record) };
  if (previous?.remembered && !await rememberedRoomStore.remove(code, token, previous.lock.salt)) {
    return { remembered: true, forgetFailed: true };
  }
  return { remembered: false };
}

async function openWithPassword(room, password, lockHint, remember, previous) {
  const masterKey = await deriveRoomMasterKey(password, lockHint.salt, lockHint.kdf);
  const grant = await exchangeRoomKey(room, lockHint, masterKey);
  const choice = await applyRememberChoice(room, { salt: lockHint.salt, masterKey }, remember, previous);
  const previousKeys = new Map(previous?.previousKeys);
  if (previous && previous.keyEpoch !== grant.keyEpoch) previousKeys.set(previous.keyEpoch, previous.dek);
  credentials = room;
  state = Object.freeze({ ...grant, previousKeys, remembered: choice.remembered });
  return choice.forgetFailed ? { ...snapshot(), forgetFailed: true } : snapshot();
}

export function unlockRoom({ code, token, password, lockHint, remember = false }) {
  return openWithPassword({ code, token }, password, lockHint, remember, null);
}

async function roomChallenge({ code, token }) {
  try {
    await establishRoomSession(code, token);
    return null;
  } catch (error) {
    if (error instanceof RoomSessionError && error.code === ROOM_SESSION_ERROR.LOCKED) return error;
    throw error;
  }
}

async function requireChallenge(room) {
  const challenge = await roomChallenge(room);
  if (challenge) return challenge;
  throw new RoomSessionError(ROOM_SESSION_ERROR.UNAVAILABLE);
}

/** A re-unlock fetches the current salt before deriving with the new password. */
export async function reunlock(password, remember = false) {
  if (state === null || credentials === null) throw new RoomSessionError(ROOM_SESSION_ERROR.INVALID);
  const { lock } = await requireChallenge(credentials);
  const previous = state;
  const result = await openWithPassword(credentials, password, lock, remember, previous);
  const detail = { keyEpoch: result.keyEpoch, epochChanged: result.keyEpoch !== previous.keyEpoch };
  globalThis.window?.dispatchEvent?.(new CustomEvent(ROOM_KEY_CHANGED_EVENT, { detail }));
  return result;
}

function setForgotten() {
  state = Object.freeze({ ...state, remembered: false });
  globalThis.window?.dispatchEvent?.(new Event(ROOM_REMEMBER_CHANGED_EVENT));
}

/** Remove the device credential. The open page can continue working until it closes. */
export async function forgetRememberedRoom() {
  const room = credentials;
  if (!room) return false;
  if (!await rememberedRoomStore.remove(room.code, room.token)) return false;
  if (room === credentials) setForgotten();
  return true;
}

/** After an owner changes the password, renewals use the new proof and the old saved unlock expires. */
export function updateLockAfterPasswordChange({ lock, authKey, lockRevision }) {
  const params = parseLockParams(lock);
  if (state === null || params === null || !isCounter(lockRevision)) throw new RoomSessionError(ROOM_SESSION_ERROR.INVALID);
  replaceRoomAuthKey(authKey);
  const oldSalt = state.lock.salt;
  state = Object.freeze({ ...state, lock: lockRecord(params, params), lockRevision });
  if (state.remembered) {
    const room = credentials;
    return rememberedRoomStore.remove(room.code, room.token, oldSalt).then((removed) => {
      if (removed && room === credentials) setForgotten();
    });
  }
}

async function restoreOrPrompt(room, initialChallenge) {
  const { code, token } = room;
  const saved = await rememberedRoomStore.read(code, token);
  if (!saved) throw initialChallenge;

  // Another tab may have saved a new password after the relay sent the first challenge.
  const challenge = saved.salt === initialChallenge.lock.salt ? initialChallenge : await requireChallenge(room);
  if (saved.salt !== challenge.lock.salt) {
    await rememberedRoomStore.remove(code, token, saved.salt);
    throw challenge;
  }
  let grant;
  try {
    grant = await exchangeRoomKey(room, challenge.lock, saved.masterKey);
  } catch (error) {
    if (error instanceof RoomSessionError && error.code === ROOM_SESSION_ERROR.LOCKED_OUT) {
      throw new RoomSessionError(ROOM_SESSION_ERROR.RATE_LIMITED, { retryAfterSeconds: error.retryAfterSeconds });
    }
    const rejected = error instanceof RoomSessionError && error.code === ROOM_SESSION_ERROR.WRONG_PASSWORD;
    if (!rejected && !(error instanceof RoomKeyError) && !(error instanceof DOMException)) throw error;
    await rememberedRoomStore.remove(code, token, saved.salt);
    throw await requireChallenge(room);
  }
  credentials = room;
  state = Object.freeze({ ...grant, remembered: true, previousKeys: new Map() });
}

async function openBoard(room) {
  const challenge = await roomChallenge(room);
  if (challenge) await restoreOrPrompt(room, challenge);
}

/** Concurrent mounts share one admission attempt, including the IndexedDB lookup and proof. */
export async function establishBoardSession(code, token) {
  if (isRoomUnlocked(code, token)) return;
  if (pendingBootstrap?.code === code && pendingBootstrap.token === token) return pendingBootstrap.promise;
  const promise = openBoard({ code, token });
  pendingBootstrap = { code, token, promise };
  try {
    await promise;
  } finally {
    if (pendingBootstrap?.promise === promise) pendingBootstrap = null;
  }
}
