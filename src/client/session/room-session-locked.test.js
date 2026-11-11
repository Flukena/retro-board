import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoomLock } from '../room-lock/e2e-crypto.js';
import { ROOM_SESSION_RENEWAL_SUFFIX } from '../../domain/room-lock-contract.js';
import {
  fakeLockedRelay, LOCKED_TEST_CODE as CODE, LOCKED_TEST_HANDLE, LOCKED_TEST_TOKEN as TOKEN,
} from '../../test-support/fake-locked-relay.js';
import * as session from './room-session.js';

const { ROOM_SESSION_ERROR, ROOM_SESSION_HEALTH } = session;
const PASSWORD = 'correct horse battery staple';
const RETRY_AFTER_SECONDS = 42;
const TEST_NOW_MS = 1_700_000_000_000;
const REFRESH_WAIT_MS = 8 * 60 * 60 * 1_000;
const MAX_FLUSH_TURNS = 200;
// The fake relay hashes with real async WebCrypto, so settling takes more than one turn.
const flushRequests = async () => {
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

const fixture = await createRoomLock(PASSWORD);

function installRelay(context, options = {}) {
  const oldWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5180') };
  const relay = fakeLockedRelay({ lock: fixture.lock, authKey: fixture.authKey, ...options });
  context.mock.method(globalThis, 'fetch', relay.fetch);
  context.after(() => {
    session.clearRoomSession();
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  return relay;
}

const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (error) => error);

test('the first exchange of a locked room reads its salt and KDF from the 409 and holds no session', async (context) => {
  const relay = installRelay(context);
  const error = await rejection(session.establishRoomSession(CODE, TOKEN));
  assert.equal(error.code, ROOM_SESSION_ERROR.LOCKED);
  assert.deepEqual(error.lock, { salt: fixture.lock.salt, kdf: fixture.lock.kdf });
  assert.deepEqual(relay.calls, [{ code: CODE, token: TOKEN }]);
  assert.equal(session.getActiveRoomSession(), null);
  assert.equal(session.canRefreshRoomSession(), false);
});

test('a 409 whose body is not a lock description is unavailable, not locked', async (context) => {
  installRelay(context);
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ locked: true, salt: 'x', kdf: {} }), {
    status: 409, headers: { 'content-type': 'application/json' },
  }));
  const error = await rejection(session.establishRoomSession(CODE, TOKEN));
  assert.equal(error.code, ROOM_SESSION_ERROR.UNAVAILABLE);
});

test('the second step sends the authKey, returns the lock grant, and renewals keep sending the key', async (context) => {
  const relay = installRelay(context, { keyEpoch: 3, isOwner: false });
  const result = await session.establishRoomSession(CODE, TOKEN, { authKey: fixture.authKey });
  assert.deepEqual(relay.calls[0], { code: CODE, token: TOKEN, authKey: fixture.authKey });
  assert.deepEqual(result.lock, {
    wrappedDek: fixture.lock.wrappedDek, wrapIv: fixture.lock.wrapIv, keyEpoch: 3, lockRevision: 0, isOwner: false,
  });
  assert.equal(Object.hasOwn(session.getActiveRoomSession(), 'lock'), false);
  await session.refreshActiveRoomSession();
  assert.deepEqual(relay.calls[1], { code: CODE, token: TOKEN, authKey: fixture.authKey });
});

test('a renewal goes to the room-scoped path its session cookie is sent to; the first exchange does not', async (context) => {
  const relay = installRelay(context);
  await session.establishRoomSession(CODE, TOKEN, { authKey: fixture.authKey });
  await session.refreshActiveRoomSession();
  assert.deepEqual(relay.paths, ['/api/room-session', `/rooms/${LOCKED_TEST_HANDLE}${ROOM_SESSION_RENEWAL_SUFFIX}`]);
});

