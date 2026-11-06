import { AUTH_ERROR } from '../domain/auth-errors.js';
import { entitlementsFor } from '../domain/plan-entitlements.js';
import {
  AuthError, clearFlowCookie, exchangeCode, googleOAuthConfig, readFlowCookie, returnUrl, startAuthorization,
  verifyFlow, withAuthError,
} from './auth-google.js';
import { DATABASE_CAPACITY_CODE } from './account-store.js';
import { accountCookiePath, authenticateAccount } from './auth-session.js';
import { RETRY_AFTER_SHORT_SECONDS } from './relay-config.js';
import {
  acceptCredentialOrigin, isExactAllowedOrigin, sendCredentialPreflight, sendIfWritable, sendJson, setCredentialCors,
} from './relay-http.js';
import { takeTrafficTokens, trafficBucketFor } from './relay-rate-bucket.js';

// Google sign-in and account routes (bare and /yjs-prefixed; the coordinator
// strips the prefix). They never log: callback failures are counted by code
// through the relay's rejection counters, which flush as one periodic summary.

export const AUTH_FLOWS_PER_IP_PER_MINUTE = 20;
// Callbacks with a token request to Google in flight, relay-wide. The HTTP slot
// is released when a client disconnects, so this bounds outbound work on its
// own: a quarter of the default 128-request HTTP budget (YJS_MAX_HTTP_REQUESTS),
// which at the 10 s token timeout still clears more than 3 sign-ins a second.
export const MAX_PENDING_EXCHANGES = 32;
const SECONDS_PER_MINUTE = 60;
const MAX_FLOW_RATE_BUCKETS = 10_000;
// One token per start or callback; byte budgets are unused.
const FLOW_RATE_LIMITS = Object.freeze({
  maxMessages: AUTH_FLOWS_PER_IP_PER_MINUTE, messagesPerSecond: AUTH_FLOWS_PER_IP_PER_MINUTE / SECONDS_PER_MINUTE,
  maxBytes: 0, bytesPerSecond: 0,
});
const FLOW_TOKEN_BYTES = 0;
const OAUTH_DISABLED_LOG = '[yjs] google sign-in disabled';
const OAUTH_NO_ALLOWED_ORIGINS = 'OAUTH_NO_ALLOWED_ORIGINS';
const OAUTH_PUBLIC_WALL = 'OAUTH_PUBLIC_WALL';
const CALLBACK_FAILURE_REASON = 'auth-callback';
const PROVIDER_ACCESS_DENIED = 'access_denied';
// Counter codes for callbacks refused before the flow is claimed; the user sees 'unavailable'.
const CALLBACK_REFUSAL = Object.freeze({ RATE_LIMITED: 'rate-limited', EXCHANGE_CAP: 'exchange-cap' });
const QUERY_BASE_URL = 'http://relay.invalid';
const ACCOUNT_PREFLIGHT_METHODS = 'GET, POST, OPTIONS';
const ALLOW_GET = 'GET';
const ALLOW_ACCOUNT_GET = 'GET, OPTIONS';
const ALLOW_ACCOUNT_POST = 'POST, OPTIONS';
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_FOUND = 302;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAVAILABLE = 503;
const RESPONSE_HEADERS = Object.freeze({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });

const PATH = Object.freeze({
  START: '/api/auth/google/start',
  CALLBACK: '/api/auth/google/callback',
  ACCOUNT: '/api/account',
  LOGOUT: '/api/account/logout',
  LOGOUT_ALL: '/api/account/logout-all',
  DELETE: '/api/account/delete',
});

// The Public Wall relay never has accounts; otherwise sign-in needs an allowed origin to return to.
const disabledReason = ({ allowedOrigins, publicWall }) => {
  if (publicWall) return OAUTH_PUBLIC_WALL;
  return allowedOrigins.length ? null : OAUTH_NO_ALLOWED_ORIGINS;
};

/** Google settings, or null when unset, on the Public Wall relay, or without an allowed origin. */
export function enabledOAuthConfig(env, { allowedOrigins, allowInsecureHttp, publicWall, log }) {
  const config = googleOAuthConfig(env, { allowInsecureHttp });
  const reason = disabledReason({ allowedOrigins, publicWall });
  if (!config || !reason) return config;
  log.warn(OAUTH_DISABLED_LOG, { code: reason });
  return null;
}

const reply = (res, status, headers = {}) => sendIfWritable(res, status, headers);
const redirect = (res, location, cookies) => reply(res, HTTP_FOUND, { location, 'set-cookie': cookies });
const tooManyRequests = (res) => reply(res, HTTP_TOO_MANY_REQUESTS, { 'retry-after': String(RETRY_AFTER_SHORT_SECONDS) });
const requestQuery = (req) => new URL(req.url, QUERY_BASE_URL).searchParams;
// Capacity keeps its own counter code; every other store failure counts as unavailable.
const storeFailureCode = (error) => (error?.code === DATABASE_CAPACITY_CODE ? DATABASE_CAPACITY_CODE : AUTH_ERROR.UNAVAILABLE);

