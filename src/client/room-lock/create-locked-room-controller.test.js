import test from 'node:test';
import assert from 'node:assert/strict';

import { ACCOUNT_STATUS } from '../account/account-api.js';
import { ROOM_SESSION_ERROR, RoomSessionError, clearRoomSession, createRoom } from '../session/room-session.js';
import { createBoardError, CREATE_LOCK_ERROR } from '../app/create-board-error.js';
import { parseLockParams } from '../../domain/room-lock-contract.js';
import {
  FORM_ERROR, canOfferLockedRoom, createLockedRoomController, validateLockedRoomForm,
} from './create-locked-room-controller.js';

const PASSWORD = 'correct horse battery staple';
const SHORT_PASSWORD = 'too short';
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });
const CREATED = { code: 'ABCD', token: 'Abcdefgh12345678' };
const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const valid = (overrides = {}) => ({ password: PASSWORD, confirmation: PASSWORD, acknowledged: true, ...overrides });
const signedIn = (canCreateLockedRoom) => ({ status: ACCOUNT_STATUS.SIGNED_IN, account: { name: 'Ada', plan: 'free', entitlements: { canCreateLockedRoom } } });

test('the option is offered only to a signed-in account entitled to locked rooms', () => {
  assert.equal(canOfferLockedRoom(signedIn(true)), true);
  assert.equal(canOfferLockedRoom(signedIn(false)), false);
  assert.equal(canOfferLockedRoom({ status: ACCOUNT_STATUS.SIGNED_IN, account: { name: 'Ada', plan: 'free' } }), false);
  for (const status of [null, undefined, ACCOUNT_STATUS.SIGNED_OUT, ACCOUNT_STATUS.DISABLED, ACCOUNT_STATUS.UNAVAILABLE]) {
    assert.equal(canOfferLockedRoom({ status, account: { entitlements: { canCreateLockedRoom: true } } }), false, String(status));
  }
  assert.equal(canOfferLockedRoom(null), false);
});

test('the form needs a long enough password, a matching confirmation and the acknowledgement', () => {
  assert.deepEqual(validateLockedRoomForm(valid()), []);
  assert.deepEqual(validateLockedRoomForm(valid({ password: SHORT_PASSWORD, confirmation: SHORT_PASSWORD })), [FORM_ERROR.TOO_SHORT]);
  assert.deepEqual(validateLockedRoomForm(valid({ confirmation: `${PASSWORD}!` })), [FORM_ERROR.MISMATCH]);
  assert.deepEqual(validateLockedRoomForm(valid({ acknowledged: false })), [FORM_ERROR.UNACKNOWLEDGED]);
  assert.deepEqual(validateLockedRoomForm({ password: '', confirmation: '', acknowledged: false }),
    [FORM_ERROR.TOO_SHORT, FORM_ERROR.UNACKNOWLEDGED]);
});

test('the minimum counts code points, not UTF-16 units', () => {
  const tenEmoji = '😀'.repeat(10);
  const nineEmoji = '😀'.repeat(9);
  assert.deepEqual(validateLockedRoomForm(valid({ password: tenEmoji, confirmation: tenEmoji })), []);
  assert.deepEqual(validateLockedRoomForm(valid({ password: nineEmoji, confirmation: nineEmoji })), [FORM_ERROR.TOO_SHORT]);
});

