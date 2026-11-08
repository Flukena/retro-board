import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { E2E_FRAME } from '../../domain/e2e-envelope.js';
import { KEY_ROTATED_EVENT, ROOM_KEY_CHANGED_EVENT } from '../room-lock/lock-session.js';
import { attachE2ERoom } from './e2e-room.js';
import {
  E2E_ROTATION_STALE, E2E_TEST_HANDLE, delivered, e2eRoom, roomKey, synced, textOf, until,
} from '../../test-support/e2e-room-fixture.mjs';

const keyChanged = (target, epochChanged) => target.dispatchEvent(new CustomEvent(ROOM_KEY_CHANGED_EVENT, {
  detail: { epochChanged },
}));

async function lockedBoard(t) {
  const room = await e2eRoom(t);
  const keys = { current: await roomKey(0) };
  const a = room.join(keys.current);
  const b = room.join(keys.current);
  const undo = new Y.UndoManager(a.doc.getText('text'), { trackedOrigins: new Set(['local']) });
  t.after(() => undo.destroy());
  const wiring = attachE2ERoom({
    provider: a.provider, ydoc: a.doc, eventTarget: a.events, getRoomKey: () => keys.current, clearUndo: () => undo.clear(),
  });
  await synced(a, b);
  const type = (text) => a.doc.transact(() => a.doc.getText('text').insert(a.doc.getText('text').length, text), 'local');
  return { room, keys, a, b, undo, wiring, type };
}

test('after a rotation re-unlock the pending edits go out under the new epoch and undo/redo are cleared', async (t) => {
  const { room, keys, a, b, undo, type } = await lockedBoard(t);
  const rotated = [];
  a.events.addEventListener(KEY_ROTATED_EVENT, () => rotated.push(true));
  type('kept');
  await delivered(a);
  const { rotationId } = await room.freeze();
  type('+pending');
  await until(() => a.tap.receivedOfType(E2E_FRAME.REJECT).length === 1, 'FROZEN reject');
  keys.current = await roomKey(1);
  await room.rotate(rotationId, keys.current, Y.encodeStateAsUpdate(b.doc), b.provider.appliedSnapshotBase);
  await until(() => rotated.length === 1, 'rotation close');
  assert.ok(undo.undoStack.length > 0);
  b.provider.setKey(keys.current);
  keyChanged(a.events, true);
  assert.equal(undo.undoStack.length, 0);
  assert.equal(undo.redoStack.length, 0);
  await delivered(a);
  await until(() => textOf(b) === 'kept+pending', 'pending edit under the new key');
});

test('a password change re-unlock keeps the undo history and the same key epoch', async (t) => {
  const { keys, a, undo, type } = await lockedBoard(t);
  type('edit');
  await delivered(a);
  keyChanged(a.events, false);
  assert.ok(undo.undoStack.length > 0);
  assert.equal(a.provider.wsconnected, true);
  assert.equal(keys.current.keyEpoch, 0);
});

test('the rotation source gives the current state and key epoch, not the live document', async (t) => {
  const { keys, a, wiring, type } = await lockedBoard(t);
  type('snapshot me');
  const source = wiring.rotationSource();
  assert.equal(source.roomHandle, E2E_TEST_HANDLE);
  assert.equal(source.keyEpoch, keys.current.keyEpoch);
  assert.equal(Object.values(source).includes(a.doc), false);
  const detached = new Y.Doc();
  Y.applyUpdate(detached, source.encodeState());
  assert.equal(detached.getText('text').toString(), 'snapshot me');
});

test('the rotation source claims the stored snapshot it applied, which is the only base a commit is accepted with', async (t) => {
  const APPEND_CAP = 2048;
  const room = await e2eRoom(t, { maxAppendBytes: APPEND_CAP });
  const key = await roomKey(0);
  const a = room.join(key);
  const b = room.join(key, { appendFrameBytes: APPEND_CAP });
  const wiring = attachE2ERoom({ provider: a.provider, ydoc: a.doc, eventTarget: a.events, getRoomKey: () => key, clearUndo: () => {} });
  await synced(a, b);
  const big = 'x'.repeat(APPEND_CAP * 2);
  b.doc.transact(() => b.doc.getText('text').insert(0, big), 'local');
  await delivered(b);
  await until(() => textOf(a) === big, 'A applied the snapshot');
  const stored = (await room.roomLog.open(room.docName)).snapshot.baseSeq;
  await until(() => wiring.rotationSource().appliedSeq === wiring.rotationSource().head, 'A read the whole log');
  const source = wiring.rotationSource();
  assert.deepEqual([source.appliedSnapshotBase, source.pendingDelivery], [stored, 0]);
  const { rotationId } = await room.freeze();
  const next = await roomKey(1);
  await assert.rejects(room.rotate(rotationId, next, source.encodeState(), 0), (error) => error.code === E2E_ROTATION_STALE);
  await room.rotate(rotationId, next, source.encodeState(), source.appliedSnapshotBase);
});