// Cancels the token request when the client goes away before the answer is sent.
function disconnectSignal(res) {
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
}

// Google's `error` wins over `code`; a callback with neither is a provider fault.
function providerError(query) {
  if (query.has('error')) return query.get('error') === PROVIDER_ACCESS_DENIED ? AUTH_ERROR.ACCESS_DENIED : AUTH_ERROR.PROVIDER_ERROR;
  return query.get('code') ? null : AUTH_ERROR.PROVIDER_ERROR;
}

/**
 * @returns {{ handle(req, res, routePath: string, ctx: { prefixed: boolean, clientIp: string, unavailable: () => boolean }): boolean,
 *   readonly pendingExchanges: number }}
 */
export function createAuthRoutes({
  oauth, accountKey, sessions, store, ledger, allowedOrigins, allowInsecureHttp, maxCookieHeaderBytes, fetchImpl, rejectionCounters,
}) {
  const flowBuckets = new Map();
  let pendingExchanges = 0;
  const fallbackUrl = () => returnUrl(null, allowedOrigins, allowInsecureHttp);
  const takeFlowToken = (clientIp) => takeTrafficTokens(
    trafficBucketFor(flowBuckets, clientIp, FLOW_RATE_LIMITS, MAX_FLOW_RATE_BUCKETS), FLOW_TOKEN_BYTES, FLOW_RATE_LIMITS,
  );
  const recordFailure = (code) => rejectionCounters.increment(CALLBACK_FAILURE_REASON, code);
  const clearAccountCookie = (prefixed) => sessions.clearCookie(accountCookiePath(prefixed));
  // Guests who sent no rb_account get no Set-Cookie.
  const unauthorized = (req, res, prefixed) => reply(
    res, HTTP_UNAUTHORIZED, sessions.hasCookie(req) ? { 'set-cookie': clearAccountCookie(prefixed) } : {},
  );

  function start(req, res, { prefixed, clientIp }) {
    if (!takeFlowToken(clientIp)) { tooManyRequests(res); return; }
    const returnTo = returnUrl(requestQuery(req).get('return'), allowedOrigins, allowInsecureHttp);
    const started = startAuthorization(oauth, returnTo, accountKey, ledger, { prefixed });
    if (!started) { tooManyRequests(res); return; }
    redirect(res, started.location, [started.flowCookie]);
  }

  function verifiedFlow(req, query) {
    try {
      return verifyFlow(query, readFlowCookie(req, maxCookieHeaderBytes), accountKey, ledger);
    } catch (error) {
      if (error instanceof AuthError) return null;
      throw error;
    }
  }

  // Every callback answer is a redirect back to the board, so no user is left on a blank relay page.
  function failCallback(res, returnTo, code, clearFlow, countedCode = code) {
    recordFailure(countedCode);
    redirect(res, withAuthError(returnTo, code), [clearFlow]);
  }

  async function completeSignIn(res, flow, code, { prefixed, unavailable }, clearFlow) {
    const returnTo = returnUrl(flow.returnTo, allowedOrigins, allowInsecureHttp);
    const fail = (authCode, countedCode) => failCallback(res, returnTo, authCode, clearFlow, countedCode);
    let account;
    try {
      const profile = await exchangeCode(oauth, flow, code, { fetchImpl, signal: disconnectSignal(res) });
      if (unavailable()) { fail(AUTH_ERROR.UNAVAILABLE); return; }
      account = await store.upsertFromGoogle(profile);
    } catch (error) {
      if (error instanceof AuthError) fail(error.code);
      else fail(AUTH_ERROR.UNAVAILABLE, storeFailureCode(error));
      return;
    }
    // Shutdown or a storage failure can begin while the queued write runs.
    if (unavailable()) { fail(AUTH_ERROR.UNAVAILABLE); return; }
    redirect(res, returnTo, [clearFlow, sessions.createCookie(account.id, account.sessionGeneration, accountCookiePath(prefixed))]);
  }

  // Checked before the flow is claimed, so a refused callback can be retried with the same flow.
  function callbackRefusal({ unavailable, clientIp }) {
    if (unavailable()) return AUTH_ERROR.UNAVAILABLE;
    if (!takeFlowToken(clientIp)) return CALLBACK_REFUSAL.RATE_LIMITED;
    return pendingExchanges >= MAX_PENDING_EXCHANGES ? CALLBACK_REFUSAL.EXCHANGE_CAP : null;
  }

  async function callback(req, res, ctx) {
    const clearFlow = clearFlowCookie(oauth, { prefixed: ctx.prefixed });
    const refusal = callbackRefusal(ctx);
    if (refusal) { failCallback(res, fallbackUrl(), AUTH_ERROR.UNAVAILABLE, clearFlow, refusal); return; }
    const query = requestQuery(req);
    const flow = verifiedFlow(req, query);
    if (!flow) { failCallback(res, fallbackUrl(), AUTH_ERROR.STATE_MISMATCH, clearFlow); return; }
    const error = providerError(query);
    if (error) { failCallback(res, returnUrl(flow.returnTo, allowedOrigins, allowInsecureHttp), error, clearFlow); return; }
    pendingExchanges += 1;
    try {
      await completeSignIn(res, flow, query.get('code'), ctx, clearFlow);
    } finally {
      pendingExchanges -= 1;
    }
  }

  // Same-origin production fetches send no Origin; any Origin present must be allowed.
  function acceptOptionalOrigin(req, res) {
    const { origin } = req.headers;
    if (origin === undefined) return true;
    if (!isExactAllowedOrigin(origin, allowedOrigins, allowInsecureHttp)) { reply(res, HTTP_FORBIDDEN); return false; }
    setCredentialCors(origin, res);
    return true;
  }

  async function accountGet(req, res, { prefixed }) {
    if (!acceptOptionalOrigin(req, res)) return;
    const account = await authenticateAccount(req, sessions, store);
    if (!account) { unauthorized(req, res, prefixed); return; }
    const { name, email, plan } = account;
    sendJson(res, HTTP_OK, { name, email, plan, entitlements: entitlementsFor(plan) });
  }

  const accountAction = (change) => async (req, res, { prefixed }) => {
    if (!acceptCredentialOrigin(req, res, allowedOrigins, allowInsecureHttp)) return;
    if (change) {
      const account = await authenticateAccount(req, sessions, store);
      // The store re-checks the generation in its queue, so a concurrent logout-all wins.
      const changed = account && await change(account.id, { expectedGeneration: account.sessionGeneration });
      if (!changed) { unauthorized(req, res, prefixed); return; }
    }
    reply(res, HTTP_NO_CONTENT, { 'set-cookie': clearAccountCookie(prefixed) });
  };

  const routes = new Map([
    [PATH.START, { handlers: { GET: start }, allow: ALLOW_GET }],
    [PATH.CALLBACK, { handlers: { GET: callback }, allow: ALLOW_GET, clearsFlowCookie: true, answersWhileUnavailable: true }],
    [PATH.ACCOUNT, { handlers: { GET: accountGet }, allow: ALLOW_ACCOUNT_GET, preflight: true }],
    // Plain logout never touches the store, so it still signs out while the relay is unavailable.
    [PATH.LOGOUT, { handlers: { POST: accountAction(null) }, allow: ALLOW_ACCOUNT_POST, preflight: true, answersWhileUnavailable: true }],
    [PATH.LOGOUT_ALL, {
      handlers: { POST: accountAction((id, options) => store.bumpSessionGeneration(id, options)) }, allow: ALLOW_ACCOUNT_POST, preflight: true,
    }],
    [PATH.DELETE, { handlers: { POST: accountAction((id, options) => store.delete(id, options)) }, allow: ALLOW_ACCOUNT_POST, preflight: true }],
  ]);

  async function run(handler, req, res, ctx) {
    try {
      await handler(req, res, ctx);
    } catch {
      reply(res, HTTP_UNAVAILABLE);
    }
  }

  // The dev client reads /api/account cross-origin, so the 404 meaning "sign-in off" carries credential CORS too.
  function answerDisabled(req, res) {
    if (acceptOptionalOrigin(req, res)) reply(res, HTTP_NOT_FOUND);
  }

  function dispatch(req, res, route, ctx) {
    if (!oauth) { answerDisabled(req, res); return; }
    // Default for every callback answer (429, 405, 503 included); responses that set cookies repeat it.
    if (route.clearsFlowCookie) res.setHeader('set-cookie', [clearFlowCookie(oauth, { prefixed: ctx.prefixed })]);
    if (req.method === 'OPTIONS' && route.preflight) {
      sendCredentialPreflight(req, res, { allowedOrigins, allowInsecureHttp, methods: ACCOUNT_PREFLIGHT_METHODS });
      return;
    }
    const handler = Object.hasOwn(route.handlers, req.method) ? route.handlers[req.method] : null;
    if (!handler) { reply(res, HTTP_METHOD_NOT_ALLOWED, { allow: route.allow }); return; }
    if (!route.answersWhileUnavailable && ctx.unavailable()) { reply(res, HTTP_UNAVAILABLE); return; }
    void run(handler, req, res, ctx);
  }

  return {
    /** True when the path is an auth or account route; the response is then this module's. */
    handle(req, res, routePath, ctx) {
      const route = routes.get(routePath);
      if (!route) return false;
      for (const [name, value] of Object.entries(RESPONSE_HEADERS)) res.setHeader(name, value);
      dispatch(req, res, route, ctx);
      return true;
    },
    get pendingExchanges() { return pendingExchanges; },
  };
}
