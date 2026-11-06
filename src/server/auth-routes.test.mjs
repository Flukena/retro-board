import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { AUTH_FLOWS_PER_IP_PER_MINUTE, MAX_PENDING_EXCHANGES, createAuthRoutes, enabledOAuthConfig } from './auth-routes.js';
import { AccountStore } from './account-store.js';
import { AccountSessions } from './auth-session.js';
import { FlowLedger, startAuthorization } from './auth-google.js';
import { checkedStorage, storageOperationError } from './relay-storage.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const BOARD_ORIGIN = 'https://board.example';
const OTHER_ORIGIN = 'https://evil.example';
const ALLOWED_ORIGINS = Object.freeze([BOARD_ORIGIN]);
const FALLBACK_URL = `${BOARD_ORIGIN}/`;
const RETURN_URL = `${BOARD_ORIGIN}/board?room=1`;
const DEV_ORIGIN = 'http://localhost:5173';
const UNAVAILABLE = 'unavailable';
const MAX_COOKIE_HEADER_BYTES = 4096;
const ACCOUNT_KEY_BYTES = 32;
const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;
const OAUTH = Object.freeze({
  clientId: 'client-1', clientSecret: 'secret-1', redirectUri: `${BOARD_ORIGIN}/yjs/api/auth/google/callback`,
  allowInsecureHttp: false, authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token', issuers: Object.freeze(['https://accounts.google.com']),
});
const PROFILE = Object.freeze({ sub: 'google-sub-1', email: 'ada@example.com', name: 'Ada' });
const START = '/api/auth/google/start';
const CALLBACK = '/api/auth/google/callback';
const ACCOUNT = '/api/account';
const LOGOUT = '/api/account/logout';
const LOGOUT_ALL = '/api/account/logout-all';
const DELETE = '/api/account/delete';
const ACCOUNT_COOKIE = /^rb_account=v1\./;
const CLEARED_ACCOUNT_COOKIE = /^rb_account=; Path=\/api; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/;
const CLEARED_FLOW_COOKIE = /^rb_oauth_flow=; Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/;

const base64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function idTokenFor(nonce, profile = PROFILE) {
  const iat = Math.floor(Date.now() / MS_PER_SECOND);
  const claims = { iss: OAUTH.issuers[0], aud: OAUTH.clientId, ...profile, email_verified: true, nonce, iat, exp: iat + SECONDS_PER_HOUR };
  return `${base64urlJson({ alg: 'none' })}.${base64urlJson(claims)}.`;
}

/** Stands in for Google's token endpoint: answers with an ID token for the nonce the test last started. */
function fakeGoogle() {
  const google = { nonce: null, profile: PROFILE, requests: 0, aborts: [], hold: null, fail: false };
  google.fetchImpl = async (url, { signal }) => {
    google.requests += 1;
    const aborted = new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      google.aborts.push(signal.reason.name);
      reject(signal.reason);
    }, { once: true }));
    aborted.catch(() => {});
    if (google.hold) await Promise.race([google.hold, aborted]);
    if (google.fail) throw new TypeError('network down');
    return new Response(JSON.stringify({ id_token: idTokenFor(google.nonce, google.profile) }), { status: 200 });
  };
  return google;
}

async function openStore(t, getMetaOverride) {
  const directory = await mkdtemp(join(tmpdir(), 'auth-routes-'));
  const ldb = new LeveldbPersistence(directory);
  t.after(async () => { await ldb.destroy(); await rm(directory, { recursive: true, force: true }); });
  const { getMeta } = checkedStorage(ldb, Y);
  return new AccountStore({ ldb, getMeta: getMetaOverride ? getMetaOverride(getMeta) : getMeta, hasCapacity: () => true });
}

/** getMeta wrapper: after hold(prefix), the next read of a key with that prefix waits for release(). */
function heldReads() {
  const gate = { prefix: null, release: null, waiting: false };
  const wrap = (getMeta) => async (docName, key) => {
    if (gate.prefix !== null && key.startsWith(gate.prefix)) {
      gate.prefix = null;
      gate.waiting = true;
      await new Promise((resolve) => { gate.release = resolve; });
    }
    return getMeta(docName, key);
  };
  const hold = (prefix) => { gate.prefix = prefix; };
  return { wrap, hold, gate, release: () => gate.release() };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition) {
  while (!condition()) await nextTurn();
}

