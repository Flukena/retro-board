import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountRequestError } from './account-api.js';
import {
  MY_BOARDS_ERROR, MY_BOARDS_STATUS, createMyBoardsController, myBoardsErrorFor, renameTitleFrom, tokenFromLink,
} from './my-boards-controller.js';

const BOARD = Object.freeze({
  code: 'Ab3dEf7h', kind: 'board', locked: false, title: 'Sprint 12', link: '/b/Ab3dEf7h#tok12345tok12345', createdAt: 2, lastActiveAt: 3,
});
const POKER = Object.freeze({
  code: 'Pq9rSt2u', kind: 'poker', locked: false, title: null, link: '/p/Pq9rSt2u#pok12345pok12345', createdAt: 1, lastActiveAt: 1,
});
const refused = (status, code = null) => new AccountRequestError('rooms', status, code);

function harness(overrides = {}) {
  const calls = { list: 0, rename: [], remove: [], forget: [] };
  const api = {
    listRooms: async () => { calls.list += 1; return [BOARD, POKER]; },
    renameRoom: async (code, title) => { calls.rename.push([code, title]); return title; },
    deleteRoom: async (code, confirmCode) => { calls.remove.push([code, confirmCode]); },
    ...overrides,
  };
  const controller = createMyBoardsController({ api, forget: (code, token) => calls.forget.push([code, token]) });
  return { controller, calls };
}

test('errors map to what the user can do next', () => {
  assert.equal(myBoardsErrorFor(refused(401)), MY_BOARDS_ERROR.SIGN_IN);
  assert.equal(myBoardsErrorFor(refused(404)), MY_BOARDS_ERROR.GONE);
  assert.equal(myBoardsErrorFor(refused(409, 'locked-room')), MY_BOARDS_ERROR.LOCKED);
  assert.equal(myBoardsErrorFor(refused(409, 'other')), MY_BOARDS_ERROR.UNAVAILABLE);
  assert.equal(myBoardsErrorFor(refused(429)), MY_BOARDS_ERROR.RATE_LIMITED);
  assert.equal(myBoardsErrorFor(refused(503)), MY_BOARDS_ERROR.UNAVAILABLE);
  assert.equal(myBoardsErrorFor(new TypeError('network')), MY_BOARDS_ERROR.UNAVAILABLE);
});

test('tokenFromLink reads the fragment, or null for a tokenless link', () => {
  assert.equal(tokenFromLink('/b/Ab3dEf7h#tok12345tok12345'), 'tok12345tok12345');
  assert.equal(tokenFromLink('/p/Ab3dEf7h'), null);
  assert.equal(tokenFromLink('/b/Ab3dEf7h#'), null);
});

test('renameTitleFrom trims and enforces the board title bounds', () => {
  assert.equal(renameTitleFrom('  Retro  '), 'Retro');
  assert.equal(renameTitleFrom('   '), null);
  assert.equal(renameTitleFrom('x'.repeat(120)), 'x'.repeat(120));
  assert.equal(renameTitleFrom('x'.repeat(121)), null);
});

test('load moves from loading to ready with the rooms', async () => {
  const { controller } = harness();
  assert.equal(controller.getSnapshot().status, MY_BOARDS_STATUS.LOADING);
  let notified = 0;
  controller.subscribe(() => { notified += 1; });
  await controller.load();
  assert.equal(controller.getSnapshot().status, MY_BOARDS_STATUS.READY);
  assert.deepEqual(controller.getSnapshot().rooms, [BOARD, POKER]);
  assert.ok(notified > 0);
});

test('a failed load shows the mapped error and can be retried', async () => {
  let fail = true;
  const { controller } = harness({ listRooms: async () => { if (fail) throw refused(401); return [BOARD]; } });
  await controller.load();
  assert.equal(controller.getSnapshot().status, MY_BOARDS_STATUS.FAILED);
  assert.equal(controller.getSnapshot().error, MY_BOARDS_ERROR.SIGN_IN);
  fail = false;
  await controller.load();
  assert.equal(controller.getSnapshot().status, MY_BOARDS_STATUS.READY);
  assert.equal(controller.getSnapshot().error, null);
});

test('rename sends the trimmed title and updates the row locally without refetching', async () => {
  const { controller, calls } = harness({ renameRoom: async (code, title) => { calls.rename.push([code, title]); return 'Stored'; } });
  await controller.load();
  assert.equal(await controller.rename(BOARD.code, '  New name '), true);
  assert.deepEqual(calls.rename, [[BOARD.code, 'New name']]);
  assert.equal(controller.getSnapshot().rooms.find((room) => room.code === BOARD.code).title, 'Stored');
  assert.equal(controller.getSnapshot().rooms.find((room) => room.code === POKER.code).title, null);
  assert.equal(calls.list, 1);
});

