import { AUTH_ERROR } from '../domain/auth-errors.js';
import { entitlementsFor } from '../domain/plan-entitlements.js';
import {
  AuthError, clearFlowCookie, exchangeCode, googleOAuthConfig, readFlowCookie, returnUrl, startAuthorization,
  verifyFlow, withAuthError,
} from './auth-google.js';
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
const DATABASE_CAPACITY_CODE = 'DATABASE_CAPACITY';
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
const HTTP_INSUFFICIENT_STORAGE = 507;
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
const storeFailureStatus = (error) => (error?.code === DATABASE_CAPACITY_CODE ? HTTP_INSUFFICIENT_STORAGE : HTTP_UNAVAILABLE);

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
  const unauthorized = (res, prefixed) => reply(res, HTTP_UNAUTHORIZED, { 'set-cookie': clearAccountCookie(prefixed) });

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

  function failCallback(res, returnTo, code, clearFlow) {
    recordFailure(code);
    redirect(res, withAuthError(returnTo, code), [clearFlow]);
  }

  async function completeSignIn(res, flow, code, { prefixed, unavailable }, clearFlow) {
    const returnTo = returnUrl(flow.returnTo, allowedOrigins, allowInsecureHttp);
    let account;
    try {
      const profile = await exchangeCode(oauth, flow, code, { fetchImpl });
      if (unavailable()) { reply(res, HTTP_UNAVAILABLE, { 'set-cookie': [clearFlow] }); return; }
      account = await store.upsertFromGoogle(profile);
    } catch (error) {
      if (error instanceof AuthError) { failCallback(res, returnTo, error.code, clearFlow); return; }
      reply(res, storeFailureStatus(error), { 'set-cookie': [clearFlow] });
      return;
    }
    redirect(res, returnTo, [clearFlow, sessions.createCookie(account.id, account.sessionGeneration, accountCookiePath(prefixed))]);
  }

  async function callback(req, res, ctx) {
    if (!takeFlowToken(ctx.clientIp)) { tooManyRequests(res); return; }
    const clearFlow = clearFlowCookie(oauth, { prefixed: ctx.prefixed });
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
    if (!account) { unauthorized(res, prefixed); return; }
    const { name, email, plan } = account;
    sendJson(res, HTTP_OK, { name, email, plan, entitlements: entitlementsFor(plan) });
  }

  const accountAction = (change) => async (req, res, { prefixed }) => {
    if (!acceptCredentialOrigin(req, res, allowedOrigins, allowInsecureHttp)) return;
    if (change) {
      const account = await authenticateAccount(req, sessions, store);
      if (!account) { unauthorized(res, prefixed); return; }
      await change(account.id);
    }
    reply(res, HTTP_NO_CONTENT, { 'set-cookie': clearAccountCookie(prefixed) });
  };

  const routes = new Map([
    [PATH.START, { handlers: { GET: start }, allow: ALLOW_GET }],
    [PATH.CALLBACK, { handlers: { GET: callback }, allow: ALLOW_GET, clearsFlowCookie: true }],
    [PATH.ACCOUNT, { handlers: { GET: accountGet }, allow: ALLOW_ACCOUNT_GET, preflight: true }],
    [PATH.LOGOUT, { handlers: { POST: accountAction(null) }, allow: ALLOW_ACCOUNT_POST, preflight: true }],
    [PATH.LOGOUT_ALL, { handlers: { POST: accountAction((id) => store.bumpSessionGeneration(id)) }, allow: ALLOW_ACCOUNT_POST, preflight: true }],
    [PATH.DELETE, { handlers: { POST: accountAction((id) => store.delete(id)) }, allow: ALLOW_ACCOUNT_POST, preflight: true }],
  ]);

  async function run(handler, req, res, ctx) {
    try {
      await handler(req, res, ctx);
    } catch {
      reply(res, HTTP_UNAVAILABLE);
    }
  }

  function dispatch(req, res, route, ctx) {
    if (!oauth) { reply(res, HTTP_NOT_FOUND); return; }
    // Default for every callback answer (429, 405, 503 included); responses that set cookies repeat it.
    if (route.clearsFlowCookie) res.setHeader('set-cookie', [clearFlowCookie(oauth, { prefixed: ctx.prefixed })]);
    if (req.method === 'OPTIONS' && route.preflight) {
      sendCredentialPreflight(req, res, { allowedOrigins, allowInsecureHttp, methods: ACCOUNT_PREFLIGHT_METHODS });
      return;
    }
    const handler = Object.hasOwn(route.handlers, req.method) ? route.handlers[req.method] : null;
    if (!handler) { reply(res, HTTP_METHOD_NOT_ALLOWED, { allow: route.allow }); return; }
    if (ctx.unavailable()) { reply(res, HTTP_UNAVAILABLE); return; }
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
