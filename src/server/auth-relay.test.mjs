import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGoogleOidc } from '../../scripts/fake-google-oidc.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const START_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 3_000;
const HTTP_SHUTDOWN_GRACE_MS = 100;
const TOKEN_HOLD_MS = 600;
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

async function startRelay(t, env, { preload = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'auth-relay-'));
  const args = preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'yjs-server.mjs'] : ['yjs-server.mjs'];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env, YJS_PORT: '0', YJS_HOST: '127.0.0.1', YJS_DB_DIR: join(root, 'db'), YJS_UPLOADS_DIR: join(root, 'uploads'),
      YJS_WIPE_DOCS: '', YJS_MIGRATE_DOCS: '', YJS_ALLOW_LEGACY_ROOMS: '0', YJS_ALLOW_LEGACY_URL_TOKENS: '0', ...GOOGLE_ENV, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve({ code, at: Date.now() })));
  t.after(async () => {
    if (child.exitCode === null) {
      const killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_TIMEOUT_MS);
      child.kill('SIGTERM');
      await exited;
      clearTimeout(killTimer);
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay start timed out\n${output}`)), START_TIMEOUT_MS);
    const inspect = () => {
      const match = output.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on('data', inspect);
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`relay exited ${code}\n${output}`)); });
  });
  return { url: `http://127.0.0.1:${port}`, child, exited, output: () => output };
}

async function startStub(t, options) {
  const stub = await startFakeGoogleOidc(options);
  t.after(() => stub.close());
  return stub;
}

const cookiePair = (setCookie) => setCookie.split(';')[0];
const get = (url, headers = {}) => fetch(url, { headers, redirect: 'manual' });

/** Start → stub consent → the callback URL and flow cookie the browser would carry back. */
async function approvedCallback(relay, stub, prefix, returnTo) {
  const start = await get(`${relay.url}${prefix}/api/auth/google/start?return=${encodeURIComponent(returnTo)}`);
  assert.equal(start.status, 302, relay.output());
  const flowCookie = start.headers.getSetCookie()[0];
  const consent = await get(`${stub.url}/auth${new URL(start.headers.get('location')).search}&decision=approve`);
  assert.equal(consent.status, 302);
  return { flowCookie, url: `${relay.url}${prefix}/api/auth/google/callback${new URL(consent.headers.get('location')).search}` };
}

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

test('drain waits for an in-flight token exchange', async (t) => {
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
  // The grace period closes this connection long before the token answer arrives.
  await get(url, { cookie: cookiePair(flowCookie) }).catch(() => null);
  const { code, at } = await relay.exited;
  assert.ok(releasedAt > 0 && at >= releasedAt, `relay exited ${releasedAt ? at - releasedAt : 'before the token request'} ms after the token answer`);
  assert.equal(code, 0, relay.output());
  assert.match(relay.output(), /\[yjs\] drained/);
});