async function startRoutes(t, overrides = {}) {
  const accountKey = randomBytes(ACCOUNT_KEY_BYTES);
  const google = fakeGoogle();
  const store = overrides.store ?? await openStore(t);
  const failures = [];
  const ledger = overrides.ledger ?? new FlowLedger();
  const lifecycle = { unavailable: false };
  const routes = createAuthRoutes({
    oauth: OAUTH, accountKey, store, ledger, allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: false,
    sessions: new AccountSessions({ signingKey: accountKey, allowInsecureHttp: false, maxCookieHeaderBytes: MAX_COOKIE_HEADER_BYTES }),
    maxCookieHeaderBytes: MAX_COOKIE_HEADER_BYTES, fetchImpl: google.fetchImpl,
    rejectionCounters: { increment: (reason, code) => failures.push(`${reason}:${code}`) },
    ...overrides.routes,
  });
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const handled = routes.handle(req, res, pathname, {
      prefixed: false, clientIp: req.headers['x-test-ip'] || '203.0.113.1', unavailable: () => lifecycle.unavailable,
    });
    if (!handled) { res.writeHead(418); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = 'GET', headers = {} } = {}) => fetch(`${base}${path}`, { method, headers, redirect: 'manual' });
  return { routes, store, google, failures, ledger, lifecycle, accountKey, request, base };
}

const cookieValue = (setCookie) => setCookie.split(';')[0];

async function beginSignIn(ctx, { returnTo = RETURN_URL, ip } = {}) {
  const response = await ctx.request(`${START}?return=${encodeURIComponent(returnTo)}`, { headers: ip ? { 'x-test-ip': ip } : {} });
  const location = new URL(response.headers.get('location'));
  ctx.google.nonce = location.searchParams.get('nonce');
  return { response, state: location.searchParams.get('state'), flowCookie: cookieValue(response.headers.getSetCookie()[0]) };
}

const callback = (ctx, flow, params) => ctx.request(
  `${CALLBACK}?${new URLSearchParams({ state: flow.state, ...params })}`,
  { headers: { cookie: flow.flowCookie } },
);

async function signIn(ctx) {
  const flow = await beginSignIn(ctx);
  const response = await callback(ctx, flow, { code: 'auth-code' });
  const accountCookie = response.headers.getSetCookie().find((cookie) => ACCOUNT_COOKIE.test(cookie));
  return { response, cookie: accountCookie ? cookieValue(accountCookie) : null };
}

const accountGet = (ctx, cookie, origin) => ctx.request(ACCOUNT, { headers: { cookie, ...(origin === undefined ? {} : { origin }) } });
const accountPost = (ctx, path, cookie, origin = BOARD_ORIGIN) => ctx.request(path, {
  method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...(origin === null ? {} : { origin }) },
});

const authErrorOf = (response) => new URL(response.headers.get('location')).searchParams.get('auth_error');
const withoutAuthError = (response) => {
  const location = new URL(response.headers.get('location'));
  location.searchParams.delete('auth_error');
  return location.href;
};

