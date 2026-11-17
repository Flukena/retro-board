import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { attachClientSync } from './client-sync.js';
import { PlainRoomProvider } from './plain-room-provider.js';
import { pageRoomDeleted } from './room-deleted.js';
import { establishRoomSession, refreshActiveRoomSession } from './room-session.js';
import { ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON } from '../../domain/room-ownership.js';

// One test per file: the page's deleted state is terminal for the whole process.
const NOW_MS = 1_700_000_000_000;
const SESSION_TTL_MS = 5_000;
const REFRESH_DELAY_MS = 4_000;
const ALL_TIMERS_MS = 10 * 60 * 1_000;
const CODE = 'TEST';
const TOKEN = 'Abcdefgh12345678';
const HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const WS_BASE = 'ws://localhost:1234/rooms';
const OPEN_STATE = 1;
const CLOSED_STATE = 3;

class ScriptedSocket {
  static opened = [];
  readyState = 0;
  constructor(url) { this.url = url; ScriptedSocket.opened.push(this); }
  open() { this.readyState = OPEN_STATE; this.onopen?.(); }
  closeWith(event) { this.readyState = CLOSED_STATE; this.onclose?.(event); }
  send() { /* sync frames are not inspected here */ }
  close() { this.readyState = CLOSED_STATE; }
}

const sessionResponse = () => new Response(
  JSON.stringify({ roomHandle: HANDLE, expiresAt: Date.now() + SESSION_TTL_MS }),
  { headers: { 'content-type': 'application/json' } },
);
const flushRequests = () => new Promise((resolve) => setImmediate(resolve));

test('a 4004 on the plain provider is terminal: no timer, delayed refresh or explicit connect reconnects', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: NOW_MS });
  const oldWindow = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5173') };
  t.after(() => {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { requests.push(resolve); }));

  const established = establishRoomSession(CODE, TOKEN);
  requests[0](sessionResponse());
  await established;
  const doc = new Y.Doc();
  const browser = new EventTarget();
  const provider = new PlainRoomProvider(WS_BASE, HANDLE, doc, { connect: false, disableBc: true, WebSocketPolyfill: ScriptedSocket });
  t.after(() => { provider.destroy(); doc.destroy(); });
  attachClientSync(provider, doc, browser);
  provider.connect();
  ScriptedSocket.opened[0].open();

  t.mock.timers.tick(REFRESH_DELAY_MS);
  await flushRequests();
  assert.equal(requests.length, 2, 'a renewal is in flight when the room is deleted');
  doc.transact(() => doc.getMap('meta').set('title', 'unsent'), 'local');
  ScriptedSocket.opened[0].closeWith({ code: ROOM_DELETED_CLOSE_CODE, reason: ROOM_DELETED_REASON });
  assert.equal(pageRoomDeleted.isDeleted(), true);

  requests[1](sessionResponse());
  await flushRequests();
  t.mock.timers.tick(ALL_TIMERS_MS);
  await flushRequests();
  provider.connect();
  await assert.rejects(refreshActiveRoomSession());
  t.mock.timers.tick(ALL_TIMERS_MS);
  await flushRequests();
  assert.equal(ScriptedSocket.opened.length, 1, 'no new socket');
  assert.equal(requests.length, 2, 'no new session request');

  const unload = new Event('beforeunload', { cancelable: true });
  browser.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, false, 'leaving a deleted room never asks to keep unsent edits');
});
