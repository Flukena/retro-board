import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { FAILED_UPGRADES_BEFORE_PROBE, PlainRoomProvider } from './plain-room-provider.js';
import { createRoomDeletedState } from './room-deleted.js';
import { ROOM_SESSION_ERROR, RoomSessionError } from './room-session.js';

const WS_BASE = 'ws://localhost:1234/rooms';
const HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
// What a browser reports for a refused upgrade (the relay's 404 for a deleted room): a close before any open.
const REFUSED = Object.freeze({ code: 1006, reason: '' });
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const RETRY_WAIT_MS = 3_000;
const LONG_WAIT_MS = 60_000;
const OPEN_STATE = 1;
const CLOSED_STATE = 3;
const flush = () => new Promise((resolve) => setImmediate(resolve));

class ScriptedSocket {
  static opened = [];
  readyState = 0;
  constructor(url) { this.url = url; ScriptedSocket.opened.push(this); }
  open() { this.readyState = OPEN_STATE; this.onopen?.(); }
  closeWith(event) { this.readyState = CLOSED_STATE; this.onclose?.(event); }
  send() { /* sync frames are not inspected here */ }
  close() { this.readyState = CLOSED_STATE; }
}

function setup(t, probeSession) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
  ScriptedSocket.opened = [];
  const doc = new Y.Doc();
  const roomDeleted = createRoomDeletedState();
  const provider = new PlainRoomProvider(WS_BASE, HANDLE, doc, {
    disableBc: true, WebSocketPolyfill: ScriptedSocket, roomDeleted, probeSession,
  });
  t.after(() => { provider.destroy(); doc.destroy(); });
  const refuseLatest = () => {
    ScriptedSocket.opened.at(-1).closeWith(REFUSED);
    t.mock.timers.tick(RETRY_WAIT_MS);
  };
  return { provider, roomDeleted, refuseLatest };
}

function delayedProbe() {
  const calls = [];
  const probe = () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); });
  return { probe, calls };
}

const refuse = (refuseLatest, times) => { for (let i = 0; i < times; i += 1) refuseLatest(); };

test('repeated refused upgrades probe the session once; a 404 then ends the room for good', async (t) => {
  const { probe, calls } = delayedProbe();
  const { roomDeleted, refuseLatest } = setup(t, probe);
  refuse(refuseLatest, FAILED_UPGRADES_BEFORE_PROBE - 1);
  assert.equal(calls.length, 0, 'no probe below the threshold');
  refuseLatest();
  assert.equal(calls.length, 1);
  refuse(refuseLatest, FAILED_UPGRADES_BEFORE_PROBE);
  assert.equal(calls.length, 1, 'no second probe while one is in flight');
  calls[0].reject(new RoomSessionError(ROOM_SESSION_ERROR.INVALID, { httpStatus: HTTP_NOT_FOUND }));
  await flush();
  assert.equal(roomDeleted.isDeleted(), true);
  const sockets = ScriptedSocket.opened.length;
  ScriptedSocket.opened.at(-1).closeWith(REFUSED);
  t.mock.timers.tick(LONG_WAIT_MS);
  assert.equal(ScriptedSocket.opened.length, sockets, 'no reconnect after the deletion');
});

test('a transient probe failure keeps retrying and probes again after another run of failures', async (t) => {
  const { probe, calls } = delayedProbe();
  const { roomDeleted, refuseLatest } = setup(t, probe);
  refuse(refuseLatest, FAILED_UPGRADES_BEFORE_PROBE);
  calls[0].reject(new RoomSessionError(ROOM_SESSION_ERROR.UNAVAILABLE, { httpStatus: HTTP_UNAVAILABLE }));
  await flush();
  assert.equal(roomDeleted.isDeleted(), false);
  const sockets = ScriptedSocket.opened.length;
  refuse(refuseLatest, FAILED_UPGRADES_BEFORE_PROBE);
  assert.ok(ScriptedSocket.opened.length > sockets, 'it keeps reconnecting');
  assert.equal(calls.length, 2);
});

test('a successful connection resets the failure count', (t) => {
  const { probe, calls } = delayedProbe();
  const { refuseLatest } = setup(t, probe);
  refuse(refuseLatest, FAILED_UPGRADES_BEFORE_PROBE - 1);
  ScriptedSocket.opened.at(-1).open();
  ScriptedSocket.opened.at(-1).closeWith(REFUSED);
  t.mock.timers.tick(RETRY_WAIT_MS);
  refuse(refuseLatest, FAILED_UPGRADES_BEFORE_PROBE - 1);
  assert.equal(calls.length, 0);
});

test('without a probe (the Public Wall) refused upgrades only retry', (t) => {
  const { roomDeleted, refuseLatest } = setup(t, null);
  refuse(refuseLatest, FAILED_UPGRADES_BEFORE_PROBE * 2);
  assert.equal(roomDeleted.isDeleted(), false);
  assert.equal(ScriptedSocket.opened.length, FAILED_UPGRADES_BEFORE_PROBE * 2 + 1);
});
