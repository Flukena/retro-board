import { PUBLIC_RELAY_PREFIX, PUBLIC_PATH, PUBLIC_SESSION_ROUTE, PUBLIC_ROOM_SESSION_SUFFIX } from '../../domain/public-wall-contract.js';
import {
  LOCK_BYTES, decodeBase64Url, isCounter, isLockKdf, isPlainObject, parseAuthKey,
} from '../../domain/room-lock-contract.js';

// Exchanges the long-lived fragment capability for a short-lived, HttpOnly
// room cookie. The fragment token stays module-private and is never copied to
// a request URL, header, log message, error, or window property.

const ROOM_SESSION_REJECTED_STATUSES = Object.freeze([401, 404]);
const BOARD_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const BOARD_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_HANDLE_RE = /^[A-Za-z0-9_-]{32}$/;
const RESPONSE_MAX_CHARS = 4_096;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RETRY_AFTER_MAX_SECONDS = 3_600;
const RETRY_AFTER_MIN_SECONDS = 1;
const SESSION_RETRY_MIN_MS = 1_000;
const SESSION_RETRY_MAX_MS = 30_000;
const SESSION_RETRY_GROWTH_FACTOR = 2;
const MS_PER_SECOND = 1_000;
const REFRESH_SKEW_FRACTION = 0.2;
const REFRESH_SKEW_MS = 5 * 60 * 1_000;

const JSON_CONTENT_TYPE = 'application/json';
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;

export const ROOM_SESSION_HEALTH = Object.freeze({
  ACTIVE: 'active', LOST: 'session-lost', REPLACED: 'room-replaced', REAUTH_REQUIRED: 'reauth-required',
});

export const ROOM_SESSION_ERROR = Object.freeze({
  INVALID: 'invalid',
  RATE_LIMITED: 'rate_limited',
  UNAVAILABLE: 'unavailable',
  LOCKED: 'locked',
  WRONG_PASSWORD: 'wrong_password',
  LOCKED_OUT: 'locked_out',
});

const ERROR_MESSAGES = {
  [ROOM_SESSION_ERROR.INVALID]: 'Room access was rejected.',
  [ROOM_SESSION_ERROR.RATE_LIMITED]: 'Room access is temporarily rate limited.',
  [ROOM_SESSION_ERROR.UNAVAILABLE]: 'Room service is temporarily unavailable.',
  [ROOM_SESSION_ERROR.LOCKED]: 'Room needs its password.',
  [ROOM_SESSION_ERROR.WRONG_PASSWORD]: 'Room password was rejected.',
  [ROOM_SESSION_ERROR.LOCKED_OUT]: 'Too many wrong passwords. Try again later.',
};

export class RoomSessionError extends Error {
  constructor(code, { retryAfterSeconds = null, httpStatus = null, lock = null } = {}) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES[ROOM_SESSION_ERROR.UNAVAILABLE]);
    this.name = 'RoomSessionError';
    this.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
    this.code = ERROR_MESSAGES[code] ? code : ROOM_SESSION_ERROR.UNAVAILABLE;
    this.retryAfterSeconds = Number.isSafeInteger(retryAfterSeconds)
      ? retryAfterSeconds
      : null;
    this.lock = lock;
  }
}

const fail = (code, options) => {
  throw new RoomSessionError(code, options);
};

const isPlainRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

