import { isAuthErrorCode } from '../../domain/auth-errors.js';
import { ROOM_KIND } from '../../domain/room-ownership.js';
import { getRelayHttpBaseUrl } from '../session/room-session.js';

const ACCOUNT_TIMEOUT_MS = 8000;
const AUTH_ERROR_PARAM = 'auth_error';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const ACCOUNT_PATH = '/api/account';
const SIGN_IN_PATH = '/api/auth/google/start';

export const ACCOUNT_STATUS = Object.freeze({
  DISABLED: 'disabled', SIGNED_OUT: 'signed-out', SIGNED_IN: 'signed-in', UNAVAILABLE: 'unavailable',
});

const isAccount = (body) => Boolean(body) && typeof body === 'object' && typeof body.name === 'string' && typeof body.plan === 'string';

async function readAccountResponse(response) {
  if (response.status === HTTP_NOT_FOUND) return { status: ACCOUNT_STATUS.DISABLED };
  if (response.status === HTTP_UNAUTHORIZED) return { status: ACCOUNT_STATUS.SIGNED_OUT };
  if (response.status !== HTTP_OK) return { status: ACCOUNT_STATUS.UNAVAILABLE };
  const account = await response.json();
  return isAccount(account) ? { status: ACCOUNT_STATUS.SIGNED_IN, account } : { status: ACCOUNT_STATUS.UNAVAILABLE };
}

const METHOD = Object.freeze({ GET: 'GET', POST: 'POST' });
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

// A JSON body travels only when one is given; the relay reads exactly application/json.
const requestInit = (method, body) => ({
  method, credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
  ...(body === undefined ? {} : { headers: { ...JSON_HEADERS }, body: JSON.stringify(body) }),
});

/** A refused account request: the HTTP status and the relay's error code, when it sent one. */
export class AccountRequestError extends Error {
  constructor(path, status, code) {
    super(`account ${path} failed`);
    this.name = 'AccountRequestError';
    this.status = status;
    this.code = code;
  }
}

export async function fetchAccount({ fetchImpl = fetch, baseUrl = getRelayHttpBaseUrl() } = {}) {
  try {
    return await readAccountResponse(await fetchImpl(`${baseUrl}${ACCOUNT_PATH}`, requestInit(METHOD.GET)));
  } catch {
    return { status: ACCOUNT_STATUS.UNAVAILABLE };
  }
}

// The return address never includes the fragment, which can hold a room key.
export function signInHref({ location = globalThis.location, baseUrl = getRelayHttpBaseUrl() } = {}) {
  const returnTo = `${location.origin}${location.pathname}${location.search}`;
  return `${baseUrl}${SIGN_IN_PATH}?return=${encodeURIComponent(returnTo)}`;
}

async function errorCodeOf(response) {
  try {
    const body = await response.json();
    return typeof body?.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

async function accountRequest(path, method, body, { fetchImpl = fetch, baseUrl = getRelayHttpBaseUrl() } = {}) {
  const response = await fetchImpl(`${baseUrl}${ACCOUNT_PATH}/${path}`, requestInit(method, body));
  if (!response.ok) throw new AccountRequestError(path, response.status, await errorCodeOf(response));
  return response;
}

const postAccountAction = async (action, options) => { await accountRequest(action, METHOD.POST, undefined, options); };

export const logout = (options) => postAccountAction('logout', options);
export const logoutAll = (options) => postAccountAction('logout-all', options);
export const deleteAccount = (options) => postAccountAction('delete', options);

const ROOMS_PATH = 'rooms';
const ROOM_KINDS = new Set(Object.values(ROOM_KIND));
// Open is a full page load to this link, so it must stay on this site: "/x", never "//host" or "scheme:".
const isSiteRelative = (link) => typeof link === 'string' && link.startsWith('/') && !link.startsWith('//');
const isRoomEntry = (room) => Boolean(room) && typeof room === 'object' && typeof room.code === 'string'
  && ROOM_KINDS.has(room.kind) && typeof room.locked === 'boolean' && isSiteRelative(room.link);
const roomPath = (code, action) => `${ROOMS_PATH}/${encodeURIComponent(code)}/${action}`;

/** The signed-in creator's rooms, newest first, as the relay sent them. */
export async function listRooms(options) {
  const { rooms } = await (await accountRequest(ROOMS_PATH, METHOD.GET, undefined, options)).json();
  if (!Array.isArray(rooms)) throw new AccountRequestError(ROOMS_PATH, HTTP_OK, null);
  return rooms.filter(isRoomEntry);
}

/** Resolves to the stored title. */
export async function renameRoom(code, title, options) {
  const body = await (await accountRequest(roomPath(code, 'title'), METHOD.POST, { title }, options)).json();
  return body.title;
}

/** The relay deletes only when confirmCode equals the room code. */
export async function deleteRoom(code, confirmCode, options) {
  await accountRequest(roomPath(code, 'delete'), METHOD.POST, { confirmCode }, options);
}

// Reads a sign-in failure code left by the relay, then removes it from the address bar.
export function readAuthError({ location = globalThis.location, history = globalThis.history } = {}) {
  const params = new URLSearchParams(location.search);
  if (!params.has(AUTH_ERROR_PARAM)) return null;
  const code = params.get(AUTH_ERROR_PARAM);
  params.delete(AUTH_ERROR_PARAM);
  const search = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash ?? ''}`);
  return isAuthErrorCode(code) ? code : null;
}
