import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { E2E_FRAME } from '../../domain/e2e-envelope.js';
import { KEY_ROTATED_EVENT } from '../room-lock/lock-session.js';
import { decryptFrame, encryptFrame } from '../room-lock/e2e-crypto.js';
import { attachClientSync } from './client-sync.js';
import { E2E_ROOM_FULL_EVENT, E2E_SKIPPED_EVENT, E2E_SYNCED_FIELD } from './e2e-provider.js';
import {
  delivered, dropFrame, e2eRoom, flipLastBit, roomKey, sleep, synced, textOf, until,
} from '../../test-support/e2e-room-fixture.mjs';

const SMALL_SNAPSHOT_POLICY = Object.freeze({ afterUpdates: 3 });
const QUIET_MS = 150;
const LAST_CLIENT_REF = 2 ** 32 - 1;

const type = ({ doc }, text, index = doc.getText('text').length, origin = 'local') => {
  doc.transact(() => doc.getText('text').insert(index, text), origin);
};
const eventsOf = (target, name) => {
  const seen = [];
  target.addEventListener(name, (event) => seen.push(event.detail));
  return seen;
};

test('two pages converge, including concurrent typing in one Y.Text', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key);
  const b = room.join(key);
  await synced(a, b);
  type(a, 'hello');
  await until(() => textOf(b) === 'hello', 'first edit');
  type(a, 'A', 0);
  type(b, 'B', 5);
  await until(() => textOf(a) === textOf(b) && textOf(a).length === 7, 'concurrent edits');
  assert.ok(textOf(a).startsWith('A') && textOf(a).includes('B'));
  await delivered(a, b);
  const { updates } = await room.roomLog.open(room.docName);
  const plaintext = new TextEncoder().encode('hello');
  assert.ok(updates.every(({ bytes }) => !Buffer.from(bytes).includes(Buffer.from(plaintext))), 'the relay holds ciphertext only');
});

test('undo of local edits never reverts a peer change: remote applies are not local', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key);
  const b = room.join(key);
  await synced(a, b);
  const undo = new Y.UndoManager(a.doc.getText('text'), { trackedOrigins: new Set(['local']) });
  t.after(() => undo.destroy());
  type(a, 'mine ');
  undo.stopCapturing();
  await until(() => textOf(b) === 'mine ', 'own edit reaches peer');
  type(b, 'theirs');
  await until(() => textOf(a) === 'mine theirs', 'peer edit arrives');
  undo.undo();
  assert.equal(textOf(a), 'theirs');
  assert.equal(undo.undoStack.length, 0, 'the peer change is not on the undo stack');
});

test('a tampered frame is skipped, the board stays intact and snapshots stop for the session', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key);
  const b = room.join(key, { snapshotPolicy: SMALL_SNAPSHOT_POLICY });
  const c = room.join(key);
  const skipped = eventsOf(b.events, E2E_SKIPPED_EVENT);
  await synced(a, b, c);
  b.tap.rule(E2E_FRAME.UPDATE, flipLastBit);
  a.doc.getMap('meta').set('lost', true);
  await delivered(a);
  // A later seq from another page applies; the author's own later edits would wait on the lost one (Yjs order).
  type(c, 'after');
  await until(() => textOf(b) === 'after', 'later seq applied');
  assert.equal(b.doc.getMap('meta').get('lost'), undefined);
  assert.deepEqual(skipped, [{ seq: 1 }]);
  assert.equal(b.provider.skippedSeq, 1);
  for (let i = 0; i < SMALL_SNAPSHOT_POLICY.afterUpdates * 2; i += 1) type(b, String(i));
  await delivered(b);
  await sleep(QUIET_MS);
  assert.equal(b.tap.sentOfType(E2E_FRAME.SNAPSHOT).length, 0, 'no snapshot after a skipped seq');
  assert.equal(b.provider.e2eSynced, false);
  assert.equal(b.provider.awareness.getLocalState()[E2E_SYNCED_FIELD], false);
});