test('auth routes answer 404 when Google is not configured', async (t) => {
  const ctx = await startRoutes(t, { routes: { oauth: null } });
  for (const [path, method] of [[START, 'GET'], [CALLBACK, 'GET'], [ACCOUNT, 'GET'], [ACCOUNT, 'OPTIONS'], [LOGOUT, 'POST'], [DELETE, 'POST']]) {
    const response = await ctx.request(path, { method, headers: { origin: BOARD_ORIGIN } });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal((await ctx.request('/api/rooms')).status, 418, 'unrelated paths are not claimed');
});

test('disabled routes still answer an allowed Origin with credential CORS and refuse a foreign one', async (t) => {
  const disabled = await startRoutes(t, { routes: { oauth: null } });
  const allowed = await accountGet(disabled, '', BOARD_ORIGIN);
  assert.equal(allowed.status, 404);
  assert.equal(allowed.headers.get('access-control-allow-origin'), BOARD_ORIGIN);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  assert.equal((await accountGet(disabled, '', OTHER_ORIGIN)).status, 403);
  const sameOrigin = await accountGet(disabled, '');
  assert.equal(sameOrigin.status, 404);
  assert.equal(sameOrigin.headers.get('access-control-allow-origin'), null);
  const dev = await startRoutes(t, { routes: { oauth: null, allowedOrigins: [], allowInsecureHttp: true } });
  const devResponse = await accountGet(dev, '', DEV_ORIGIN);
  assert.equal(devResponse.status, 404, 'yjs:dev without allowed origins admits the local Vite origin');
  assert.equal(devResponse.headers.get('access-control-allow-origin'), DEV_ORIGIN);
});

test('enabledOAuthConfig refuses sign-in without allowed origins and warns once with a code only', () => {
  const env = { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', GOOGLE_OAUTH_REDIRECT_URI: 'https://board.example/cb' };
  const warnings = [];
  const log = { warn: (...args) => warnings.push(args) };
  assert.equal(enabledOAuthConfig(env, { allowedOrigins: [], allowInsecureHttp: false, publicWall: false, log }), null);
  assert.deepEqual(warnings, [['[yjs] google sign-in disabled', { code: 'OAUTH_NO_ALLOWED_ORIGINS' }]]);
  assert.equal(enabledOAuthConfig(env, { allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: false, publicWall: false, log }).clientId, 'id');
  assert.equal(enabledOAuthConfig({}, { allowedOrigins: [], allowInsecureHttp: false, publicWall: false, log }), null);
  assert.equal(warnings.length, 1, 'unconfigured Google is silent');
});

test('enabledOAuthConfig keeps sign-in off on the Public Wall relay even when Google is configured', () => {
  const env = { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', GOOGLE_OAUTH_REDIRECT_URI: 'https://board.example/cb' };
  const warnings = [];
  const log = { warn: (...args) => warnings.push(args) };
  assert.equal(enabledOAuthConfig(env, { allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: false, publicWall: true, log }), null);
  assert.deepEqual(warnings, [['[yjs] google sign-in disabled', { code: 'OAUTH_PUBLIC_WALL' }]]);
});

test('start sets rb_oauth_flow and redirects to the authorize endpoint', async (t) => {
  const ctx = await startRoutes(t);
  const { response, state } = await beginSignIn(ctx);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, OAUTH.authorizationEndpoint);
  assert.equal(location.searchParams.get('client_id'), OAUTH.clientId);
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^rb_oauth_flow=[^;]+; Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
});

test('callback signs in, redirects to returnTo and sets rb_account while clearing rb_oauth_flow', async (t) => {
  const ctx = await startRoutes(t);
  const { response, cookie } = await signIn(ctx);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), RETURN_URL);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], CLEARED_FLOW_COOKIE);
  assert.match(cookies[1], /^rb_account=v1\.[^;]+; Path=\/api; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  const account = await accountGet(ctx, cookie);
  assert.equal(account.status, 200);
  assert.deepEqual(await account.json(), { name: 'Ada', email: 'ada@example.com', plan: 'free', entitlements: { canCreateLockedRoom: true } });
});

test('callback replayed with the original cookie bytes answers state_mismatch and sets no rb_account', async (t) => {
  const ctx = await startRoutes(t);
  const flow = await beginSignIn(ctx);
  assert.equal((await callback(ctx, flow, { code: 'auth-code' })).status, 302);
  const replay = await callback(ctx, flow, { code: 'auth-code' });
  assert.equal(replay.status, 302);
  assert.equal(authErrorOf(replay), 'state_mismatch');
  assert.equal(withoutAuthError(replay), FALLBACK_URL);
  const cookies = replay.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], CLEARED_FLOW_COOKIE);
  assert.equal(ctx.google.requests, 1, 'the replay never reaches the token endpoint');
});

test('callback with error=access_denied but a mismatched state goes to the fallback with state_mismatch', async (t) => {
  const ctx = await startRoutes(t);
  const flow = await beginSignIn(ctx);
  const response = await callback(ctx, { ...flow, state: 'A'.repeat(43) }, { error: 'access_denied' });
  assert.equal(authErrorOf(response), 'state_mismatch');
  assert.equal(withoutAuthError(response), FALLBACK_URL);
  assert.match(response.headers.getSetCookie()[0], CLEARED_FLOW_COOKIE);
});

