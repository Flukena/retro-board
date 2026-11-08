import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGoogleOidc } from '../../scripts/fake-google-oidc.mjs';
import { approvedCallback, startRelay as startHarnessRelay } from '../test-support/relay-harness.mjs';

const HTTP_SHUTDOWN_GRACE_MS = 100;
const TOKEN_HOLD_MS = 600;
// Long enough that the client is still connected when the held token answer arrives.
const LONG_HTTP_SHUTDOWN_GRACE_MS = TOKEN_HOLD_MS * 5;
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SECURE_ORIGIN = 'https://board.example';
const DEV_ORIGIN = 'http://localhost:5173';
const GOOGLE_ENV = Object.freeze({
  GOOGLE_OAUTH_CLIENT_ID: 'relay-test-client', GOOGLE_OAUTH_CLIENT_SECRET: 'relay-test-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:1234/api/auth/google/callback',
});
// Production config cannot point at the stub, so the child's fetch sends Google's token URL there instead.
const TOKEN_REDIRECT_PRELOAD = `
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => original(String(url) === '${GOOGLE_TOKEN_ENDPOINT}' ? process.env.TEST_TOKEN_URL : url, init);
`;

// y-leveldb reports a failed read by resolving null; fail only the accounts document.
const ACCOUNT_READ_FAILURE_PRELOAD = `
  import { createRequire } from 'node:module';
  const require = createRequire(process.cwd() + '/package.json');
  const { LeveldbPersistence } = require('y-leveldb');
  const getMeta = LeveldbPersistence.prototype.getMeta;
  LeveldbPersistence.prototype.getMeta = function (docName, key) {
    return docName === '\\u0000accounts' ? Promise.resolve(null) : getMeta.call(this, docName, key);
  };
`;
const STORAGE_FAILURE_LOG = '[yjs] storage degraded';
const STORAGE_FAILURE_EXIT_TIMEOUT_MS = 5_000;
const exitWithin = (relay, timeoutMs) => Promise.race([
  relay.exited,
  new Promise((resolve) => { setTimeout(() => resolve({ code: null }), timeoutMs).unref(); }),
]);

const startRelay = (t, env, options) => startHarnessRelay(t, { ...GOOGLE_ENV, ...env }, options);

async function startStub(t, options) {
  const stub = await startFakeGoogleOidc(options);
  t.after(() => stub.close());
  return stub;
}

const cookiePair = (setCookie) => setCookie.split(';')[0];
const get = (url, headers = {}) => fetch(url, { headers, redirect: 'manual' });

test('prefixed callback sets Path=/yjs/api; Secure when insecure HTTP is off', async (t) => {
  const stub = await startStub(t, { issuer: GOOGLE_ISSUER });
  const relay = await startRelay(t, {
    YJS_ALLOW_INSECURE_HTTP: '0', YJS_ALLOWED_ORIGINS: SECURE_ORIGIN, TEST_TOKEN_URL: `${stub.url}/token`,
  }, { preload: TOKEN_REDIRECT_PRELOAD });
  const returnTo = `${SECURE_ORIGIN}/board?room=1`;
  const { flowCookie, url } = await approvedCallback(relay, stub, '/yjs', returnTo);
  assert.match(flowCookie, /; Path=\/yjs\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  const response = await get(url, { cookie: cookiePair(flowCookie) });
  assert.equal(response.status, 302, relay.output());
  assert.equal(response.headers.get('location'), returnTo);
  const [clearedFlow, account] = response.headers.getSetCookie();
  assert.match(clearedFlow, /^rb_oauth_flow=; Path=\/yjs\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/);
  assert.match(account, /^rb_account=v1\.[^;]+; Path=\/yjs\/api; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  const profile = await get(`${relay.url}/yjs/api/account`, { cookie: cookiePair(account) });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).plan, 'free');
});