export function validateCreatedRoomResponse(value) {
  if (!isPlainRecord(value)
    || typeof value.code !== 'string'
    || !BOARD_CODE_RE.test(value.code)
    || typeof value.token !== 'string'
    || !BOARD_TOKEN_RE.test(value.token)) {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  return Object.freeze({ code: value.code, token: value.token });
}

export function validateRoomSessionResponse(value, now = Date.now()) {
  if (!isPlainRecord(value)
    || typeof value.roomHandle !== 'string'
    || !ROOM_HANDLE_RE.test(value.roomHandle)
    || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= now
    || value.expiresAt > now + MAX_SESSION_TTL_MS) {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  return Object.freeze({ roomHandle: value.roomHandle, expiresAt: value.expiresAt });
}

const hasBase64UrlBytes = (value, length) => typeof value === 'string' && decodeBase64Url(value)?.length === length;

/** The salt and KDF a locked room's 409 asks the client to derive with. */
export function validateLockedResponse(value) {
  if (!isPlainObject(value) || value.locked !== true || !hasBase64UrlBytes(value.salt, LOCK_BYTES.salt) || !isLockKdf(value.kdf)) {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  return Object.freeze({ salt: value.salt, kdf: Object.freeze({ ...value.kdf }) });
}

/** The wrapped room key a correct authKey earns, narrowed to the fields the client uses. */
export function validateLockGrant(value) {
  if (!isPlainObject(value)
    || !hasBase64UrlBytes(value.wrappedDek, LOCK_BYTES.wrappedDek)
    || !hasBase64UrlBytes(value.wrapIv, LOCK_BYTES.wrapIv)
    || !isCounter(value.keyEpoch)
    || !isCounter(value.lockRevision)
    || typeof value.isOwner !== 'boolean') {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  return Object.freeze({
    wrappedDek: value.wrappedDek, wrapIv: value.wrapIv, keyEpoch: value.keyEpoch,
    lockRevision: value.lockRevision, isOwner: value.isOwner,
  });
}

export function normalizeRoomFetchPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  const path = value.startsWith('/') ? value.slice(1) : value;
  const segments = path.split('/');
  if (!path
    || value.startsWith('//')
    || value.includes('?')
    || value.includes('#')
    || value.includes('\\')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
    || !segments.every((segment) => /^[A-Za-z0-9._~-]+$/.test(segment))) {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  return `/${path}`;
}

const getRuntimeLocation = () => {
  const location = globalThis.window?.location;
  if (!location?.origin || !location?.hostname || !['http:', 'https:'].includes(location.protocol)) {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  return location;
};

const getRelayPort = () => {
  const raw = String(import.meta.env?.VITE_YJS_PORT || '1234');
  if (!/^\d{1,5}$/.test(raw)) fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  return String(port);
};

export const getRelayHttpBaseUrl = () => {
  const location = getRuntimeLocation();
  if (location.pathname?.replace(/\/$/, '') === PUBLIC_PATH) return `${location.origin}${PUBLIC_RELAY_PREFIX}`;
  if (location.protocol === 'https:') return `${location.origin}/yjs`;
  return `http://${location.hostname}:${getRelayPort()}`;
};

export function getRoomWebSocketBaseUrl() {
  const location = getRuntimeLocation();
  if (location.pathname?.replace(/\/$/, '') === PUBLIC_PATH) return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${PUBLIC_RELAY_PREFIX}/rooms`;
  if (location.protocol === 'https:') return `wss://${location.host}/yjs/rooms`;
  return `ws://${location.hostname}:${getRelayPort()}/rooms`;
}

/** Seconds a 429/503 asks the client to wait, clamped; null when the header is absent or unreadable. */
export const parseRetryAfter = (response) => {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, Math.ceil(seconds)));
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, Math.ceil((at - Date.now()) / MS_PER_SECOND)));
};

const errorForResponse = (response, { invalidStatuses = [], withAuthKey = false } = {}) => {
  if (withAuthKey && response.status === HTTP_FORBIDDEN) {
    return new RoomSessionError(ROOM_SESSION_ERROR.WRONG_PASSWORD, { httpStatus: response.status });
  }
  if (withAuthKey && response.status === HTTP_TOO_MANY_REQUESTS) {
    return new RoomSessionError(ROOM_SESSION_ERROR.LOCKED_OUT, {
      retryAfterSeconds: parseRetryAfter(response), httpStatus: response.status,
    });
  }
  if (response.status === 429) {
    return new RoomSessionError(ROOM_SESSION_ERROR.RATE_LIMITED, {
      retryAfterSeconds: parseRetryAfter(response), httpStatus: response.status,
    });
  }
  if (invalidStatuses.includes(response.status)) {
    return new RoomSessionError(ROOM_SESSION_ERROR.INVALID, { httpStatus: response.status });
  }
  return new RoomSessionError(ROOM_SESSION_ERROR.UNAVAILABLE, { retryAfterSeconds: parseRetryAfter(response), httpStatus: response.status });
};

const cancelResponseBody = async (response) => {
  try { await response.body?.cancel?.(); } catch { /* best effort */ }
};

/** Reads a small JSON response body; anything else fails as UNAVAILABLE. */
export const readSmallJson = async (response) => {
  const contentType = response.headers?.get?.('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await cancelResponseBody(response);
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }

  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength != null) {
    if (!/^\d+$/.test(declaredLength)
      || Number(declaredLength) > RESPONSE_MAX_CHARS) {
      await cancelResponseBody(response);
      fail(ROOM_SESSION_ERROR.UNAVAILABLE);
    }
  }

  const reader = response.body?.getReader?.();
  if (!reader) fail(ROOM_SESSION_ERROR.UNAVAILABLE);

  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_MAX_CHARS) {
        try { await reader.cancel(); } catch { /* best effort */ }
        fail(ROOM_SESSION_ERROR.UNAVAILABLE);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RoomSessionError) throw error;
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }

  if (length === 0) fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    return fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
};