test('rename refuses an empty or too long title without calling the relay', async () => {
  const { controller, calls } = harness();
  await controller.load();
  assert.equal(await controller.rename(BOARD.code, '   '), false);
  assert.equal(await controller.rename(BOARD.code, 'x'.repeat(121)), false);
  assert.deepEqual(calls.rename, []);
});

test('rename of a locked room maps 409 locked-room and keeps the row', async () => {
  const { controller } = harness({ renameRoom: async () => { throw refused(409, 'locked-room'); } });
  await controller.load();
  assert.equal(await controller.rename(BOARD.code, 'New'), false);
  assert.equal(controller.getSnapshot().error, MY_BOARDS_ERROR.LOCKED);
  assert.equal(controller.getSnapshot().rooms.length, 2);
  assert.equal(controller.getSnapshot().busyCode, null);
});

test('delete runs only on the exact, case-sensitive code', async () => {
  const { controller, calls } = harness();
  await controller.load();
  for (const typed of ['', 'ab3def7h', 'AB3DEF7H', `${BOARD.code} `]) {
    assert.equal(await controller.remove(BOARD.code, typed), false, JSON.stringify(typed));
  }
  assert.deepEqual(calls.remove, []);
  assert.deepEqual(calls.forget, []);
  assert.equal(controller.getSnapshot().rooms.length, 2);
});

test('delete drops the row, forgets the recent entry with its token, and does not refetch', async () => {
  const { controller, calls } = harness();
  await controller.load();
  assert.equal(await controller.remove(BOARD.code, BOARD.code), true);
  assert.deepEqual(calls.remove, [[BOARD.code, BOARD.code]]);
  assert.deepEqual(calls.forget, [[BOARD.code, 'tok12345tok12345']]);
  assert.deepEqual(controller.getSnapshot().rooms, [POKER]);
  assert.equal(calls.list, 1);
});

test('a 404 on an action removes the row and says it is gone; recents are left alone', async () => {
  const { controller, calls } = harness({ deleteRoom: async () => { throw refused(404); } });
  await controller.load();
  assert.equal(await controller.remove(BOARD.code, BOARD.code), false);
  assert.deepEqual(controller.getSnapshot().rooms, [POKER]);
  assert.equal(controller.getSnapshot().error, MY_BOARDS_ERROR.GONE);
  assert.deepEqual(calls.forget, []);
});

test('a refused delete keeps the row and reports the mapped error', async () => {
  for (const [status, expected] of [[401, MY_BOARDS_ERROR.SIGN_IN], [429, MY_BOARDS_ERROR.RATE_LIMITED], [503, MY_BOARDS_ERROR.UNAVAILABLE]]) {
    const { controller, calls } = harness({ deleteRoom: async () => { throw refused(status); } });
    await controller.load();
    assert.equal(await controller.remove(BOARD.code, BOARD.code), false);
    assert.equal(controller.getSnapshot().error, expected);
    assert.equal(controller.getSnapshot().rooms.length, 2);
    assert.deepEqual(calls.forget, []);
  }
});

test('one action at a time: a second action while busy is refused', async () => {
  let release;
  const { controller, calls } = harness({
    deleteRoom: (code, confirmCode) => new Promise((resolve) => { calls.remove.push([code, confirmCode]); release = resolve; }),
  });
  await controller.load();
  const first = controller.remove(BOARD.code, BOARD.code);
  assert.equal(controller.getSnapshot().busyCode, BOARD.code);
  assert.equal(await controller.rename(POKER.code, 'x'), false);
  release();
  assert.equal(await first, true);
  assert.deepEqual(calls.rename, []);
  assert.equal(controller.getSnapshot().busyCode, null);
});

// Same stub as router.test.js: touching Node's own localStorage getter keeps the test process alive.
test('by default a delete forgets the room from this browser\'s recents', async () => {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) },
  });
  const other = { code: POKER.code, token: 'pok12345pok12345', name: '', visitedAt: 1, kind: 'poker' };
  store.set('rb_recents', JSON.stringify([{ code: BOARD.code, token: 'tok12345tok12345', name: 'S', visitedAt: 1, kind: 'board' }, other]));
  const controller = createMyBoardsController({ api: { listRooms: async () => [BOARD, POKER], deleteRoom: async () => {} } });
  await controller.load();
  assert.equal(await controller.remove(BOARD.code, BOARD.code), true);
  assert.deepEqual(JSON.parse(store.get('rb_recents')), [other]);
});
