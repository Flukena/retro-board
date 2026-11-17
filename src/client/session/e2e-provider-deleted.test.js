import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { E2EProvider } from './e2e-provider.js';
import { createRoomDeletedState } from './room-deleted.js';
import { ROOM_SESSION_ERROR, RoomSessionError } from './room-session.js';
import { ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON } from '../../domain/room-ownership.js';
import { E2E_TEST_HANDLE, roomKey } from '../../test-support/e2e-room-fixture.mjs';

const WS_BASE = 'ws://relay.test/rooms';
const ABNORMAL_CLOSE = Object.freeze({ code: 1006, reason: '' });
const DELETED_CLOSE = Object.freeze({ code: ROOM_DELETED_CLOSE_CODE, reason: ROOM_DELETED_REASON });
const HTTP_NOT_FOUND = 404;
const OPEN_STATE = 1;
const CLOSED_STATE = 3;
const MAX_FLUSH_TURNS = 20;

/** A socket the test opens, refuses or closes by hand. */
class ScriptedSocket {
  static opened = [];
  readyState = 0;
  constructor(url) { this.url = url; ScriptedSocket.opened.push(this); }
  open() { this.readyState = OPEN_STATE; this.onopen?.(); }
  closeWith(event) { this.readyState = CLOSED_STATE; this.onclose?.(event); }
  send() { /* frames are not inspected here */ }
  close() { this.readyState = CLOSED_STATE; }
}

/** Timers run only when the test fires them. */
class ManualTimers {
  #pending = new Map();
  #next = 1;
  setTimeout = (callback) => { const id = this.#next++; this.#pending.set(id, callback); return id; };
  clearTimeout = (id) => { this.#pending.delete(id); };
  now = () => 0;
  get size() { return this.#pending.size; }
  fireAll() {
    const due = [...this.#pending.values()];
    this.#pending.clear();
    due.forEach((callback) => callback());
  }
}

const flush = async () => {
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) await Promise.resolve();
};

/** A session probe the test settles later, so it can still be in flight when the room is deleted. */
function delayedProbe() {
  const calls = [];
  const probe = () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); });
  return { probe, calls };
}

async function deletableProvider(t, probeSession) {
  ScriptedSocket.opened = [];
  const timers = new ManualTimers();
  const doc = new Y.Doc();
  const key = await roomKey();
  const roomDeleted = createRoomDeletedState();
  const provider = new E2EProvider(WS_BASE, E2E_TEST_HANDLE, doc, {
    key, WebSocketImpl: ScriptedSocket, timers, eventTarget: new EventTarget(), probeSession, roomDeleted,
  });
  t.after(() => { provider.destroy(); doc.destroy(); });
  return { provider, timers, key, roomDeleted };
}

test('a 4004 close is terminal: no timer, delayed refresh, health reconnect or re-unlock opens a socket', async (t) => {
  const { probe, calls } = delayedProbe();
  const { provider, timers, key, roomDeleted } = await deletableProvider(t, probe);
  ScriptedSocket.opened[0].closeWith(ABNORMAL_CLOSE);
  timers.fireAll();
  assert.equal(calls.length, 1, 'a refused open probes the session');
  // A health listener reconnects while the probe is still in flight; the relay then deletes the room.
  provider.disconnect();
  provider.connect();
  assert.equal(ScriptedSocket.opened.length, 2);
  ScriptedSocket.opened[1].open();
  ScriptedSocket.opened[1].closeWith(DELETED_CLOSE);
  assert.equal(roomDeleted.isDeleted(), true);
  assert.equal(timers.size, 0, 'no reconnect timer after a deletion');

  calls[0].resolve();
  await flush();
  timers.fireAll();
  provider.disconnect();
  provider.connect();
  provider.setKey(key);
  timers.fireAll();
  await flush();
  assert.equal(ScriptedSocket.opened.length, 2, 'no new socket');
  assert.equal(calls.length, 1, 'no new session request');
  assert.equal(provider.shouldConnect, false);
});

test('a page offline at deletion stops once the session answers 404 instead of probing forever', async (t) => {
  const { probe, calls } = delayedProbe();
  const { provider, timers, roomDeleted } = await deletableProvider(t, probe);
  ScriptedSocket.opened[0].closeWith(ABNORMAL_CLOSE);
  timers.fireAll();
  // The renewal behind the probe saw the room gone and marked the page's deleted state.
  roomDeleted.mark();
  calls[0].reject(new RoomSessionError(ROOM_SESSION_ERROR.INVALID, { httpStatus: HTTP_NOT_FOUND }));
  await flush();
  timers.fireAll();
  provider.connect();
  await flush();
  assert.equal(ScriptedSocket.opened.length, 1, 'no new socket');
  assert.equal(calls.length, 1, 'no new session request');
  assert.equal(timers.size, 0);
});

test('a deletion reported elsewhere on the page cancels a pending reconnect', async (t) => {
  const { probe, calls } = delayedProbe();
  const { timers, roomDeleted } = await deletableProvider(t, probe);
  ScriptedSocket.opened[0].open();
  ScriptedSocket.opened[0].closeWith(ABNORMAL_CLOSE);
  assert.equal(timers.size, 1, 'an ordinary drop schedules a reconnect');
  roomDeleted.mark();
  assert.equal(timers.size, 0);
  timers.fireAll();
  assert.equal(ScriptedSocket.opened.length, 1);
  assert.equal(calls.length, 0);
});
