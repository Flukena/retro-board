import { createHash, createHmac, randomBytes } from 'node:crypto';
import { AUTH_ERROR, isAuthErrorCode } from '../domain/auth-errors.js';
import { MILLISECONDS_PER_HOUR, MILLISECONDS_PER_MINUTE, MILLISECONDS_PER_SECOND } from './relay-config.js';
import { canonicalSignature, singleCookieValue } from './relay-session.js';
import { fixedDigestEqual } from './relay-room-registry.js';
import { isExactAllowedOrigin } from './relay-http.js';
import { accountCookiePath } from './auth-session.js';

// Google OIDC authorization-code flow with PKCE. The ID token comes straight
// from Google's fixed HTTPS token endpoint, so it is trusted by TLS instead of
// a JWKS signature check (OIDC Core §3.1.3.7 item 6; owner-approved deviation).
// This module never logs: failures throw AuthError carrying only a code.

export const MAX_PENDING_FLOWS = 10_000;
export const FLOW_TTL_MS = 10 * MILLISECONDS_PER_MINUTE;
export const TOKEN_EXCHANGE_TIMEOUT_MS = 10 * MILLISECONDS_PER_SECOND;
export const MAX_TOKEN_RESPONSE_BYTES = 16_384;
export const CLOCK_SKEW_MS = MILLISECONDS_PER_MINUTE;
export const MAX_SUB_CHARACTERS = 255;

// Google ID tokens live one hour; a later `exp` means wrong units or a bad token.
const MAX_ID_TOKEN_LIFETIME_MS = MILLISECONDS_PER_HOUR;
const MAX_EMAIL_CHARACTERS = 320;
const MAX_NAME_CHARACTERS = 200;
// Keeps the signed flow cookie well under the browser's 4 KiB cookie limit.
const MAX_RETURN_URL_CHARACTERS = 2048;
const MAX_FLOW_COOKIE_CHARACTERS = 3300;
const FLOW_RANDOM_BYTES = 32;
const RANDOM_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64URL = 'base64url';
const FLOW_COOKIE_NAME = 'rb_oauth_flow';
const FLOW_SIGNATURE_DOMAIN = 'oauth-flow-v1\0';
const FLOW_COOKIE_PART_COUNT = 2;
const FLOW_COOKIE_PATH_SUFFIX = '/auth';
const FLOW_COOKIE_ATTRIBUTES = 'HttpOnly; SameSite=Lax';
const JWT_PART_COUNT = 3;
const JWT_PAYLOAD_INDEX = 1;
const HTTP_OK = 200;
const AUTH_ERROR_PARAM = 'auth_error';
const OAUTH_SCOPES = 'openid email profile';
const OVERRIDE_AUTHORIZATION_PATH = '/auth';
const OVERRIDE_TOKEN_PATH = '/token';
const ENDPOINT_OVERRIDE_REFUSED = 'GOOGLE_OAUTH_ENDPOINT_BASE is only allowed with YJS_ALLOW_INSECURE_HTTP=true';
const ENDPOINT_OVERRIDE_NOT_ORIGIN = 'GOOGLE_OAUTH_ENDPOINT_BASE must be a bare origin';
const TOKEN_RESPONSE_TOO_LARGE = 'token response too large';
const GOOGLE_ENDPOINTS = Object.freeze({
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  issuers: Object.freeze(['https://accounts.google.com', 'accounts.google.com']),
});

export class AuthError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
  }
}

const stateMismatch = () => new AuthError(AUTH_ERROR.STATE_MISMATCH);
const tokenExchangeFailed = () => new AuthError(AUTH_ERROR.TOKEN_EXCHANGE_FAILED);
const invalidIdToken = () => new AuthError(AUTH_ERROR.INVALID_ID_TOKEN);

function endpointOverride(base, allowInsecureHttp) {
  if (!allowInsecureHttp) throw new Error(ENDPOINT_OVERRIDE_REFUSED);
  const url = new URL(base);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(ENDPOINT_OVERRIDE_NOT_ORIGIN);
  return Object.freeze({
    authorizationEndpoint: `${url.origin}${OVERRIDE_AUTHORIZATION_PATH}`,
    tokenEndpoint: `${url.origin}${OVERRIDE_TOKEN_PATH}`,
    issuers: Object.freeze([url.origin]),
  });
}

/** OAuth settings, or null when sign-in is not configured. */
export function googleOAuthConfig(env, { allowInsecureHttp }) {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  const base = env.GOOGLE_OAUTH_ENDPOINT_BASE;
  const endpoints = base ? endpointOverride(base, allowInsecureHttp) : GOOGLE_ENDPOINTS;
  return Object.freeze({ clientId, clientSecret, redirectUri, allowInsecureHttp: Boolean(allowInsecureHttp), ...endpoints });
}

const absoluteUrl = (raw) => (
  typeof raw === 'string' && raw.length <= MAX_RETURN_URL_CHARACTERS && URL.canParse(raw) ? new URL(raw) : null
);