/** POSTs to the relay API with the page's credential, cache, redirect and referrer rules; resolves the Response. */
export const relayPost = (path, body, { contentType = JSON_CONTENT_TYPE, signal } = {}) => fetch(`${getRelayHttpBaseUrl()}${path}`, {
  method: 'POST',
  credentials: 'include',
  cache: 'no-store',
  headers: {
    Accept: JSON_CONTENT_TYPE,
    'Content-Type': contentType,
  },
  body,
  signal,
  redirect: 'error',
  referrerPolicy: 'no-referrer',
});

const postJson = async (path, body, expectedStatus, invalidStatuses = [], { lockAware = false } = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await relayPost(path, JSON.stringify(body), { signal: controller.signal });
    if (lockAware && response.status === HTTP_CONFLICT) {
      throw new RoomSessionError(ROOM_SESSION_ERROR.LOCKED, {
        httpStatus: response.status, lock: validateLockedResponse(await readSmallJson(response)),
      });
    }
    if (response.status !== expectedStatus) {
      await cancelResponseBody(response);
      throw errorForResponse(response, { invalidStatuses, withAuthKey: lockAware && typeof body.authKey === 'string' });
    }
    return await readSmallJson(response);
  } catch (error) {
    if (error instanceof RoomSessionError) throw error;
    return fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  } finally {
    clearTimeout(timeout);
  }
};

/** A plain room takes an empty body; a locked room sends its public lock record and nothing else. */
export async function createRoom({ lock = null } = {}) {
  const value = await postJson('/api/rooms', lock === null ? {} : { lock }, 201);
  return validateCreatedRoomResponse(value);
}

let activeSession = null;
let activeCredentials = null;
let activeAuthKey = null;
// Bumped whenever the authKey is deliberately replaced, so a slower response cannot restore an older one.
let credentialGeneration = 0;
let refreshTimer = null;
let sessionRequest = null;
let requestGeneration = 0;
let retryDelayMs = SESSION_RETRY_MIN_MS;
let sessionHealth = ROOM_SESSION_HEALTH.ACTIVE;
const sessionHealthListeners = new Set();
export const getRoomSessionHealth = () => sessionHealth;
export const onRoomSessionHealth = (listener) => {
  sessionHealthListeners.add(listener);
  return () => sessionHealthListeners.delete(listener);
};
export const isReauthRequiredError = (error) => (
  error instanceof RoomSessionError
  && (error.code === ROOM_SESSION_ERROR.WRONG_PASSWORD || error.code === ROOM_SESSION_ERROR.LOCKED)
);