test('a slow decryption never lets a later frame apply first', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key);
  let calls = 0;
  const slowFirst = {
    encryptFrame,
    async decryptFrame(...args) {
      calls += 1;
      if (calls === 1) await sleep(QUIET_MS);
      return decryptFrame(...args);
    },
  };
  const b = room.join(key, { cipher: slowFirst });
  await synced(a, b);
  const seen = [];
  b.doc.on('update', () => seen.push(textOf(b)));
  type(a, 'a');
  type(a, 'b');
  await until(() => textOf(b) === 'ab', 'both edits');
  assert.deepEqual(seen, ['a', 'ab']);
});

test('a lost ACK is re-sent on reconnect; the edit arrives once', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key);
  const b = room.join(key);
  await synced(a, b);
  a.tap.rule(E2E_FRAME.ACK, dropFrame);
  type(a, 'x');
  await until(() => textOf(b) === 'x', 'first delivery');
  await sleep(QUIET_MS);
  assert.equal(a.provider.pendingDelivery, 1, 'unacknowledged until an ACK arrives');
  a.tap.last.close();
  await delivered(a);
  assert.equal(textOf(b), 'x');
  assert.equal(textOf(a), 'x');
  const { updates } = await room.roomLog.open(room.docName);
  assert.equal(updates.length, 2, 'the resend is a harmless duplicate in the log');
});

test('closing right after an edit guards unload; after reconnect the edit arrives and the guard lifts', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key);
  const b = room.join(key);
  const browser = new EventTarget();
  const sync = attachClientSync(a.provider, a.doc, browser);
  await synced(a, b);
  const unloadBlocked = () => {
    const event = new Event('beforeunload', { cancelable: true });
    browser.dispatchEvent(event);
    return event.defaultPrevented;
  };
  a.doc.transact(() => a.doc.getMap('items').set('card', 'text'), 'local');
  assert.equal(unloadBlocked(), true, 'guarded while connected but unacknowledged');
  assert.equal(sync.getSnapshot().status, 'saving');
  a.tap.last.close();
  await until(() => !a.provider.wsconnected, 'socket closed');
  assert.equal(unloadBlocked(), true);
  await delivered(a);
  await until(() => b.doc.getMap('items').get('card') === 'text', 'edit arrives');
  assert.equal(unloadBlocked(), false);
  assert.equal(sync.getSnapshot().status, 'connected');
});

test('a snapshot from a page that only types is stored with a baseSeq it holds', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key, { snapshotPolicy: SMALL_SNAPSHOT_POLICY });
  const sentAt = [];
  const send = a.tap.Impl.prototype.send;
  a.tap.Impl.prototype.send = function sendAndRecord(data) {
    if (data[0] === E2E_FRAME.SNAPSHOT) sentAt.push(a.provider.appliedSeq);
    send.call(this, data);
  };
  await synced(a);
  for (let i = 0; i < SMALL_SNAPSHOT_POLICY.afterUpdates; i += 1) type(a, String(i));
  await until(() => a.tap.sentOfType(E2E_FRAME.SNAPSHOT).length === 1, 'snapshot sent');
  await delivered(a);
  const [frame] = a.tap.sentOfType(E2E_FRAME.SNAPSHOT);
  assert.ok(frame.seq >= SMALL_SNAPSHOT_POLICY.afterUpdates, 'own ACKs advanced appliedSeq');
  assert.ok(frame.seq <= sentAt[0], 'baseSeq never exceeds appliedSeq');
  const stored = await room.roomLog.open(room.docName);
  assert.equal(stored.snapshot.baseSeq, frame.seq);
  const joiner = room.join(key);
  await synced(joiner);
  assert.equal(textOf(joiner), '012');
});