test('callback maps provider error to auth_error after a valid flow', async (t) => {
  const ctx = await startRoutes(t);
  const cases = [
    [{ error: 'access_denied' }, 'access_denied'],
    [{ error: 'server_error' }, 'provider_error'],
    [{}, 'provider_error'],
  ];
  for (const [params, expected] of cases) {
    const response = await callback(ctx, await beginSignIn(ctx), params);
    assert.equal(authErrorOf(response), expected, JSON.stringify(params));
    assert.equal(withoutAuthError(response), RETURN_URL);
    assert.equal(response.headers.getSetCookie().length, 1);
  }
  ctx.google.fail = true;
  const failed = await callback(ctx, await beginSignIn(ctx), { code: 'auth-code' });
  assert.equal(authErrorOf(failed), 'token_exchange_failed');
  assert.equal(failed.headers.getSetCookie().some((cookie) => ACCOUNT_COOKIE.test(cookie)), false);
  assert.deepEqual(ctx.failures, ['auth-callback:access_denied', 'auth-callback:provider_error', 'auth-callback:provider_error', 'auth-callback:token_exchange_failed']);
});

test('callback re-checks the signed returnTo and sends a foreign one to the fallback', async (t) => {
  const ctx = await startRoutes(t);
  const started = startAuthorization(OAUTH, `${OTHER_ORIGIN}/steal`, ctx.accountKey, ctx.ledger);
  const location = new URL(started.location);
  ctx.google.nonce = location.searchParams.get('nonce');
  const response = await callback(ctx, { state: location.searchParams.get('state'), flowCookie: cookieValue(started.flowCookie) }, { code: 'auth-code' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), FALLBACK_URL);
});

test('callback after store stop or storage failure issues no session', async (t) => {
  let failReads = false;
  const store = await openStore(t, (getMeta) => (docName, key) => (failReads ? Promise.reject(storageOperationError('injected')) : getMeta(docName, key)));
  const storageFailures = [];
  store.on('storage-failure', (error) => storageFailures.push(error.code));
  const ctx = await startRoutes(t, { store });
  const expectNoSession = async () => {
    const response = await callback(ctx, await beginSignIn(ctx), { code: 'auth-code' });
    assert.equal(response.status, 302);
    assert.equal(authErrorOf(response), UNAVAILABLE);
    assert.equal(withoutAuthError(response), RETURN_URL);
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.some((cookie) => ACCOUNT_COOKIE.test(cookie)), false);
    assert.match(cookies[0], CLEARED_FLOW_COOKIE);
  };

  let release;
  ctx.google.hold = new Promise((resolve) => { release = resolve; });
  const pending = callback(ctx, await beginSignIn(ctx), { code: 'auth-code' });
  while (ctx.google.requests === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.routes.pendingExchanges, 1);
  ctx.lifecycle.unavailable = true;
  release();
  const drained = await pending;
  assert.equal(drained.status, 302, 'shutdown during the exchange issues no session');
  assert.equal(authErrorOf(drained), UNAVAILABLE);
  assert.equal(drained.headers.getSetCookie().some((cookie) => ACCOUNT_COOKIE.test(cookie)), false);
  assert.equal(ctx.routes.pendingExchanges, 0);
  ctx.google.hold = null;
  ctx.lifecycle.unavailable = false;

  failReads = true;
  await expectNoSession();
  assert.deepEqual(storageFailures, ['STORAGE_FAILURE']);
  failReads = false;
  await store.stop();
  await expectNoSession();
  assert.ok(ctx.failures.includes(`auth-callback:${UNAVAILABLE}`));
});

test('a full database sends the callback back with unavailable and counts the capacity code', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-routes-full-'));
  const ldb = new LeveldbPersistence(directory);
  t.after(async () => { await ldb.destroy(); await rm(directory, { recursive: true, force: true }); });
  const store = new AccountStore({ ldb, getMeta: checkedStorage(ldb, Y).getMeta, hasCapacity: () => false });
  const ctx = await startRoutes(t, { store });
  const response = await callback(ctx, await beginSignIn(ctx), { code: 'auth-code' });
  assert.equal(response.status, 302);
  assert.equal(authErrorOf(response), UNAVAILABLE);
  assert.equal(response.headers.getSetCookie().some((cookie) => ACCOUNT_COOKIE.test(cookie)), false);
  assert.deepEqual(ctx.failures, ['auth-callback:DATABASE_CAPACITY']);
});

test('a lifecycle change while the account is being written issues no session', async (t) => {
  const reads = heldReads();
  const store = await openStore(t, reads.wrap);
  const ctx = await startRoutes(t, { store });
  reads.hold('sub:');
  const pending = callback(ctx, await beginSignIn(ctx), { code: 'auth-code' });
  await until(() => reads.gate.waiting);
  ctx.lifecycle.unavailable = true;
  reads.release();
  const response = await pending;
  assert.equal(response.status, 302);
  assert.equal(authErrorOf(response), UNAVAILABLE);
  assert.equal(response.headers.getSetCookie().some((cookie) => ACCOUNT_COOKIE.test(cookie)), false);
  assert.ok(await store.findByEmail(PROFILE.email), 'the queued write still finished');
});

