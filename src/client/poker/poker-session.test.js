import test from 'node:test';
import assert from 'node:assert/strict';
import { Observable } from 'lib0/observable';
import { Awareness } from 'y-protocols/awareness';

import { clearRoomSession, establishRoomSession } from '../session/room-session.js';
import { openPokerRoom } from './poker-session.js';

const ROOM_HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const SESSION_TTL_MS = 60_000;

class FakeProvider extends Observable {
  static last = null;
  wsconnected = false;
  synced = false;
  connectCalls = 0;
  destroyed = false;
  constructor(url, room, doc, options) {
    super();
    Object.assign(this, { url, room, doc, options });
    this.awareness = new Awareness(doc);
    this._awarenessUpdateHandler = () => {};
    this.awareness.on('update', this._awarenessUpdateHandler);
    FakeProvider.last = this;
  }
  connect() { this.connectCalls += 1; }
  destroy() { this.destroyed = true; this.awareness.destroy(); }
}

function withWindow(context) {
  const previous = globalThis.window;
  globalThis.window = { location: new URL('http://localhost:5173/p/ROOM') };
  context.after(() => {
    clearRoomSession();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

test('opening a room before the session exchange is refused', (context) => {
  withWindow(context);
  clearRoomSession();
  assert.throws(() => openPokerRoom({ browser: new EventTarget(), Provider: FakeProvider }), /room session/);
});

test('the provider joins the opaque room handle, not the link token, and connects once', async (context) => {
  withWindow(context);
  context.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ roomHandle: ROOM_HANDLE, expiresAt: Date.now() + SESSION_TTL_MS }),
    { headers: { 'content-type': 'application/json' } },
  ));
  await establishRoomSession('ROOM', 'Secrettoken12345');
  const room = openPokerRoom({ browser: new EventTarget(), Provider: FakeProvider });
  const provider = FakeProvider.last;
  assert.equal(provider.room, ROOM_HANDLE);
  assert.equal(provider.url.includes('Secrettoken12345'), false);
  assert.equal(provider.options.connect, false);
  assert.equal(provider.options.params.awarenessId, String(room.doc.clientID));
  assert.equal(provider.connectCalls, 1);
  room.doc.transact(() => room.doc.getMap('votes').set('s:u', '5'), 'poker-round');
  assert.equal(room.syncStatus.getSnapshot().hasUnsyncedLocalChanges, true, 'poker edits count as unsynced while offline');
  room.destroy();
  assert.equal(provider.destroyed, true);
});
