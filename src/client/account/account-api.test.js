import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_ERROR_CODES } from '../../domain/auth-errors.js';
import {
  ACCOUNT_STATUS, AccountRequestError, deleteAccount, deleteRoom, fetchAccount, listRooms, logout, logoutAll, readAuthError,
  renameRoom, signInHref,
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

const ROOM = Object.freeze({
  code: 'Ab3dEf7h', kind: 'board', locked: false, title: 'Sprint 12', link: '/b/Ab3dEf7h#tok12345tok12345', createdAt: 1, lastActiveAt: 2,
});
const recording = (status, body, calls) => async (url, init) => {
  calls.push({ url, init });
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
};

test('listRooms GETs the account rooms with credentials and returns the rooms', async () => {
  const calls = [];
  const rooms = await listRooms({ fetchImpl: recording(200, { rooms: [ROOM] }, calls), baseUrl: BASE });
  assert.deepEqual(rooms, [ROOM]);
  assert.equal(calls[0].url, `${BASE}/api/account/rooms`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.body, undefined);
});

test('listRooms drops entries whose link would leave the site or whose shape is wrong', async () => {
  const bad = [
    { ...ROOM, link: 'https://evil.example/b/x' }, { ...ROOM, link: '//evil.example/b/x' }, { ...ROOM, link: 'javascript:alert(1)' },
    { ...ROOM, kind: 'canvas' }, { ...ROOM, code: 7 }, { ...ROOM, locked: 'no' }, null,
  ];
  const rooms = await listRooms({ fetchImpl: recording(200, { rooms: [...bad, ROOM] }, []), baseUrl: BASE });
  assert.deepEqual(rooms, [ROOM]);
  await assert.rejects(listRooms({ fetchImpl: recording(200, { rooms: 'x' }, []), baseUrl: BASE }));
});

test('renameRoom POSTs exactly { title } as JSON to the room title route', async () => {
  const calls = [];
  const title = await renameRoom('Ab3dEf7h', 'Retro', { fetchImpl: recording(200, { title: 'Retro' }, calls), baseUrl: BASE });
  assert.equal(title, 'Retro');
  assert.equal(calls[0].url, `${BASE}/api/account/rooms/Ab3dEf7h/title`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Retro' });
});

test('deleteRoom POSTs exactly { confirmCode } as JSON to the room delete route', async () => {
  const calls = [];
  await deleteRoom('Ab3dEf7h', 'Ab3dEf7h', { fetchImpl: recording(204, undefined, calls), baseUrl: BASE });
  assert.equal(calls[0].url, `${BASE}/api/account/rooms/Ab3dEf7h/delete`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { confirmCode: 'Ab3dEf7h' });
});

test('room requests reject with the status and the relay error code', async () => {
  const failure = async (promise) => { try { await promise; } catch (error) { return error; } return null; };
  const locked = await failure(renameRoom('Ab3dEf7h', 'x', { fetchImpl: recording(409, { error: 'locked-room' }, []), baseUrl: BASE }));
  assert.ok(locked instanceof AccountRequestError);
  assert.equal(locked.status, 409);
  assert.equal(locked.code, 'locked-room');
  for (const status of [401, 404, 429, 503]) {
    const error = await failure(deleteRoom('Ab3dEf7h', 'Ab3dEf7h', { fetchImpl: recording(status, undefined, []), baseUrl: BASE }));
    assert.equal(error.status, status);
    assert.equal(error.code, null);
  }
});

test('logout and friends keep sending no body', async () => {
  const calls = [];
  await logout({ fetchImpl: recording(204, undefined, calls), baseUrl: BASE });
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers, undefined);
});
