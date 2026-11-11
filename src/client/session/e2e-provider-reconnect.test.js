import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { E2EProvider } from './e2e-provider.js';
import { ROOM_SESSION_ERROR, RoomSessionError } from './room-session.js';
import { E2E_TEST_HANDLE, roomKey } from '../../test-support/e2e-room-fixture.mjs';

const WS_BASE = 'ws://relay.test/rooms';
// What a browser reports for a refused upgrade (401 after a missed rotation): a close before any open.
const ABNORMAL_CLOSE = Object.freeze({ code: 1006, reason: '' });
const MAX_FLUSH_TURNS = 20;

/** A socket whose upgrade is refused: tests close it before it ever opens. */
class RefusedSocket {
  static opened = [];
  readyState = 0;
  constructor(url) { this.url = url; RefusedSocket.opened.push(this); }
  refuse() { this.readyState = 3; this.onclose?.(ABNORMAL_CLOSE); }
  send() { throw new Error('a refused socket never sends'); }
  close() { this.readyState = 3; }
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

async function refusedProvider(t, probeSession) {
  RefusedSocket.opened = [];
  const timers = new ManualTimers();
  const doc = new Y.Doc();
  const key = await roomKey();
  const provider = new E2EProvider(WS_BASE, E2E_TEST_HANDLE, doc, {
    key, WebSocketImpl: RefusedSocket, timers, eventTarget: new EventTarget(), probeSession,
  });
  t.after(() => { provider.destroy(); doc.destroy(); });
  const refuseAndWait = async () => {
    RefusedSocket.opened.at(-1).refuse();
    timers.fireAll();
    await flush();
  };
  return { provider, timers, key, refuseAndWait };
}

test('a socket refused before it opens probes the session once with backoff, then keeps reconnecting', async (t) => {
  let probes = 0;
  const { timers, refuseAndWait } = await refusedProvider(t, async () => { probes += 1; });
  assert.equal(probes, 0, 'no probe before the first failure');
  await refuseAndWait();
  assert.equal(probes, 1);
  assert.equal(RefusedSocket.opened.length, 2, 'it reconnects after a probe that renewed the session');
  await refuseAndWait();
  await refuseAndWait();
  assert.equal(probes, 1, 'one probe per run of failed opens');
  assert.equal(RefusedSocket.opened.length, 4);
  assert.equal(timers.size, 0);
});

test('a probe that needs the password stops reconnecting until the page re-unlocks', async (t) => {
  const reauth = new RoomSessionError(ROOM_SESSION_ERROR.WRONG_PASSWORD, { httpStatus: 403 });
  const { provider, timers, key, refuseAndWait } = await refusedProvider(t, async () => { throw reauth; });
  await refuseAndWait();
  assert.equal(RefusedSocket.opened.length, 1, 'no reconnect loop under the re-unlock dialog');
  assert.equal(timers.size, 0);
  provider.connect();
  assert.equal(RefusedSocket.opened.length, 1, 'connect waits for the new key');
  provider.setKey(key);
  assert.equal(RefusedSocket.opened.length, 2, 're-unlocking reconnects');
});

test('a re-auth probe stops the loop even when a health listener reconnected before the probe settled', async (t) => {
  const reauth = new RoomSessionError(ROOM_SESSION_ERROR.WRONG_PASSWORD, { httpStatus: 403 });
  let provider = null;
  // client-sync reacts to the REAUTH_REQUIRED health change, sent before the probe's own promise settles.
  const probe = async () => {
    provider.disconnect();
    provider.connect();
    throw reauth;
  };
  const fixture = await refusedProvider(t, probe);
  ({ provider } = fixture);
  await fixture.refuseAndWait();
  assert.equal(RefusedSocket.opened.length, 2, 'the listener opened one more socket');
  RefusedSocket.opened.at(-1).refuse();
  await flush();
  assert.equal(fixture.timers.size, 0, 'no reconnect is scheduled under the re-unlock dialog');
  provider.setKey(fixture.key);
  assert.equal(RefusedSocket.opened.length, 3, 're-unlocking reconnects');
});

test('a probe that fails for another reason keeps the reconnect backoff going', async (t) => {
  const unavailable = new RoomSessionError(ROOM_SESSION_ERROR.UNAVAILABLE);
  const { refuseAndWait } = await refusedProvider(t, async () => { throw unavailable; });
  await refuseAndWait();
  assert.equal(RefusedSocket.opened.length, 2);
});

test('an inconclusive probe is retried on the next failed open, and a later re-auth answer stops the loop', async (t) => {
  const answers = [
    new RoomSessionError(ROOM_SESSION_ERROR.UNAVAILABLE, { httpStatus: 503 }),
    new RoomSessionError(ROOM_SESSION_ERROR.WRONG_PASSWORD, { httpStatus: 403 }),
  ];
  let probes = 0;
  const { provider, timers, key, refuseAndWait } = await refusedProvider(t, async () => { throw answers[probes++]; });
  await refuseAndWait();
  assert.equal(probes, 1);
  assert.equal(RefusedSocket.opened.length, 2, 'a transient probe failure reconnects');
  await refuseAndWait();
  assert.equal(probes, 2, 'the next refused open probes again');
  assert.equal(RefusedSocket.opened.length, 2, 'the re-auth answer holds every reconnect');
  assert.equal(timers.size, 0);
  provider.setKey(key);
  assert.equal(RefusedSocket.opened.length, 3, 're-unlocking reconnects');
});
