import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROOM_SESSION_ERROR,
  RoomSessionError,
  normalizeRoomFetchPath,
  validateCreatedRoomResponse,
  validateRoomSessionResponse,
} from './room-session.js';

const TOKEN = 'Abcdefgh12345678';
const HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';

const assertUnavailable = (fn) => assert.throws(fn, (error) => (
  error instanceof RoomSessionError
  && error.code === ROOM_SESSION_ERROR.UNAVAILABLE
  && !error.message.includes(TOKEN)
));

test('validates and narrows room creation responses', () => {
  const response = validateCreatedRoomResponse({
    code: 'ABC12345', token: TOKEN, ignored: 'not retained',
  });
  assert.deepEqual(response, { code: 'ABC12345', token: TOKEN });
  assert.equal(Object.isFrozen(response), true);

  assertUnavailable(() => validateCreatedRoomResponse(null));
  assertUnavailable(() => validateCreatedRoomResponse({ code: 'ab', token: TOKEN }));
  assertUnavailable(() => validateCreatedRoomResponse({ code: 'ABC12345', token: 'short' }));
});

test('accepts only a bounded future session with an exact room handle', () => {
  const now = 1_700_000_000_000;
  const response = validateRoomSessionResponse({
    roomHandle: HANDLE,
    expiresAt: now + 8 * 60 * 60 * 1_000,
    ignored: true,
  }, now);
  assert.deepEqual(response, {
    roomHandle: HANDLE,
    expiresAt: now + 8 * 60 * 60 * 1_000,
  });

  assertUnavailable(() => validateRoomSessionResponse({
    roomHandle: `${HANDLE}x`, expiresAt: now + 1,
  }, now));
  assertUnavailable(() => validateRoomSessionResponse({
    roomHandle: HANDLE, expiresAt: now,
  }, now));
  assertUnavailable(() => validateRoomSessionResponse({
    roomHandle: HANDLE, expiresAt: now + 8 * 24 * 60 * 60 * 1_000,
  }, now));
  assertUnavailable(() => validateRoomSessionResponse({
    roomHandle: HANDLE, expiresAt: now + 1.5,
  }, now));
});

test('normalizes only relative room subpaths', () => {
  assert.equal(normalizeRoomFetchPath('/upload'), '/upload');
  assert.equal(normalizeRoomFetchPath('assets/image'), '/assets/image');

  [
    '', '//evil.example/upload', '../upload', 'a/../upload',
    'upload?token=secret', 'upload#secret', 'upload\\file',
  ].forEach((path) => assertUnavailable(() => normalizeRoomFetchPath(path)));
});

test('typed room errors expose only generic safe metadata', () => {
  const error = new RoomSessionError(ROOM_SESSION_ERROR.RATE_LIMITED, {
    retryAfterSeconds: 12,
  });
  assert.equal(error.code, ROOM_SESSION_ERROR.RATE_LIMITED);
  assert.equal(error.retryAfterSeconds, 12);
  assert.equal(error.message, 'Room access is temporarily rate limited.');
});

const TEST_NOW_MS = 1_700_000_000_000;
const TEST_SESSION_TTL_MS = 5_000;
const TEST_REFRESH_DELAY_MS = 4_000;
const TEST_RETRY_AFTER_SECONDS = 120;
const MS_PER_SECOND = 1_000;
const flushRequests = () => new Promise((resolve) => setImmediate(resolve));

test('refresh honours Retry-After and continues after cookie expiry', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: TEST_NOW_MS });
  const oldWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5180') };
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    if (requests > 1) return new Response('', { status: 429,
      headers: { 'retry-after': String(TEST_RETRY_AFTER_SECONDS) } });
    return new Response(JSON.stringify({ roomHandle: HANDLE,
      expiresAt: Date.now() + TEST_SESSION_TTL_MS }),
    { headers: { 'content-type': 'application/json' } });
  });
  try {
    const session = await import('./room-session.js?retry-test');
    await session.establishRoomSession('TEST', TOKEN);
    context.mock.timers.tick(TEST_REFRESH_DELAY_MS);
    await flushRequests();
    assert.equal(requests, 2);
    context.mock.timers.tick(TEST_RETRY_AFTER_SECONDS * MS_PER_SECOND - 1);
    await flushRequests();
    assert.equal(requests, 2, 'must not retry before Retry-After');
    context.mock.timers.tick(1);
    await flushRequests();
    assert.equal(requests, 3, 'must keep retrying beyond expiry');
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

const TEST_LONG_SESSION_TTL_MS = 60_000;
const TEST_LONG_REFRESH_DELAY_MS = 48_000;
const TEST_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

test('refresh failure surfaces session loss, caps backoff and recovers with in-memory credentials', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: TEST_NOW_MS });
  const oldWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5180') };
  let requests = 0;
  let healthy = true;
  const health = [];
  context.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests += 1;
    assert.deepEqual(JSON.parse(init.body), { code: 'TEST', token: TOKEN });
    if (!healthy) throw new TypeError('network down');
    return new Response(JSON.stringify({ roomHandle: HANDLE,
      expiresAt: Date.now() + TEST_LONG_SESSION_TTL_MS }),
    { headers: { 'content-type': 'application/json' } });
  });
  try {
    const session = await import('./room-session.js?backoff-test');
    const unsubscribe = session.onRoomSessionHealth(() => health.push(session.getRoomSessionHealth()));
    await session.establishRoomSession('TEST', TOKEN);
    assert.equal(session.canRefreshRoomSession(), true);
    healthy = false;
    context.mock.timers.tick(TEST_LONG_REFRESH_DELAY_MS);
    await flushRequests();
    assert.equal(session.getRoomSessionHealth(), 'session-lost');
    for (const delay of TEST_RETRY_DELAYS_MS) {
      const before = requests;
      context.mock.timers.tick(delay - 1);
      await flushRequests();
      assert.equal(requests, before);
      context.mock.timers.tick(1);
      await flushRequests();
      assert.equal(requests, before + 1);
    }
    healthy = true;
    await session.refreshActiveRoomSession();
    assert.equal(session.getRoomSessionHealth(), 'active');
    assert.ok(health.includes('session-lost'));
    const before = requests;
    context.mock.timers.tick(TEST_RETRY_DELAYS_MS.at(-1));
    await flushRequests();
    assert.equal(requests, before, 'successful recovery cancels the scheduled retry');
    unsubscribe();
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});
