import test from 'node:test';
import assert from 'node:assert/strict';
import { E2E_ROOM_FULL_EVENT, E2E_SKIPPED_EVENT } from '../session/e2e-provider.js';
import { ROOM_LOCK_NOTICE, listenForE2ENotices, roomLockNotice } from './room-lock-dialog-store.js';

test('skipped-change and room-full events become notices until the listener is removed', () => {
  const target = new EventTarget();
  const seen = [];
  const stopWatching = roomLockNotice.subscribe(() => seen.push(roomLockNotice.getSnapshot()));
  const stop = listenForE2ENotices(target);
  target.dispatchEvent(new CustomEvent(E2E_SKIPPED_EVENT, { detail: { seq: 3 } }));
  target.dispatchEvent(new CustomEvent(E2E_ROOM_FULL_EVENT));
  stop();
  target.dispatchEvent(new CustomEvent(E2E_SKIPPED_EVENT, { detail: { seq: 4 } }));
  stopWatching();
  roomLockNotice.set(null);
  assert.deepEqual(seen, [ROOM_LOCK_NOTICE.SKIPPED, ROOM_LOCK_NOTICE.ROOM_FULL]);
});
