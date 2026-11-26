import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeLockedRelay, LOCKED_TEST_CODE as CODE, LOCKED_TEST_TOKEN as TOKEN } from '../../test-support/fake-locked-relay.js';
import { clearRoomSession, getRoomSessionHealth, ROOM_SESSION_ERROR } from '../session/room-session.js';
import { rememberedRoomStore } from './remembered-room-store.js';
import { createNextRoomKey, createRoomLock, deriveRoomMasterKey, rewrapRoomLock } from './e2e-crypto.js';
import {
  ROOM_KEY_CHANGED_EVENT, clearRoomKey, dropPreviousKey, establishBoardSession, getRoomKey, isRoomUnlocked,
  forgetRememberedRoom, getPreviousKey, reunlock, unlockRoom, updateLockAfterPasswordChange,
} from './lock-session.js';

const PASSWORD = 'correct horse battery staple';
const NEXT_PASSWORD = 'a second long password';
const ROTATED_PASSWORD = 'a third long password';
const THIRD_PASSWORD = 'a fourth long password';
const THIRD_EPOCH = 3;
const INITIAL_REVISION = 4;
const CHANGED_REVISION = 5;
const FIRST_EPOCH = 1;
const ROTATED_EPOCH = 2;

const first = await createRoomLock(PASSWORD);
const rewrapped = await rewrapRoomLock({ currentPassword: PASSWORD, lock: first.lock, newPassword: NEXT_PASSWORD });
const rotated = await createNextRoomKey(ROTATED_PASSWORD);
const thirdEpochKey = await createNextRoomKey(THIRD_PASSWORD);
const lockHint = { salt: first.lock.salt, kdf: first.lock.kdf };