function setup(context, respond = () => new Response(JSON.stringify(CREATED), { status: HTTP_CREATED, headers: JSON_HEADERS })) {
  const previousWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5180') };
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return respond();
  });
  context.after(() => {
    clearRoomSession();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const opened = [];
  const createBoard = async ({ name, lock }) => {
    await createRoom({ lock });
    opened.push(name);
  };
  return { requests, opened, createBoard, controller: createLockedRoomController() };
}

test('submitting derives a lock and sends exactly { lock } with valid lock params', async (context) => {
  const { requests, opened, createBoard, controller } = setup(context);
  assert.equal(await controller.submit(valid(), { name: 'Sprint 7', createBoard }), true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/rooms$/);
  assert.deepEqual(Object.keys(requests[0].body), ['lock']);
  assert.notEqual(parseLockParams(requests[0].body.lock), null, 'the relay-side parser accepts the lock');
  assert.deepEqual(opened, ['Sprint 7']);
  assert.equal(JSON.stringify(requests[0]).includes(PASSWORD), false, 'the password is never sent');
});

test('plain room creation still sends an empty body', async (context) => {
  const { requests } = setup(context);
  await createRoom();
  assert.deepEqual(requests[0].body, {});
});

test('an invalid form is refused before any key derivation or request', async (context) => {
  const { requests, createBoard, controller } = setup(context);
  assert.equal(await controller.submit(valid({ acknowledged: false }), { name: '', createBoard }), false);
  assert.equal(await controller.submit(valid({ password: SHORT_PASSWORD, confirmation: SHORT_PASSWORD }), { name: '', createBoard }), false);
  assert.equal(requests.length, 0);
});

test('busy is shown while deriving and a second submit is ignored', async (context) => {
  const { requests, createBoard, controller } = setup(context);
  const states = [];
  controller.subscribe(() => states.push(controller.getSnapshot().busy));
  const first = controller.submit(valid(), { name: '', createBoard });
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(await controller.submit(valid(), { name: '', createBoard }), false);
  assert.equal(await first, true);
  assert.deepEqual(states, [true, false]);
  assert.equal(requests.length, 1);
});

test('401 and 403 map to sign-in and plan messages, anything else to the generic failure', async () => {
  const status = (httpStatus) => createBoardError(new RoomSessionError(ROOM_SESSION_ERROR.UNAVAILABLE, { httpStatus }));
  assert.equal(status(HTTP_UNAUTHORIZED).code, CREATE_LOCK_ERROR.SIGN_IN_REQUIRED);
  assert.equal(status(HTTP_FORBIDDEN).code, CREATE_LOCK_ERROR.PLAN_REQUIRED);
  assert.equal(status(500).code, ROOM_SESSION_ERROR.UNAVAILABLE);
});

test('a failed creation clears busy and lets the user retry', async (context) => {
  let fail = true;
  const { createBoard, controller } = setup(context, () => (fail
    ? new Response('', { status: HTTP_FORBIDDEN })
    : new Response(JSON.stringify(CREATED), { status: HTTP_CREATED, headers: JSON_HEADERS })));
  const rejecting = async (args) => { try { await createBoard(args); } catch (error) { assert.equal(error.httpStatus, HTTP_FORBIDDEN); } };
  assert.equal(await controller.submit(valid(), { name: '', createBoard: rejecting }), true);
  assert.equal(controller.getSnapshot().busy, false);
  fail = false;
  assert.equal(await controller.submit(valid(), { name: '', createBoard }), true);
});

test('creating a locked board writes nothing to any browser storage', async (context) => {
  const { createBoard, controller } = setup(context);
  const writes = [];
  const record = (area) => (...args) => { writes.push([area, ...args.map(String)]); };
  const names = ['localStorage', 'sessionStorage', 'indexedDB', 'document'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define('localStorage', { setItem: record('local'), getItem: () => null, removeItem: record('local.remove') });
  define('sessionStorage', { setItem: record('session'), getItem: () => null, removeItem: record('session.remove') });
  define('indexedDB', { open: record('indexedDB.open') });
  define('document', Object.defineProperty({}, 'cookie', { set: record('cookie'), get: () => '' }));
  context.after(() => previous.forEach((descriptor, name) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }));
  await controller.submit(valid(), { name: '', createBoard });
  assert.deepEqual(writes, []);
  globalThis.localStorage.setItem('probe', 'probe');
  assert.equal(writes.length, 1, 'the spy would have seen a write');
});