/** Swaps the authKey renewals send, after a password change on this page. */
export function replaceRoomAuthKey(authKey) {
  if (activeAuthKey === null || parseAuthKey(authKey) === null) fail(ROOM_SESSION_ERROR.INVALID);
  activeAuthKey = authKey;
  credentialGeneration += 1;
}

const setSessionHealth = (health) => {
  sessionHealth = health;
  sessionHealthListeners.forEach((listener) => listener());
};

const publicSession = (session) => (
  session ? Object.freeze({ roomHandle: session.roomHandle, expiresAt: session.expiresAt }) : null
);

export function getActiveRoomSession() {
  return publicSession(activeSession);
}

const sameCredentials = (left, code, token) => (
  left !== null && left?.code === code && left?.token === token
);

const clearRefreshTimer = () => {
  if (refreshTimer != null) clearTimeout(refreshTimer);
  refreshTimer = null;
};

const scheduleRefreshRetry = (session, error) => {
  if (activeSession !== session) return;
  clearRefreshTimer();
  if (isReauthRequiredError(error)) {
    // A rejected password never succeeds by retrying; the re-unlock dialog takes over.
    setSessionHealth(ROOM_SESSION_HEALTH.REAUTH_REQUIRED);
    return;
  }
  setSessionHealth(ROOM_SESSION_HEALTH.LOST);
  const retryAfterMs = (error?.retryAfterSeconds || 0) * MS_PER_SECOND;
  const delayMs = Math.max(retryDelayMs, retryAfterMs);
  retryDelayMs = Math.min(SESSION_RETRY_MAX_MS, retryDelayMs * SESSION_RETRY_GROWTH_FACTOR);
  refreshTimer = setTimeout(() => {
    refreshActiveRoomSession().catch((failure) => scheduleRefreshRetry(session, failure));
  }, delayMs);
};

const scheduleRefresh = (session) => {
  clearRefreshTimer();
  const remaining = session.expiresAt - Date.now();
  const skew = Math.min(REFRESH_SKEW_MS, Math.floor(remaining * REFRESH_SKEW_FRACTION));
  const delay = Math.max(SESSION_RETRY_MIN_MS, remaining - skew);
  refreshTimer = setTimeout(() => {
    refreshActiveRoomSession().catch((error) => scheduleRefreshRetry(session, error));
  }, delay);
};

const publicSessionPath = handle => handle ? `/rooms/${handle}${PUBLIC_ROOM_SESSION_SUFFIX}` : PUBLIC_SESSION_ROUTE;

const exchangeSession = async (code, token, { expectedHandle = null, replacedHandle = null, authKey = null } = {}) => {
  const publicWall = code === null && token === null;
  if (!publicWall && (!BOARD_CODE_RE.test(code || '') || !BOARD_TOKEN_RE.test(token || ''))) {
    fail(ROOM_SESSION_ERROR.INVALID);
  }
  if (sessionRequest && sameCredentials(sessionRequest, code, token) && sessionRequest.authKey === authKey) {
    const session = await sessionRequest.promise;
    if (expectedHandle && session.roomHandle !== expectedHandle) {
      fail(ROOM_SESSION_ERROR.UNAVAILABLE);
    }
    return session;
  }

  const generation = ++requestGeneration;
  const credentialGenerationAtStart = credentialGeneration;
  const promise = (async () => {
    const value = await postJson(
      publicWall ? publicSessionPath(expectedHandle) : '/api/room-session',
      publicWall ? {} : { code, token, ...(authKey === null ? {} : { authKey }) },
      200,
      [400, 404],
      { lockAware: !publicWall },
    );
    const session = validateRoomSessionResponse(value);
    const lock = authKey === null ? null : validateLockGrant(value.lock);
    if (expectedHandle && session.roomHandle !== expectedHandle) {
      fail(ROOM_SESSION_ERROR.UNAVAILABLE);
    }
    if (generation !== requestGeneration) fail(ROOM_SESSION_ERROR.UNAVAILABLE);
    activeCredentials = Object.freeze({ code, token });
    if (credentialGeneration === credentialGenerationAtStart) activeAuthKey = authKey;
    activeSession = session;
    retryDelayMs = SESSION_RETRY_MIN_MS;
    scheduleRefresh(session);
    setSessionHealth(replacedHandle && replacedHandle !== session.roomHandle
      ? ROOM_SESSION_HEALTH.REPLACED : ROOM_SESSION_HEALTH.ACTIVE);
    return lock ? Object.freeze({ ...publicSession(session), lock }) : publicSession(session);
  })();

  sessionRequest = { code, token, authKey, promise };
  try {
    return await promise;
  } finally {
    if (sessionRequest?.promise === promise) sessionRequest = null;
  }
};