/** Board URL to send the browser back to: an allowed origin with a normal path, or the board root. */
export function returnUrl(raw, allowedOrigins, allowInsecureHttp) {
  const fallback = `${allowedOrigins[0]}/`;
  const url = absoluteUrl(raw);
  if (!url || !isExactAllowedOrigin(url.origin, allowedOrigins, allowInsecureHttp) || url.pathname.startsWith('//')) {
    return fallback;
  }
  const target = `${url.origin}${url.pathname}${url.search}`;
  return target.length <= MAX_RETURN_URL_CHARACTERS ? target : fallback;
}

export function withAuthError(url, code) {
  if (!isAuthErrorCode(code)) throw new TypeError('unknown auth error code');
  const target = new URL(url);
  target.searchParams.set(AUTH_ERROR_PARAM, code);
  return target.href;
}

/** Outstanding sign-in states, in memory. `claim` is synchronous, so a state is spent exactly once. */
export class FlowLedger {
  #expiries = new Map();
  #maxFlows;
  #ttlMs;

  constructor({ maxFlows = MAX_PENDING_FLOWS, ttlMs = FLOW_TTL_MS } = {}) {
    this.#maxFlows = maxFlows;
    this.#ttlMs = ttlMs;
  }

  get ttlMs() { return this.#ttlMs; }

  // Entries are inserted with a fixed TTL, so insertion order is expiry order.
  #prune(nowMs) {
    for (const [state, expiresAt] of this.#expiries) {
      if (expiresAt > nowMs) return;
      this.#expiries.delete(state);
    }
  }

  register(state, expiresAt, nowMs = Date.now()) {
    this.#prune(nowMs);
    if (this.#expiries.size >= this.#maxFlows) return false;
    this.#expiries.set(state, expiresAt);
    return true;
  }

  claim(state, nowMs = Date.now()) {
    const expiresAt = this.#expiries.get(state);
    if (expiresAt === undefined) return false;
    this.#expiries.delete(state);
    return expiresAt > nowMs;
  }
}

const randomValue = () => randomBytes(FLOW_RANDOM_BYTES).toString(BASE64URL);
const flowSignature = (signingKey, payload) => createHmac('sha256', signingKey)
  .update(FLOW_SIGNATURE_DOMAIN).update(payload).digest();
const flowCookiePath = (prefixed) => `${accountCookiePath(prefixed)}${FLOW_COOKIE_PATH_SUFFIX}`;
const secureAttribute = (config) => (config.allowInsecureHttp ? '' : '; Secure');
const flowCookieHeader = (config, prefixed, value, maxAgeSeconds) => (
  `${FLOW_COOKIE_NAME}=${value}; Path=${flowCookiePath(prefixed)}; ${FLOW_COOKIE_ATTRIBUTES}; Max-Age=${maxAgeSeconds}${secureAttribute(config)}`
);

function encodedFlow(flow, signingKey) {
  const payload = Buffer.from(JSON.stringify(flow)).toString(BASE64URL);
  return `${payload}.${flowSignature(signingKey, payload).toString(BASE64URL)}`;
}

function authorizationLocation(config, flow) {
  const location = new URL(config.authorizationEndpoint);
  location.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: OAUTH_SCOPES,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: createHash('sha256').update(flow.verifier).digest(BASE64URL),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return location.href;
}

/**
 * Begins a sign-in. `returnTo` must come from `returnUrl`. Null when too many flows are pending.
 * @returns {{ location: string, flowCookie: string } | null}
 */
export function startAuthorization(config, returnTo, signingKey, ledger, { prefixed = false, nowMs = Date.now() } = {}) {
  const flow = { state: randomValue(), nonce: randomValue(), verifier: randomValue(), returnTo, expiresAt: nowMs + ledger.ttlMs };
  let value = encodedFlow(flow, signingKey);
  // JSON escaping can double a long returnTo past the cookie cap; its origin root always fits.
  if (value.length > MAX_FLOW_COOKIE_CHARACTERS) {
    flow.returnTo = `${new URL(returnTo).origin}/`;
    value = encodedFlow(flow, signingKey);
  }
  if (!ledger.register(flow.state, flow.expiresAt, nowMs)) return null;
  const maxAgeSeconds = Math.floor(ledger.ttlMs / MILLISECONDS_PER_SECOND);
  return { location: authorizationLocation(config, flow), flowCookie: flowCookieHeader(config, prefixed, value, maxAgeSeconds) };
}

export const readFlowCookie = (req, maxCookieHeaderBytes) => singleCookieValue(req, FLOW_COOKIE_NAME, maxCookieHeaderBytes);

export const clearFlowCookie = (config, { prefixed }) => flowCookieHeader(config, prefixed, '', 0);

function parsedJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const decodedJson = (encoded) => (BASE64URL_PATTERN.test(encoded) ? parsedJson(Buffer.from(encoded, BASE64URL).toString('utf8')) : null);

function signedFlow(value, signingKey) {
  if (typeof value !== 'string' || value.length > MAX_FLOW_COOKIE_CHARACTERS) return null;
  const parts = value.split('.');
  if (parts.length !== FLOW_COOKIE_PART_COUNT) return null;
  const [payload, rawSignature] = parts;
  const signature = canonicalSignature(rawSignature);
  if (!signature || !fixedDigestEqual(signature, flowSignature(signingKey, payload))) return null;
  return decodedJson(payload);
}

const isRandomValue = (value) => typeof value === 'string' && RANDOM_VALUE_PATTERN.test(value);

function isLiveFlow(flow, nowMs, ttlMs) {
  return isPlainObject(flow)
    && isRandomValue(flow.state) && isRandomValue(flow.nonce) && isRandomValue(flow.verifier)
    && typeof flow.returnTo === 'string' && flow.returnTo.length <= MAX_RETURN_URL_CHARACTERS
    && Number.isSafeInteger(flow.expiresAt) && flow.expiresAt > nowMs && flow.expiresAt <= nowMs + ttlMs;
}

function singleParam(query, name) {
  const values = query.getAll(name);
  return values.length === 1 ? values[0] : null;
}

/**
 * Checks the callback against the signed flow cookie and spends its state.
 * Every failure is `state_mismatch`; nothing is spent unless all checks pass.
 * @param {URLSearchParams} query callback query
 * @returns {{ state: string, nonce: string, verifier: string, returnTo: string, expiresAt: number }}
 */
export function verifyFlow(query, flowCookieValue, signingKey, ledger, now = Date.now()) {
  const state = singleParam(query, 'state');
  const flow = signedFlow(flowCookieValue, signingKey);
  const matches = state !== null && query.getAll('code').length <= 1 && isLiveFlow(flow, now, ledger.ttlMs)
    && fixedDigestEqual(Buffer.from(state), Buffer.from(flow.state));
  if (!matches || !ledger.claim(flow.state, now)) throw stateMismatch();
  const { nonce, verifier, returnTo, expiresAt } = flow;
  return Object.freeze({ state: flow.state, nonce, verifier, returnTo, expiresAt });
}

async function postTokenRequest(config, flow, code, { fetchImpl, signal }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code_verifier: flow.verifier,
  });
  try {
    return await fetchImpl(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
  } catch {
    throw tokenExchangeFailed();
  }
}