function setup(context, options = {}) {
  const oldWindow = globalThis.window;
  const events = [];
  globalThis.window = {
    location: new URL('http://localhost:5180'),
    dispatchEvent: (event) => { events.push(event); return true; },
  };
  const relay = fakeLockedRelay({ lock: first.lock, authKey: first.authKey, keyEpoch: FIRST_EPOCH, ...options });
  context.mock.method(globalThis, 'fetch', relay.fetch);
  context.after(() => {
    clearRoomKey();
    clearRoomSession();
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  return { relay, events };
}

const unlock = (password = PASSWORD) => unlockRoom({ code: CODE, token: TOKEN, password, lockHint });

test('unlocking keeps a non-extractable room key and the lock in memory', async (context) => {
  setup(context, { isOwner: false });
  assert.equal(getRoomKey(), null);
  const unlocked = await unlock();
  assert.equal(unlocked.keyEpoch, FIRST_EPOCH);
  assert.equal(unlocked.isOwner, false);
  assert.equal(unlocked.dek.extractable, false);
  assert.equal(unlocked.roomHandle.length, 32);
  assert.deepEqual(unlocked.lock, {
    salt: first.lock.salt, kdf: first.lock.kdf, wrappedDek: first.lock.wrappedDek, wrapIv: first.lock.wrapIv,
  });
  assert.equal(unlocked.previousKeys.size, 0);
  assert.equal(JSON.stringify(unlocked).includes(PASSWORD), false);
  assert.equal(isRoomUnlocked(CODE, TOKEN), true);
  clearRoomKey();
  assert.equal(getRoomKey(), null);
});

test('a wrong password leaves the room locked', async (context) => {
  setup(context);
  await assert.rejects(unlock('definitely the wrong one'), { code: ROOM_SESSION_ERROR.WRONG_PASSWORD });
  assert.equal(getRoomKey(), null);
  assert.equal(isRoomUnlocked(CODE, TOKEN), false);
});

test('an unlocked room skips the plain exchange; a locked one runs it', async (context) => {
  const { relay } = setup(context);
  await assert.rejects(establishBoardSession(CODE, TOKEN), { code: ROOM_SESSION_ERROR.LOCKED });
  await unlock();
  const calls = relay.calls.length;
  await establishBoardSession(CODE, TOKEN);
  assert.equal(relay.calls.length, calls);
});

test('re-unlock after a password change reads the new salt first and keeps the same key epoch', async (context) => {
  const { relay, events } = setup(context);
  const before = await unlock();
  relay.lock = rewrapped.lock;
  const after = await reunlock(NEXT_PASSWORD);
  const [stepOne, stepTwo] = relay.calls.slice(-2);
  assert.equal(Object.hasOwn(stepOne, 'authKey'), false, 'the first call is the plain exchange');
  assert.equal(stepTwo.authKey, rewrapped.authKey);
  assert.equal(after.keyEpoch, before.keyEpoch);
  assert.equal(after.lock.salt, rewrapped.lock.salt);
  assert.equal(after.previousKeys.size, 0, 'a password change keeps the same key, so nothing to retain');
  assert.equal(getRoomSessionHealth(), 'active');
  assert.deepEqual(events.map((event) => [event.type, event.detail]), [
    [ROOM_KEY_CHANGED_EVENT, { keyEpoch: FIRST_EPOCH, epochChanged: false }],
  ]);
});

test('re-unlock after a rotation swaps the key, keeps the previous one until dropped, and announces the epoch', async (context) => {
  const { relay, events } = setup(context);
  const before = await unlock();
  Object.assign(relay, { lock: rotated.lock, authKey: rotated.authKey, keyEpoch: ROTATED_EPOCH });
  const after = await reunlock(ROTATED_PASSWORD);
  assert.equal(after.keyEpoch, ROTATED_EPOCH);
  assert.notEqual(after.dek, before.dek);
  assert.equal(getPreviousKey(FIRST_EPOCH), before.dek);
  assert.equal(relay.calls.at(-1).authKey, rotated.authKey);
  assert.deepEqual(events.at(-1).detail, { keyEpoch: ROTATED_EPOCH, epochChanged: true });
  dropPreviousKey(FIRST_EPOCH);
  assert.equal(getPreviousKey(FIRST_EPOCH), undefined);
  assert.equal(getRoomKey().dek, after.dek);
});

test('consecutive rotations keep every earlier key until each one is dropped', async (context) => {
  const { relay } = setup(context);
  const epochOne = await unlock();
  Object.assign(relay, { lock: rotated.lock, authKey: rotated.authKey, keyEpoch: ROTATED_EPOCH });
  const epochTwo = await reunlock(ROTATED_PASSWORD);
  Object.assign(relay, { lock: thirdEpochKey.lock, authKey: thirdEpochKey.authKey, keyEpoch: THIRD_EPOCH });
  const epochThree = await reunlock(THIRD_PASSWORD);
  assert.equal(epochThree.keyEpoch, THIRD_EPOCH);
  assert.equal(getPreviousKey(FIRST_EPOCH), epochOne.dek);
  assert.equal(getPreviousKey(ROTATED_EPOCH), epochTwo.dek);
  dropPreviousKey(FIRST_EPOCH);
  assert.equal(getPreviousKey(FIRST_EPOCH), undefined);
  assert.equal(getPreviousKey(ROTATED_EPOCH), epochTwo.dek, 'dropping one epoch leaves the other');
  dropPreviousKey(ROTATED_EPOCH);
  assert.equal(getRoomKey().previousKeys.size, 0);
});

test('a wrong password on re-unlock keeps the old key and announces nothing', async (context) => {
  const { relay, events } = setup(context);
  const before = await unlock();
  Object.assign(relay, { lock: rotated.lock, authKey: rotated.authKey, keyEpoch: ROTATED_EPOCH });
  await assert.rejects(reunlock(PASSWORD), { code: ROOM_SESSION_ERROR.WRONG_PASSWORD });
  assert.equal(getRoomKey().dek, before.dek);
  assert.equal(events.length, 0);
});

test('re-unlock needs an unlocked room', async () => {
  clearRoomKey();
  await assert.rejects(reunlock(PASSWORD), { code: ROOM_SESSION_ERROR.INVALID });
});

test('the lock revision is cached from the exchange, advanced by a password change, and refreshed on re-unlock', async (context) => {
  const { relay } = setup(context, { lockRevision: INITIAL_REVISION });
  assert.equal((await unlock()).lockRevision, INITIAL_REVISION);
  updateLockAfterPasswordChange({ lock: rewrapped.lock, authKey: rewrapped.authKey, lockRevision: CHANGED_REVISION });
  assert.equal(getRoomKey().lockRevision, CHANGED_REVISION);
  Object.assign(relay, { lock: rotated.lock, authKey: rotated.authKey, keyEpoch: ROTATED_EPOCH, lockRevision: CHANGED_REVISION + 1 });
  assert.equal((await reunlock(ROTATED_PASSWORD)).lockRevision, CHANGED_REVISION + 1);
});

test('a password-change update needs a valid lock revision and changes nothing without one', async (context) => {
  setup(context, { lockRevision: INITIAL_REVISION });
  await unlock();
  for (const lockRevision of [undefined, -1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => updateLockAfterPasswordChange({ lock: rewrapped.lock, authKey: rewrapped.authKey, lockRevision }), { code: ROOM_SESSION_ERROR.INVALID });
  }
  assert.equal(getRoomKey().lockRevision, INITIAL_REVISION);
  assert.equal(getRoomKey().lock.salt, first.lock.salt);
});

test('after this page changes the password the cache and renewals follow the new record', async (context) => {
  const { relay } = setup(context);
  await unlock();
  updateLockAfterPasswordChange({ lock: rewrapped.lock, authKey: rewrapped.authKey, lockRevision: CHANGED_REVISION });
  assert.equal(getRoomKey().lock.wrappedDek, rewrapped.lock.wrappedDek);
  assert.equal(getRoomKey().lock.salt, rewrapped.lock.salt);
  relay.lock = rewrapped.lock;
  const { refreshActiveRoomSession } = await import('../session/room-session.js');
  await refreshActiveRoomSession();
  assert.equal(relay.calls.at(-1).authKey, rewrapped.authKey);
});

test('unlock and re-unlock write nothing secret to any browser storage', async (context) => {
  const { relay } = setup(context);
  const writes = [];
  const record = (area) => (...args) => { writes.push([area, ...args.map(String)]); };
  const storageSpy = (area) => ({ setItem: record(area), getItem: () => null, removeItem: record(`${area}.remove`) });
  const previous = new Map(['localStorage', 'sessionStorage', 'indexedDB', 'document'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define('localStorage', storageSpy('local'));
  define('sessionStorage', storageSpy('session'));
  define('indexedDB', { open: record('indexedDB.open') });
  define('document', Object.defineProperty({}, 'cookie', { set: record('cookie'), get: () => '' }));
  context.after(() => previous.forEach((descriptor, name) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }));

  await unlock();
  Object.assign(relay, { lock: rotated.lock, authKey: rotated.authKey, keyEpoch: ROTATED_EPOCH });
  await reunlock(ROTATED_PASSWORD);

  const sent = relay.calls.map((call) => call.authKey).filter(Boolean);
  assert.deepEqual(sent, [first.authKey, rotated.authKey], 'the fixtures are the keys the exchange really used');
  assert.deepEqual(writes, [], 'unlock and re-unlock wrote nothing at all');
  globalThis.localStorage.setItem('probe', 'probe');
  assert.equal(writes.length, 1, 'the spy would have seen a write');
  const written = JSON.stringify(writes);
  [PASSWORD, ROTATED_PASSWORD, first.authKey, rotated.authKey].forEach((secret) => assert.equal(written.includes(secret), false));
});


function simulateReopen() {
  clearRoomSession();
  clearRoomKey();
}

const rememberUnlock = () => unlockRoom({ code: CODE, token: TOKEN, password: PASSWORD, lockHint, remember: true });

function device(context) {
  const room = { record: null };
  context.mock.method(rememberedRoomStore, 'save', async (_code, _token, record) => {
    room.record = structuredClone(record);
    return true;
  });
  context.mock.method(rememberedRoomStore, 'read', async () => room.record);
  context.mock.method(rememberedRoomStore, 'remove', async (_code, _token, salt) => {
    if (!salt || room.record?.salt === salt) room.record = null;
    return true;
  });
  return room;
}

test('remembering restores through a fresh relay grant with the current owner role', async (context) => {
  const { relay } = setup(context);
  const browser = device(context);
  assert.equal((await rememberUnlock()).remembered, true);
  assert.deepEqual(Object.keys(browser.record).sort(), ['masterKey', 'salt']);
  assert.equal(browser.record.masterKey.extractable, false);
  simulateReopen();
  relay.isOwner = false;
  const calls = relay.calls.length;
  await Promise.all([establishBoardSession(CODE, TOKEN), establishBoardSession(CODE, TOKEN)]);
  assert.deepEqual(relay.calls.slice(calls), [{ code: CODE, token: TOKEN }, { code: CODE, token: TOKEN, authKey: first.authKey }]);
  assert.equal(getRoomKey().isOwner, false);
  assert.equal(getRoomKey().remembered, true);
  assert.equal(getRoomKey().dek.extractable, false);
});

test('a rotated board asks for the new password without trying the remembered credential', async (context) => {
  const { relay } = setup(context);
  const browser = device(context);
  await rememberUnlock();
  simulateReopen();
  const calls = relay.calls.length;
  Object.assign(relay, { lock: rotated.lock, keyEpoch: ROTATED_EPOCH });
  await assert.rejects(establishBoardSession(CODE, TOKEN), {
    code: ROOM_SESSION_ERROR.LOCKED, lock: { salt: rotated.lock.salt, kdf: rotated.lock.kdf },
  });
  assert.equal(getRoomKey(), null);
  assert.equal(browser.record, null);
  assert.ok(relay.calls.slice(calls).every((body) => !Object.hasOwn(body, 'authKey')));
});

test('a rejected remembered credential is discarded and the password prompt is available', async (context) => {
  const { relay } = setup(context);
  const browser = device(context);
  await rememberUnlock();
  simulateReopen();
  relay.lock = { ...rotated.lock, salt: first.lock.salt };
  await assert.rejects(establishBoardSession(CODE, TOKEN), { code: ROOM_SESSION_ERROR.LOCKED });
  assert.equal(browser.record, null);
  assert.equal(getRoomKey(), null);
});

test('the relay can rate-limit a remembered browser and its next retry can unlock', async (context) => {
  const { relay } = setup(context);
  device(context);
  await rememberUnlock();
  simulateReopen();
  const retryAfterSeconds = 23;
  relay.limitedSeconds = retryAfterSeconds;
  await assert.rejects(establishBoardSession(CODE, TOKEN), { code: ROOM_SESSION_ERROR.RATE_LIMITED, retryAfterSeconds });
  assert.equal(getRoomKey(), null);
  relay.limitedSeconds = null;
  await establishBoardSession(CODE, TOKEN);
  assert.equal(isRoomUnlocked(CODE, TOKEN), true);
});

test('storage failure leaves a manually unlocked board open for this visit', async (context) => {
  setup(context);
  context.mock.method(rememberedRoomStore, 'save', async () => false);
  assert.equal((await rememberUnlock()).remembered, false);
  assert.equal(isRoomUnlocked(CODE, TOKEN), true);
});

test('a failed password proof cannot save a credential', async (context) => {
  setup(context);
  const save = context.mock.method(rememberedRoomStore, 'save');
  await assert.rejects(unlockRoom({ code: CODE, token: TOKEN, password: NEXT_PASSWORD, lockHint, remember: true }), {
    code: ROOM_SESSION_ERROR.WRONG_PASSWORD,
  });
  assert.equal(save.mock.callCount(), 0);
});


test('forget removes saved access without closing the open board', async (context) => {
  setup(context);
  const browser = device(context);
  const open = await rememberUnlock();
  assert.equal(await forgetRememberedRoom(), true);
  assert.equal(getRoomKey().dek, open.dek);
  assert.equal(getRoomKey().remembered, false);
  assert.equal(browser.record, null);
  simulateReopen();
  await assert.rejects(establishBoardSession(CODE, TOKEN), { code: ROOM_SESSION_ERROR.LOCKED });
});

test('a failed forget leaves the menu action available to retry', async (context) => {
  setup(context);
  device(context);
  await rememberUnlock();
  context.mock.method(rememberedRoomStore, 'remove', async () => false);
  assert.equal(await forgetRememberedRoom(), false);
  assert.equal(getRoomKey().remembered, true);
});

test('after another tab forgets, typing a replacement password alone does not remember it again', async (context) => {
  const { relay } = setup(context);
  const browser = device(context);
  await rememberUnlock();
  await rememberedRoomStore.remove(CODE, TOKEN);
  relay.lock = rewrapped.lock;
  await reunlock(NEXT_PASSWORD);
  assert.equal(browser.record, null);
  assert.equal(isRoomUnlocked(CODE, TOKEN), true);
});

test('a re-unlock without remembering leaves a newer device credential saved by another tab intact', async (context) => {
  const { relay } = setup(context);
  const browser = device(context);
  await rememberUnlock();
  relay.lock = rewrapped.lock;
  const { salt, kdf } = rewrapped.lock;
  const peerRecord = { salt, masterKey: await deriveRoomMasterKey(NEXT_PASSWORD, salt, kdf) };
  browser.record = peerRecord;
  await reunlock(NEXT_PASSWORD, false);
  assert.equal(browser.record, peerRecord);
  simulateReopen();
  await establishBoardSession(CODE, TOKEN);
  assert.equal(getRoomKey().remembered, true);
});

test('after an owner changes the password its saved unlock expires', async (context) => {
  const { relay } = setup(context);
  const browser = device(context);
  await rememberUnlock();
  relay.lock = rewrapped.lock;
  await updateLockAfterPasswordChange({ lock: rewrapped.lock, authKey: rewrapped.authKey, lockRevision: CHANGED_REVISION });
  assert.equal(browser.record, null);
  assert.equal(getRoomKey().remembered, false);
  simulateReopen();
  await assert.rejects(establishBoardSession(CODE, TOKEN), { code: ROOM_SESSION_ERROR.LOCKED });
});