// `authKey` is the second step of a locked room's exchange; the first step omits it.
export async function establishRoomSession(code, token, { authKey = null } = {}) {
  if (!BOARD_CODE_RE.test(code || '') || !BOARD_TOKEN_RE.test(token || '')) fail(ROOM_SESSION_ERROR.INVALID);
  if (authKey !== null && parseAuthKey(authKey) === null) fail(ROOM_SESSION_ERROR.INVALID);
  if (activeCredentials && !sameCredentials(activeCredentials, code, token)) {
    clearRefreshTimer();
    activeCredentials = null;
    activeAuthKey = null;
    activeSession = null;
  }
  if (authKey !== null) credentialGeneration += 1;
  const expectedHandle = sameCredentials(activeCredentials, code, token)
    ? activeSession?.roomHandle || null
    : null;
  return exchangeSession(code, token, { expectedHandle, authKey });
}

export const canRefreshRoomSession = () => activeCredentials !== null;

export const isPublicRoomSession = () => sameCredentials(activeCredentials, null, null);

export async function refreshActiveRoomSession() {
  if (!activeCredentials) fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  try {
    return await exchangeSession(activeCredentials.code, activeCredentials.token, {
      expectedHandle: activeSession?.roomHandle || null,
      authKey: activeAuthKey,
    });
  } catch (error) {
    setSessionHealth(isReauthRequiredError(error) ? ROOM_SESSION_HEALTH.REAUTH_REQUIRED : ROOM_SESSION_HEALTH.LOST);
    if (isPublicRoomSession() && ROOM_SESSION_REJECTED_STATUSES.includes(error.httpStatus)) {
      return exchangeSession(null, null, { replacedHandle: activeSession?.roomHandle || null });
    }
    throw error;
  }
}

export async function roomFetch(path, init = {}) {
  const suffix = normalizeRoomFetchPath(path);
  let session = activeSession;
  if (!session || session.expiresAt <= Date.now() + 5_000) {
    session = await refreshActiveRoomSession();
  }

  const request = () => fetch(
    `${getRelayHttpBaseUrl()}/rooms/${session.roomHandle}${suffix}`,
    {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    },
  );
  let response;
  try {
    response = await request();
  } catch {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  if (!ROOM_SESSION_REJECTED_STATUSES.includes(response.status)) return response;

  await cancelResponseBody(response);
  session = await refreshActiveRoomSession();
  let retried;
  try {
    retried = await request();
  } catch {
    fail(ROOM_SESSION_ERROR.UNAVAILABLE);
  }
  if (ROOM_SESSION_REJECTED_STATUSES.includes(retried.status)) {
    await cancelResponseBody(retried);
    fail(ROOM_SESSION_ERROR.INVALID);
  }
  return retried;
}

export function establishPublicSession() {
  if (activeCredentials && !sameCredentials(activeCredentials, null, null)) clearRoomSession();
  return exchangeSession(null, null, { expectedHandle: activeSession?.roomHandle || null });
}

export function clearRoomSession() {
  clearRefreshTimer();
  activeCredentials = null;
  activeAuthKey = null;
  activeSession = null;
  requestGeneration++;
}