test('callback query is not rejected by the coordinator', async (t) => {
  const stub = await startStub(t);
  const relay = await startRelay(t, {
    YJS_ALLOW_INSECURE_HTTP: 'true', YJS_ALLOWED_ORIGINS: DEV_ORIGIN, GOOGLE_OAUTH_ENDPOINT_BASE: stub.url,
  });
  const returnTo = `${DEV_ORIGIN}/?board=1`;
  const { flowCookie, url } = await approvedCallback(relay, stub, '', returnTo);
  const response = await get(url, { cookie: cookiePair(flowCookie) });
  assert.equal(response.status, 302, relay.output());
  assert.equal(response.headers.get('location'), returnTo);
  const account = response.headers.getSetCookie()[1];
  assert.match(account, /^rb_account=v1\.[^;]+; Path=\/api; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('sign-in routes answer 404 when allowed origins are empty and the relay says why once', async (t) => {
  const stub = await startStub(t);
  const relay = await startRelay(t, { YJS_ALLOW_INSECURE_HTTP: 'true', YJS_ALLOWED_ORIGINS: '', GOOGLE_OAUTH_ENDPOINT_BASE: stub.url });
  assert.equal((await get(`${relay.url}/api/auth/google/start`)).status, 404);
  assert.equal((relay.output().match(/google sign-in disabled/g) || []).length, 1);
  assert.match(relay.output(), /OAUTH_NO_ALLOWED_ORIGINS/);
});

test('drain waits for the token exchange of a client that is still connected', async (t) => {
  let relay;
  let releasedAt = 0;
  const stub = await startStub(t, {
    onTokenRequest: async () => {
      relay.child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, TOKEN_HOLD_MS));
      releasedAt = Date.now();
    },
  });
  relay = await startRelay(t, {
    YJS_ALLOW_INSECURE_HTTP: 'true', YJS_ALLOWED_ORIGINS: DEV_ORIGIN, GOOGLE_OAUTH_ENDPOINT_BASE: stub.url,
    YJS_HTTP_SHUTDOWN_GRACE_MS: String(LONG_HTTP_SHUTDOWN_GRACE_MS),
  });
  const { flowCookie, url } = await approvedCallback(relay, stub, '', `${DEV_ORIGIN}/`);
  const response = await get(url, { cookie: cookiePair(flowCookie) });
  assert.equal(response.status, 302, relay.output());
  assert.equal(new URL(response.headers.get('location')).searchParams.get('auth_error'), 'unavailable', 'no session while draining');
  assert.equal(response.headers.getSetCookie().some((cookie) => cookie.startsWith('rb_account=v1.')), false);
  const { code, at } = await relay.exited;
  assert.ok(releasedAt > 0 && at >= releasedAt, `relay exited ${releasedAt ? at - releasedAt : 'before the token answer'} ms after it`);
  assert.equal(code, 0, relay.output());
  assert.match(relay.output(), /\[yjs\] drained/);
});

// The grace period disconnects the client, which cancels its token request, so
// drain neither waits for Google's answer nor writes an account for nobody.
test('drain cancels a token exchange whose client the grace period disconnected', async (t) => {
  let relay;
  let releasedAt = 0;
  const stub = await startStub(t, {
    onTokenRequest: async () => {
      relay.child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, TOKEN_HOLD_MS));
      releasedAt = Date.now();
    },
  });
  relay = await startRelay(t, {
    YJS_ALLOW_INSECURE_HTTP: 'true', YJS_ALLOWED_ORIGINS: DEV_ORIGIN, GOOGLE_OAUTH_ENDPOINT_BASE: stub.url,
    YJS_HTTP_SHUTDOWN_GRACE_MS: String(HTTP_SHUTDOWN_GRACE_MS),
  });
  const { flowCookie, url } = await approvedCallback(relay, stub, '', `${DEV_ORIGIN}/`);
  await get(url, { cookie: cookiePair(flowCookie) }).catch(() => null);
  const { code } = await relay.exited;
  assert.equal(releasedAt, 0, 'the relay exited before the held token answer');
  assert.equal(code, 0, relay.output());
  assert.match(relay.output(), /\[yjs\] drained/);
});

test('account storage failure takes the relay down through its storage-failure path and issues no session', async (t) => {
  const stub = await startStub(t);
  const relay = await startRelay(t, {
    YJS_ALLOW_INSECURE_HTTP: 'true', YJS_ALLOWED_ORIGINS: DEV_ORIGIN, GOOGLE_OAUTH_ENDPOINT_BASE: stub.url,
  }, { preload: ACCOUNT_READ_FAILURE_PRELOAD });
  assert.equal((await get(`${relay.url}/readyz`)).status, 200);
  const { flowCookie, url } = await approvedCallback(relay, stub, '', `${DEV_ORIGIN}/`);
  const response = await get(url, { cookie: cookiePair(flowCookie) });
  assert.equal(response.status, 302, relay.output());
  assert.equal(new URL(response.headers.get('location')).searchParams.get('auth_error'), 'unavailable');
  assert.equal(response.headers.getSetCookie().some((cookie) => cookie.startsWith('rb_account=v1.')), false);
  const { code } = await exitWithin(relay, STORAGE_FAILURE_EXIT_TIMEOUT_MS);
  assert.ok(code !== null, `relay kept running after the account storage failure\n${relay.output()}`);
  assert.notEqual(code, 0, 'a storage failure exits non-zero so the orchestrator restarts the relay');
  assert.equal((relay.output().match(/storage degraded/g) || []).length, 1, relay.output());
  assert.ok(relay.output().includes(STORAGE_FAILURE_LOG));
});

test('sign-in routes answer 404 on the Public Wall relay even with Google configured', async (t) => {
  const relay = await startRelay(t, { YJS_PUBLIC_WALL: 'true', YJS_ALLOW_INSECURE_HTTP: '0', YJS_ALLOWED_ORIGINS: SECURE_ORIGIN });
  for (const path of ['/api/auth/google/start', '/yjs-public/api/auth/google/start', '/api/account', '/yjs-public/api/account']) {
    assert.equal((await get(`${relay.url}${path}`, { origin: SECURE_ORIGIN })).status, 404, `${path}\n${relay.output()}`);
  }
  assert.match(relay.output(), /OAUTH_PUBLIC_WALL/);
});