async function cappedText(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_TOKEN_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RangeError(TOKEN_RESPONSE_TOO_LARGE);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Parse failures carry no cause: a JSON error message would quote response bytes.
async function tokenResponseJson(response) {
  if (response.status !== HTTP_OK || !response.body) {
    await response.body?.cancel();
    throw tokenExchangeFailed();
  }
  let text;
  try {
    text = await cappedText(response.body);
  } catch {
    throw tokenExchangeFailed();
  }
  const json = parsedJson(text);
  if (!isPlainObject(json)) throw tokenExchangeFailed();
  return json;
}

function idTokenClaims(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  const claims = parts.length === JWT_PART_COUNT ? decodedJson(parts[JWT_PAYLOAD_INDEX]) : null;
  if (!isPlainObject(claims)) throw invalidIdToken();
  return claims;
}

const isBoundedString = (value, maxCharacters) => typeof value === 'string' && value.length > 0 && value.length <= maxCharacters;
const secondsToMs = (seconds) => seconds * MILLISECONDS_PER_SECOND;
const isUnexpired = (expSeconds, nowMs) => Number.isSafeInteger(expSeconds)
  && secondsToMs(expSeconds) > nowMs && secondsToMs(expSeconds) <= nowMs + MAX_ID_TOKEN_LIFETIME_MS + CLOCK_SKEW_MS;
const isIssuedByNow = (iatSeconds, nowMs) => Number.isSafeInteger(iatSeconds) && secondsToMs(iatSeconds) <= nowMs + CLOCK_SKEW_MS;
const nonceMatches = (nonce, expected) => typeof nonce === 'string' && fixedDigestEqual(Buffer.from(nonce), Buffer.from(expected));

function hasValidClaims(claims, config, flow, nowMs) {
  return config.issuers.includes(claims.iss) && claims.aud === config.clientId
    && isUnexpired(claims.exp, nowMs) && isIssuedByNow(claims.iat, nowMs) && nonceMatches(claims.nonce, flow.nonce)
    && isBoundedString(claims.sub, MAX_SUB_CHARACTERS) && isBoundedString(claims.email, MAX_EMAIL_CHARACTERS);
}

/**
 * Redeems the authorization code and returns the Google profile behind it.
 * `nowMs` defaults to the time the token response arrives; `signal` cancels the token request.
 * @returns {Promise<{ sub: string, email: string, name: string }>}
 */
export async function exchangeCode(config, flow, code, { fetchImpl = fetch, nowMs, signal } = {}) {
  const response = await postTokenRequest(config, flow, code, { fetchImpl, signal });
  const claims = idTokenClaims((await tokenResponseJson(response)).id_token);
  if (!hasValidClaims(claims, config, flow, nowMs ?? Date.now())) throw invalidIdToken();
  if (claims.email_verified !== true) throw new AuthError(AUTH_ERROR.EMAIL_UNVERIFIED);
  const name = isBoundedString(claims.name, MAX_NAME_CHARACTERS) ? claims.name : '';
  return { sub: claims.sub, email: claims.email, name };
}