test('a rotation close keeps pending edits; setKey delivers them under the new epoch', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey(0);
  const a = room.join(key);
  const b = room.join(key);
  const rotated = eventsOf(a.events, KEY_ROTATED_EVENT);
  await synced(a, b);
  type(a, 'base');
  await delivered(a);
  await until(() => textOf(b) === 'base', 'base text');
  const { rotationId } = await room.freeze();
  type(a, '+frozen');
  await until(() => a.tap.receivedOfType(E2E_FRAME.REJECT).length === 1, 'FROZEN reject');
  const next = await roomKey(1);
  await room.rotate(rotationId, next, Y.encodeStateAsUpdate(b.doc));
  await until(() => rotated.length === 1, 'key rotated event');
  type(a, '+offline');
  a.provider.disconnect();
  a.provider.connect();
  await sleep(QUIET_MS);
  assert.equal(a.provider.ws, null, 'no reconnect under the old key');
  assert.equal(a.provider.pendingDelivery, 2);
  a.provider.setKey(next);
  b.provider.setKey(next);
  await delivered(a);
  await until(() => textOf(b) === 'base+frozen+offline', 'pending edits under the new epoch');
  assert.equal(b.provider.skippedSeq, null, 'every frame decrypted with the new key');
});

test('FROZEN keeps an edit until RESUMED, then re-sends it', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key);
  const b = room.join(key);
  await synced(a, b);
  const { rotationId } = await room.freeze();
  type(a, 'held');
  await until(() => a.tap.receivedOfType(E2E_FRAME.REJECT).length === 1, 'FROZEN reject');
  await sleep(QUIET_MS);
  assert.equal(a.provider.pendingDelivery, 1);
  assert.equal(textOf(b), '');
  await room.release(rotationId);
  await delivered(a);
  await until(() => textOf(b) === 'held', 'delivered after RESUMED');
});

test('an update larger than the APPEND cap is delivered by snapshot, never as an APPEND', async (t) => {
  const APPEND_CAP = 2048;
  const room = await e2eRoom(t, { maxAppendBytes: APPEND_CAP });
  const key = await roomKey();
  const a = room.join(key, { appendFrameBytes: APPEND_CAP });
  const b = room.join(key);
  await synced(a, b);
  const big = 'x'.repeat(APPEND_CAP * 2);
  type(a, big);
  await delivered(a);
  await until(() => textOf(b) === big, 'peer receives the large edit');
  assert.ok(a.tap.sentOfType(E2E_FRAME.APPEND).every((frame) => frame.ciphertext.length < APPEND_CAP));
  assert.equal(a.tap.sentOfType(E2E_FRAME.SNAPSHOT).length, 1);
  assert.equal(a.provider.wsconnected, true, 'the relay never closed the socket');
  const joiner = room.join(key);
  await synced(joiner);
  assert.equal(textOf(joiner), big);
});

test('a snapshot over the room size is not sent and the page is told the room is full', async (t) => {
  const ROOM_BYTES = 4096;
  const APPEND_CAP = 1024;
  const room = await e2eRoom(t, { maxRoomBytes: ROOM_BYTES, maxAppendBytes: APPEND_CAP });
  const key = await roomKey();
  const a = room.join(key, { appendFrameBytes: APPEND_CAP, maxRoomBytes: ROOM_BYTES });
  const full = eventsOf(a.events, E2E_ROOM_FULL_EVENT);
  await synced(a);
  type(a, 'y'.repeat(ROOM_BYTES));
  await until(() => full.length === 1, 'room full event');
  assert.equal(a.tap.sentOfType(E2E_FRAME.SNAPSHOT).length, 0);
  assert.equal(a.provider.pendingDelivery > 0, true, 'the edit stays pending, guarding unload');
});

test('clientRefs wrap past 2^32 - 1 to 1 and both edits are acknowledged', async (t) => {
  const room = await e2eRoom(t);
  const key = await roomKey();
  const a = room.join(key, { firstClientRef: LAST_CLIENT_REF });
  await synced(a);
  type(a, '1');
  type(a, '2');
  await delivered(a);
  assert.deepEqual(a.tap.sentOfType(E2E_FRAME.APPEND).map((frame) => frame.clientRef), [LAST_CLIENT_REF, 1]);
});
