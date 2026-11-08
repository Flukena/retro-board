import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeLockedRelay, LOCKED_TEST_CODE as CODE, LOCKED_TEST_TOKEN as TOKEN } from '../../test-support/fake-locked-relay.js';
import {
  clearRoomSession, establishRoomSession, refreshActiveRoomSession,
} from '../session/room-session.js';
import { createRoomLock } from './e2e-crypto.js';
import { KEY_ROTATED_EVENT, clearRoomKey, unlockRoom } from './lock-session.js';
import { createReunlockController } from './reunlock-controller.js';

const PASSWORD = 'correct horse battery staple';
const fixture = await createRoomLock(PASSWORD);
const lockHint = { salt: fixture.lock.salt, kdf: fixture.lock.kdf };

function setup(context) {
  const oldWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5180') };
  const relay = fakeLockedRelay({ lock: fixture.lock, authKey: fixture.authKey });
  context.mock.method(globalThis, 'fetch', relay.fetch);
  const target = new EventTarget();
  context.after(() => {
    clearRoomKey();
    clearRoomSession();
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  return { relay, target };
}

test('the dialog stays closed on a healthy locked room', async (context) => {
  const { target } = setup(context);
  await establishRoomSession(CODE, TOKEN, { authKey: fixture.authKey });
  assert.equal(createReunlockController(target).getSnapshot(), false);
});

test('a renewal rejected for the password opens the dialog and notifies subscribers', async (context) => {
  const { relay, target } = setup(context);
  await establishRoomSession(CODE, TOKEN, { authKey: fixture.authKey });
  const controller = createReunlockController(target);
  let notified = 0;
  const unsubscribe = controller.subscribe(() => { notified += 1; });
  relay.lock = { ...relay.lock, verifier: relay.lock.salt };
  await assert.rejects(refreshActiveRoomSession());
  assert.equal(controller.getSnapshot(), true);
  assert.ok(notified > 0);
  relay.lock = fixture.lock;
  await refreshActiveRoomSession();
  assert.equal(controller.getSnapshot(), false, 'a healthy renewal closes it again');
  unsubscribe();
});

test('the key-rotated event opens the dialog until the user unlocks again, and unsubscribing detaches it', async (context) => {
  const { target } = setup(context);
  await unlockRoom({ code: CODE, token: TOKEN, password: PASSWORD, lockHint });
  const controller = createReunlockController(target);
  let notified = 0;
  const unsubscribe = controller.subscribe(() => { notified += 1; });
  target.dispatchEvent(new Event(KEY_ROTATED_EVENT));
  assert.equal(controller.getSnapshot(), true);
  assert.equal(notified, 1);
  await assert.rejects(controller.unlock('wrong password entirely'), { code: 'wrong_password' });
  assert.equal(controller.getSnapshot(), true, 'a wrong password keeps the dialog open');
  await controller.unlock(PASSWORD);
  assert.equal(controller.getSnapshot(), false);
  unsubscribe();
  const seen = notified;
  target.dispatchEvent(new Event(KEY_ROTATED_EVENT));
  assert.equal(notified, seen);
});