test('callbacks beyond the pending-exchange cap go back with unavailable and leave the flow unclaimed', async (t) => {
  const ctx = await startRoutes(t);
  let release;
  ctx.google.hold = new Promise((resolve) => { release = resolve; });
  const held = [];
  for (let index = 0; index < MAX_PENDING_EXCHANGES; index += 1) {
    const ip = `198.51.100.${index}`;
    const flow = await beginSignIn(ctx, { ip });
    held.push(ctx.request(`${CALLBACK}?${new URLSearchParams({ state: flow.state, code: 'auth-code' })}`, {
      headers: { cookie: flow.flowCookie, 'x-test-ip': ip },
    }));
  }
  await until(() => ctx.google.requests === MAX_PENDING_EXCHANGES);
  assert.equal(ctx.routes.pendingExchanges, MAX_PENDING_EXCHANGES);
  const extra = await beginSignIn(ctx);
  const refused = await callback(ctx, extra, { code: 'auth-code' });
  assert.equal(refused.status, 302);
  assert.equal(authErrorOf(refused), UNAVAILABLE);
  assert.equal(withoutAuthError(refused), FALLBACK_URL);
  assert.equal(ctx.google.requests, MAX_PENDING_EXCHANGES, 'no token request for the refused callback');
  ctx.google.hold = null;
  release();
  await Promise.all(held);
  assert.equal(ctx.routes.pendingExchanges, 0);
  const retried = await callback(ctx, extra, { code: 'auth-code' });
  assert.equal(retried.status, 302);
  assert.ok(retried.headers.getSetCookie().some((cookie) => ACCOUNT_COOKIE.test(cookie)), 'the refused flow can still finish');
});

test('a client that disconnects during the exchange aborts the token request', async (t) => {
  const ctx = await startRoutes(t);
  ctx.google.hold = new Promise(() => {});
  const flow = await beginSignIn(ctx);
  const target = new URL(`${CALLBACK}?${new URLSearchParams({ state: flow.state, code: 'auth-code' })}`, ctx.base);
  const client = http.get(target, { headers: { cookie: flow.flowCookie } });
  client.on('error', () => {});
  await until(() => ctx.google.requests === 1);
  client.destroy();
  await until(() => ctx.google.aborts.length === 1);
  assert.deepEqual(ctx.google.aborts, ['AbortError'], 'aborted by the disconnect, not the token timeout');
  await until(() => ctx.routes.pendingExchanges === 0);
});

test('callback answers that never reach sign-in still clear rb_oauth_flow', async (t) => {
  const ctx = await startRoutes(t);
  const flow = await beginSignIn(ctx);
  const clearsFlowOnly = (response) => assert.deepEqual(response.headers.getSetCookie().map((cookie) => CLEARED_FLOW_COOKIE.test(cookie)), [true]);
  const wrongMethod = await ctx.request(CALLBACK, { method: 'POST', headers: { cookie: flow.flowCookie } });
  assert.equal(wrongMethod.status, 405);
  clearsFlowOnly(wrongMethod);
  ctx.lifecycle.unavailable = true;
  const unavailable = await callback(ctx, flow, { code: 'auth-code' });
  assert.equal(unavailable.status, 302);
  assert.equal(authErrorOf(unavailable), UNAVAILABLE);
  assert.equal(withoutAuthError(unavailable), FALLBACK_URL);
  clearsFlowOnly(unavailable);
  assert.equal(ctx.google.requests, 0);

  const failingLedger = new FlowLedger();
  failingLedger.claim = () => { throw new Error('ledger broke'); };
  const broken = await startRoutes(t, { ledger: failingLedger });
  const crashed = await callback(broken, await beginSignIn(broken), { code: 'auth-code' });
  assert.equal(crashed.status, 503, 'the terminal catch answers');
  clearsFlowOnly(crashed);
});

test('account GET without an Origin header answers 200', async (t) => {
  const ctx = await startRoutes(t);
  const { cookie } = await signIn(ctx);
  const response = await accountGet(ctx, cookie);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const cors = await accountGet(ctx, cookie, BOARD_ORIGIN);
  assert.equal(cors.status, 200);
  assert.equal(cors.headers.get('access-control-allow-origin'), BOARD_ORIGIN);
  assert.equal(cors.headers.get('access-control-allow-credentials'), 'true');
});

