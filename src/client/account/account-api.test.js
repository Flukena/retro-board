import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_ERROR_CODES } from '../../domain/auth-errors.js';
import {
  ACCOUNT_STATUS, deleteAccount, fetchAccount, logout, logoutAll, readAuthError, signInHref,
} from './account-api.js';

const BASE = 'https://retroroom.party/yjs';
const reply = (status, body) => async () => new Response(body === undefined ? null : JSON.stringify(body), { status });

test('fetchAccount maps 404/401/200/503/network', async () => {
  const account = { name: 'Ada', email: 'ada@example.com', plan: 'free', entitlements: {} };
  const status = async (fetchImpl) => (await fetchAccount({ fetchImpl, baseUrl: BASE }));
  assert.deepEqual(await status(reply(404)), { status: ACCOUNT_STATUS.DISABLED });
  assert.deepEqual(await status(reply(401)), { status: ACCOUNT_STATUS.SIGNED_OUT });
  assert.deepEqual(await status(reply(200, account)), { status: ACCOUNT_STATUS.SIGNED_IN, account });
  assert.deepEqual(await status(reply(503)), { status: ACCOUNT_STATUS.UNAVAILABLE });
  assert.deepEqual(await status(async () => { throw new TypeError('network'); }), { status: ACCOUNT_STATUS.UNAVAILABLE });
  assert.deepEqual(await status(reply(200, 'not an account')), { status: ACCOUNT_STATUS.UNAVAILABLE });
});

test('fetchAccount sends credentials to the account route without caching', async () => {
  let seen;
  await fetchAccount({ baseUrl: BASE, fetchImpl: async (url, init) => { seen = { url, init }; return new Response(null, { status: 404 }); } });
  assert.equal(seen.url, `${BASE}/api/account`);
  assert.equal(seen.init.credentials, 'include');
  assert.equal(seen.init.cache, 'no-store');
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test('signInHref never contains the fragment', () => {
  const location = { origin: 'https://retroroom.party', pathname: '/retro', search: '?x=1', hash: '#secret-key' };
  const href = signInHref({ location, baseUrl: BASE });
  const url = new URL(href);
  assert.equal(`${url.origin}${url.pathname}`, `${BASE}/api/auth/google/start`);
  assert.equal(url.searchParams.get('return'), 'https://retroroom.party/retro?x=1');
  assert.ok(!href.includes('secret-key'));
});

test('logout, logoutAll and deleteAccount POST with credentials and report failure', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); };
  await logout({ fetchImpl, baseUrl: BASE });
  await logoutAll({ fetchImpl, baseUrl: BASE });
  await deleteAccount({ fetchImpl, baseUrl: BASE });
  assert.deepEqual(calls.map((c) => c.url), ['logout', 'logout-all', 'delete'].map((p) => `${BASE}/api/account/${p}`));
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'include');
  }
  await assert.rejects(deleteAccount({ fetchImpl: reply(401), baseUrl: BASE }));
});

test('readAuthError ignores unknown codes and strips the parameter', () => {
  const replaced = [];
  const history = { state: { k: 1 }, replaceState: (...args) => replaced.push(args) };
  const at = (search) => ({ pathname: '/', search, hash: '#frag' });
  for (const code of AUTH_ERROR_CODES) {
    replaced.length = 0;
    assert.equal(readAuthError({ location: at(`?a=1&auth_error=${code}`), history }), code);
    assert.equal(replaced[0][2], '/?a=1#frag');
  }
  replaced.length = 0;
  assert.equal(readAuthError({ location: at('?auth_error=<script>'), history }), null);
  assert.equal(replaced[0][2], '/#frag');
  replaced.length = 0;
  assert.equal(readAuthError({ location: at('?a=1'), history }), null);
  assert.equal(replaced.length, 0);
});
