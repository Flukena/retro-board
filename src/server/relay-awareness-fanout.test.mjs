import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { coalesceAwarenessSends } from './relay-awareness-fanout.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } = require('y-protocols/awareness');
const MAX_FRAME_BYTES = 262144;
const FLUSH_WINDOW_MS = 50;
const AWARENESS_TYPE = 1;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const HEARTBEAT_USER_COUNT = 500;

function frame(awareness, ids = [awareness.clientID]) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, AWARENESS_TYPE);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, ids));
  return encoding.toUint8Array(encoder);
}

function sourceAwareness(t) {
  const doc = new Y.Doc();
  const source = new Awareness(doc);
  t.after(() => { source.destroy(); doc.destroy(); });
  return source;
}

function fixture(t, maxBytes = MAX_FRAME_BYTES) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new Y.Doc();
  const receiver = new Awareness(doc);
  const peer = { readyState: SOCKET_OPEN, messages: [], send(data, callback) { this.messages.push(data); callback?.(); } };
  coalesceAwarenessSends(peer, doc, maxBytes);
  t.after(() => { receiver.destroy(); doc.destroy(); });
  return { peer, doc, receiver, flush: () => t.mock.timers.tick(FLUSH_WINDOW_MS) };
}

function applyFrames(receiver, messages) {
  for (const message of messages) {
    const decoder = decoding.createDecoder(message);
    assert.equal(decoding.readVarUint(decoder), AWARENESS_TYPE);
    applyAwarenessUpdate(receiver, decoding.readVarUint8Array(decoder), 'relay');
  }
}

test('500 heartbeat updates become one bounded frame per recipient and retain every identity', t => {
  const { peer, receiver, flush } = fixture(t);
  let callbacks = 0;
  for (let index = 0; index < HEARTBEAT_USER_COUNT; index++) {
    const source = sourceAwareness(t);
    source.setLocalState({ user: { userId: `test-${index}` } });
    peer.send(frame(source), () => { callbacks++; });
  }
  assert.equal(peer.messages.length, 0);
  flush();
  assert.equal(peer.messages.length, 1);
  assert.equal(callbacks, HEARTBEAT_USER_COUNT);
  applyFrames(receiver, peer.messages);
  assert.equal(receiver.getStates().size, HEARTBEAT_USER_COUNT + 1);
});

test('latest clocks win and queued removal survives upstream metadata cleanup', t => {
  const { peer, receiver, flush } = fixture(t);
  const source = sourceAwareness(t);
  source.setLocalState({ x: 1 }); const old = frame(source);
  source.setLocalState({ x: 2 }); const latest = frame(source);
  peer.send(latest); peer.send(old); flush();
  applyFrames(receiver, peer.messages);
  assert.equal(receiver.getStates().get(source.clientID).x, 2);
  peer.messages.length = 0;
  removeAwarenessStates(source, [source.clientID], null);
  peer.send(frame(source)); source.meta.delete(source.clientID); flush();
  applyFrames(receiver, peer.messages);
  assert.equal(receiver.getStates().has(source.clientID), false);
});

test('document frames stay immediate and every queued callback receives a closed-peer error', t => {
  const { peer, flush } = fixture(t);
  const sync = Uint8Array.of(0, 0);
  peer.send(sync);
  assert.equal(peer.messages[0], sync);
  const source = sourceAwareness(t);
  const errors = [];
  peer.send(frame(source), error => errors.push(error));
  peer.send(frame(source), error => errors.push(error));
  peer.readyState = SOCKET_CLOSED; flush();
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => error instanceof Error));
});

test('a bounded batch splits frames and preserves callbacks for every recipient', t => {
  const SMALL_FRAME_LIMIT_BYTES = 128;
  const IDENTITY_COUNT = 20;
  const { peer, receiver, flush } = fixture(t, SMALL_FRAME_LIMIT_BYTES);
  let callbacks = 0;
  for (let index = 0; index < IDENTITY_COUNT; index++) {
    const source = sourceAwareness(t);
    source.setLocalState({ user: { userId: `bounded-${index}` } });
    peer.send(frame(source), () => { callbacks++; });
  }
  flush();
  assert.ok(peer.messages.length > 1 && peer.messages.length < IDENTITY_COUNT);
  assert.ok(peer.messages.every(message => message.byteLength <= SMALL_FRAME_LIMIT_BYTES));
  applyFrames(receiver, peer.messages);
  assert.equal(receiver.getStates().size, IDENTITY_COUNT + 1);
  assert.equal(callbacks, IDENTITY_COUNT);
});


test('full roster snapshots keep their original recipient and do not amplify incremental broadcasts', t => {
  const { peer, doc, flush } = fixture(t);
  const second = { readyState: SOCKET_OPEN, messages: [], send(data, callback) { this.messages.push(data); callback?.(); } };
  coalesceAwarenessSends(second, doc, MAX_FRAME_BYTES);
  const source = sourceAwareness(t);
  const other = sourceAwareness(t);
  source.setLocalState({ user: { userId: 'roster-source' } });
  other.setLocalState({ user: { userId: 'roster-other' } });
  applyAwarenessUpdate(source, encodeAwarenessUpdate(other, [other.clientID]), 'peer');
  const snapshot = frame(source, [source.clientID, other.clientID]);
  peer.send(snapshot);
  assert.equal(peer.messages[0], snapshot, 'An initial roster stays immediate and targeted');
  second.send(frame(source)); flush();
  const receiver = sourceAwareness(t);
  applyFrames(receiver, second.messages);
  assert.equal(receiver.getStates().has(source.clientID), true);
  assert.equal(receiver.getStates().has(other.clientID), false, 'An unrelated snapshot must not expand this broadcast');
});