test('account GET with a foreign or null Origin answers 403', async (t) => {
  const ctx = await startRoutes(t);
  const { cookie } = await signIn(ctx);
  for (const origin of [OTHER_ORIGIN, 'null']) {
    const response = await accountGet(ctx, cookie, origin);
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('account POSTs reject missing, null and foreign Origin with 403', async (t) => {
  const ctx = await startRoutes(t);
  const { cookie } = await signIn(ctx);
  for (const path of [LOGOUT, LOGOUT_ALL, DELETE]) {
    for (const origin of [null, 'null', OTHER_ORIGIN]) {
      const response = await accountPost(ctx, path, cookie, origin);
      assert.equal(response.status, 403, `${path} ${origin}`);
      assert.equal(response.headers.getSetCookie().length, 0);
    }
  }
  assert.equal((await accountGet(ctx, cookie)).status, 200, 'rejected POSTs changed nothing');
});

test('GET on logout and delete answers 405', async (t) => {
  const ctx = await startRoutes(t);
  for (const path of [LOGOUT, LOGOUT_ALL, DELETE]) {
    const response = await ctx.request(path, { headers: { origin: BOARD_ORIGIN } });
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
  }
  assert.equal((await ctx.request(ACCOUNT, { method: 'POST', headers: { origin: BOARD_ORIGIN } })).status, 405);
  assert.equal((await ctx.request(START, { method: 'POST' })).status, 405);
});

test('account preflight follows the credential origin rules', async (t) => {
  const ctx = await startRoutes(t);
  const allowed = await ctx.request(LOGOUT, { method: 'OPTIONS', headers: { origin: BOARD_ORIGIN } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal((await ctx.request(ACCOUNT, { method: 'OPTIONS', headers: { origin: OTHER_ORIGIN } })).status, 403);
});

test('logout clears the cookie without touching the account', async (t) => {
  const ctx = await startRoutes(t);
  const { cookie } = await signIn(ctx);
  const response = await accountPost(ctx, LOGOUT, cookie);
  assert.equal(response.status, 204);
  assert.match(response.headers.getSetCookie()[0], CLEARED_ACCOUNT_COOKIE);
  assert.equal((await accountGet(ctx, cookie)).status, 200, 'a copied cookie still works until logout-all');
});

test('plain logout still signs out while the relay is unavailable; logout-all and delete do not', async (t) => {
  const ctx = await startRoutes(t);
  const { cookie } = await signIn(ctx);
  ctx.lifecycle.unavailable = true;
  const response = await accountPost(ctx, LOGOUT, cookie);
  assert.equal(response.status, 204);
  assert.match(response.headers.getSetCookie()[0], CLEARED_ACCOUNT_COOKIE);
  assert.equal((await accountPost(ctx, LOGOUT, cookie, OTHER_ORIGIN)).status, 403);
  assert.equal((await accountPost(ctx, LOGOUT_ALL, cookie)).status, 503);
  assert.equal((await accountPost(ctx, DELETE, cookie)).status, 503);
});

test('signed-out account GET clears rb_account only when the request sent one', async (t) => {
  const ctx = await startRoutes(t);
  const none = await accountGet(ctx, '');
  assert.equal(none.status, 401);
  assert.deepEqual(none.headers.getSetCookie(), []);
  for (const cookie of ['rb_account=bogus', 'rb_account=a; rb_account=b', 'theme=dark; rb_account=']) {
    const response = await accountGet(ctx, cookie);
    assert.equal(response.status, 401, cookie);
    assert.match(response.headers.getSetCookie()[0], CLEARED_ACCOUNT_COOKIE, cookie);
  }
});

test('delete with a cookie from before an overlapping logout-all answers 401 and keeps the account', async (t) => {
  const reads = heldReads();
  const store = await openStore(t, reads.wrap);
  const ctx = await startRoutes(t, { store });
  const { cookie } = await signIn(ctx);
  const id = cookie.split('.')[1];
  reads.hold('acct:');
  const loggedOutElsewhere = store.bumpSessionGeneration(id);
  await until(() => reads.gate.waiting);
  const deleting = accountPost(ctx, DELETE, cookie);
  await until(() => store.pendingOperations === 2);
  reads.release();
  assert.equal((await loggedOutElsewhere).sessionGeneration, 1);
  const response = await deleting;
  assert.equal(response.status, 401);
  assert.match(response.headers.getSetCookie()[0], CLEARED_ACCOUNT_COOKIE);
  assert.equal((await store.get(id)).sessionGeneration, 1, 'the account survives');
});

test('account answers 401 and clears the cookie after logout-all', async (t) => {
  const ctx = await startRoutes(t);
  const { cookie } = await signIn(ctx);
  const loggedOut = await accountPost(ctx, LOGOUT_ALL, cookie);
  assert.equal(loggedOut.status, 204);
  assert.match(loggedOut.headers.getSetCookie()[0], CLEARED_ACCOUNT_COOKIE);
  const response = await accountGet(ctx, cookie);
  assert.equal(response.status, 401);
  assert.match(response.headers.getSetCookie()[0], CLEARED_ACCOUNT_COOKIE);
  assert.equal((await accountPost(ctx, LOGOUT_ALL, cookie)).status, 401);
});

test('delete removes the account and a later sign-in creates a new free account', async (t) => {
  const ctx = await startRoutes(t);
  const first = await signIn(ctx);
  const firstId = first.cookie.split('.')[1];
  await ctx.store.setPlan(firstId, 'pro');
  const deleted = await accountPost(ctx, DELETE, first.cookie);
  assert.equal(deleted.status, 204);
  assert.match(deleted.headers.getSetCookie()[0], CLEARED_ACCOUNT_COOKIE);
  assert.equal(await ctx.store.get(firstId), null);
  assert.equal((await accountGet(ctx, first.cookie)).status, 401);
  const second = await signIn(ctx);
  assert.notEqual(second.cookie.split('.')[1], firstId);
  assert.equal((await (await accountGet(ctx, second.cookie)).json()).plan, 'free');
});

test('start beyond 20 per minute from one IP answers 429', async (t) => {
  const ctx = await startRoutes(t);
  for (let index = 0; index < AUTH_FLOWS_PER_IP_PER_MINUTE; index += 1) {
    assert.equal((await beginSignIn(ctx)).response.status, 302);
  }
  const limited = await ctx.request(START);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const limitedCallback = await ctx.request(CALLBACK);
  assert.equal(limitedCallback.status, 302, 'callback shares the per-IP budget');
  assert.equal(authErrorOf(limitedCallback), UNAVAILABLE);
  assert.equal(withoutAuthError(limitedCallback), FALLBACK_URL);
  assert.deepEqual(limitedCallback.headers.getSetCookie().map((cookie) => CLEARED_FLOW_COOKIE.test(cookie)), [true]);
  assert.equal((await beginSignIn(ctx, { ip: '203.0.113.2' })).response.status, 302, 'other IPs keep their own budget');
});

test('per-IP limit runs before the flow ledger so one IP cannot fill it', async (t) => {
  const ledger = new FlowLedger({ maxFlows: AUTH_FLOWS_PER_IP_PER_MINUTE + 1 });
  const ctx = await startRoutes(t, { ledger });
  for (let index = 0; index < AUTH_FLOWS_PER_IP_PER_MINUTE * 2; index += 1) await ctx.request(START);
  assert.equal((await beginSignIn(ctx, { ip: '203.0.113.9' })).response.status, 302);
});

test('every auth response has no-store and no-referrer', async (t) => {
  const ctx = await startRoutes(t);
  const disabled = await startRoutes(t, { routes: { oauth: null } });
  const { cookie } = await signIn(ctx);
  const responses = [
    await disabled.request(ACCOUNT),
    (await beginSignIn(ctx)).response,
    await ctx.request(CALLBACK),
    await accountGet(ctx, cookie),
    await accountGet(ctx, 'rb_account=bogus'),
    await accountGet(ctx, cookie, OTHER_ORIGIN),
    await accountPost(ctx, LOGOUT, cookie, null),
    await ctx.request(LOGOUT),
    await ctx.request(ACCOUNT, { method: 'OPTIONS', headers: { origin: BOARD_ORIGIN } }),
    await accountPost(ctx, LOGOUT, cookie),
  ];
  ctx.lifecycle.unavailable = true;
  responses.push(await accountGet(ctx, cookie));
  for (const response of responses) {
    assert.equal(response.headers.get('cache-control'), 'no-store', `${response.url} ${response.status}`);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', `${response.url} ${response.status}`);
  }
  assert.equal(responses.at(-1).status, 503);
});