test('after replaceRoomAuthKey renewals send the new key', async (context) => {
  const relay = installRelay(context);
  await session.establishRoomSession(CODE, TOKEN, { authKey: fixture.authKey });
  const next = await createRoomLock('another long password');
  session.replaceRoomAuthKey(next.authKey);
  relay.lock = next.lock;
  await session.refreshActiveRoomSession();
  assert.equal(relay.calls.at(-1).authKey, next.authKey);
});

test('a wrong authKey is WRONG_PASSWORD and a limited one is LOCKED_OUT with its delay', async (context) => {
  const relay = installRelay(context);
  const other = await createRoomLock('some other password');
  const wrong = await rejection(session.establishRoomSession(CODE, TOKEN, { authKey: other.authKey }));
  assert.equal(wrong.code, ROOM_SESSION_ERROR.WRONG_PASSWORD);
  relay.limitedSeconds = RETRY_AFTER_SECONDS;
  const limited = await rejection(session.establishRoomSession(CODE, TOKEN, { authKey: fixture.authKey }));
  assert.equal(limited.code, ROOM_SESSION_ERROR.LOCKED_OUT);
  assert.equal(limited.retryAfterSeconds, RETRY_AFTER_SECONDS);
  assert.equal(session.getActiveRoomSession(), null);
});

test('without an authKey a 403 and a 429 keep their normal-room meaning', async (context) => {
  installRelay(context);
  context.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  assert.equal((await rejection(session.establishRoomSession(CODE, TOKEN))).code, ROOM_SESSION_ERROR.UNAVAILABLE);
  context.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '3' } }));
  assert.equal((await rejection(session.establishRoomSession(CODE, TOKEN))).code, ROOM_SESSION_ERROR.RATE_LIMITED);
});

test('a renewal 403 on a locked room needs re-auth, is not session loss, and is not retried', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: TEST_NOW_MS });
  const relay = installRelay(context);
  await session.establishRoomSession(CODE, TOKEN, { authKey: fixture.authKey });
  const health = [];
  const unsubscribe = session.onRoomSessionHealth(() => health.push(session.getRoomSessionHealth()));
  relay.lock = { ...relay.lock, verifier: relay.lock.salt };
  context.mock.timers.tick(REFRESH_WAIT_MS);
  await flushRequests();
  const requests = relay.calls.length;
  assert.equal(session.getRoomSessionHealth(), ROOM_SESSION_HEALTH.REAUTH_REQUIRED);
  assert.ok(health.length > 0 && health.every((state) => state === ROOM_SESSION_HEALTH.REAUTH_REQUIRED), 'never reported as lost');
  context.mock.timers.tick(REFRESH_WAIT_MS);
  await flushRequests();
  assert.equal(relay.calls.length, requests, 'no automatic retry after a rejected password');
  unsubscribe();
});

test('a direct refresh rejected for the password also asks for re-auth', async (context) => {
  const relay = installRelay(context);
  await session.establishRoomSession(CODE, TOKEN, { authKey: fixture.authKey });
  relay.lock = { ...relay.lock, verifier: relay.lock.salt };
  const error = await rejection(session.refreshActiveRoomSession());
  assert.equal(error.code, ROOM_SESSION_ERROR.WRONG_PASSWORD);
  assert.equal(session.getRoomSessionHealth(), ROOM_SESSION_HEALTH.REAUTH_REQUIRED);
});

test('a renewal that started before a key replacement cannot restore the old key', async (context) => {
  const relay = installRelay(context);
  await session.establishRoomSession(CODE, TOKEN, { authKey: fixture.authKey });
  const next = await createRoomLock('another long password');
  let releaseRenewal;
  const held = new Promise((resolve) => { releaseRenewal = resolve; });
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    const response = await relay.fetch(url, init);
    if (JSON.parse(init.body).authKey === fixture.authKey) await held;
    return response;
  });
  const staleRenewal = session.refreshActiveRoomSession();
  await flushRequests();
  session.replaceRoomAuthKey(next.authKey);
  relay.lock = next.lock;
  releaseRenewal();
  await staleRenewal;
  await session.refreshActiveRoomSession();
  assert.equal(relay.calls.at(-1).authKey, next.authKey);
});
