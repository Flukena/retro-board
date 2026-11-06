import { isAuthErrorCode } from '../../domain/auth-errors.js';
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

const requestInit = (method) => ({
  method, credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
});

export async function fetchAccount({ fetchImpl = fetch, baseUrl = getRelayHttpBaseUrl() } = {}) {
  try {
    return await readAccountResponse(await fetchImpl(`${baseUrl}${ACCOUNT_PATH}`, requestInit('GET')));
  } catch {
    return { status: ACCOUNT_STATUS.UNAVAILABLE };
  }
}

// The return address never includes the fragment, which can hold a room key.
export function signInHref({ location = globalThis.location, baseUrl = getRelayHttpBaseUrl() } = {}) {
  const returnTo = `${location.origin}${location.pathname}${location.search}`;
  return `${baseUrl}${SIGN_IN_PATH}?return=${encodeURIComponent(returnTo)}`;
}

async function postAccountAction(action, { fetchImpl = fetch, baseUrl = getRelayHttpBaseUrl() } = {}) {
  const response = await fetchImpl(`${baseUrl}${ACCOUNT_PATH}/${action}`, requestInit('POST'));
  if (!response.ok) throw new Error(`account ${action} failed`);
}

export const logout = (options) => postAccountAction('logout', options);
export const logoutAll = (options) => postAccountAction('logout-all', options);
export const deleteAccount = (options) => postAccountAction('delete', options);

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
