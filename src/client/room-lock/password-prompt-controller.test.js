import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeLockedRelay, LOCKED_TEST_CODE as CODE, LOCKED_TEST_TOKEN as TOKEN } from '../../test-support/fake-locked-relay.js';
import { clearRoomSession } from '../session/room-session.js';
import { createRoomLock } from './e2e-crypto.js';
import { clearRoomKey, getRoomKey, unlockRoom } from './lock-session.js';
import { createPasswordPromptController } from './password-prompt-controller.js';

const PASSWORD = 'correct horse battery staple';
const LIMIT_SECONDS = 3;
const TICK_MS = 1_000;
const fixture = await createRoomLock(PASSWORD);
const lockHint = { salt: fixture.lock.salt, kdf: fixture.lock.kdf };

// A manual clock: timers run only when the test advances it.
function fakeClock() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (callback, ms) => { pending.set(next, { callback, ms }); return next++; },
    clearTimeout: (id) => pending.delete(id),
    advance() {
      const [[id, { callback, ms }]] = [...pending];
      pending.delete(id);
      callback();
      return ms;
    },
    count: () => pending.size,
  };
}

function setup(context) {
  const oldWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5180') };
  const relay = fakeLockedRelay({ lock: fixture.lock, authKey: fixture.authKey });
  context.mock.method(globalThis, 'fetch', relay.fetch);
  context.after(() => {
    clearRoomKey();
    clearRoomSession();
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  const clock = fakeClock();
  const controller = createPasswordPromptController(
    (password) => unlockRoom({ code: CODE, token: TOKEN, password, lockHint }),
    clock,
  );
  context.after(controller.dispose);
  return { relay, clock, controller };
}

test('a correct password unlocks the room through derive and exchange, showing busy meanwhile', async (context) => {
  const { controller } = setup(context);
  const states = [];
  controller.subscribe(() => states.push(controller.getSnapshot().busy));
  assert.equal(await controller.submit(PASSWORD), true);
  assert.deepEqual(states, [true, false]);
  assert.equal(controller.getSnapshot().error, null);
  assert.equal(getRoomKey().keyEpoch, 1);
});

test('a wrong password shows the inline error and allows another try', async (context) => {
  const { controller } = setup(context);
  assert.equal(await controller.submit('definitely the wrong one'), false);
  assert.deepEqual(controller.getSnapshot(), { busy: false, error: { kind: 'wrong', seconds: 0 }, lockedOutSeconds: 0 });
  assert.equal(await controller.submit(PASSWORD), true);
  assert.equal(controller.getSnapshot().error, null);
});

test('a limited attempt blocks submit and counts down to re-enable it', async (context) => {
  const { relay, clock, controller } = setup(context);
  relay.limitedSeconds = LIMIT_SECONDS;
  assert.equal(await controller.submit(PASSWORD), false);
  assert.deepEqual(controller.getSnapshot().error, { kind: 'locked-out', seconds: LIMIT_SECONDS });
  const calls = relay.calls.length;
  assert.equal(await controller.submit(PASSWORD), false, 'submit is ignored during the lock-out');
  assert.equal(relay.calls.length, calls);
  assert.equal(clock.advance(), TICK_MS);
  assert.equal(controller.getSnapshot().lockedOutSeconds, LIMIT_SECONDS - 1);
  assert.deepEqual(controller.getSnapshot().error, { kind: 'locked-out', seconds: LIMIT_SECONDS - 1 });
  clock.advance();
  clock.advance();
  assert.deepEqual(controller.getSnapshot(), { busy: false, error: null, lockedOutSeconds: 0 });
  assert.equal(clock.count(), 0, 'the countdown stops by itself');
  relay.limitedSeconds = null;
  assert.equal(await controller.submit(PASSWORD), true);
});

test('disposing stops a running countdown', async (context) => {
  const { relay, clock, controller } = setup(context);
  relay.limitedSeconds = LIMIT_SECONDS;
  await controller.submit(PASSWORD);
  assert.equal(clock.count(), 1);
  controller.dispose();
  assert.equal(clock.count(), 0);
});
