import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncStatus, shouldGuardUnload } from './sync-status.js';

test('only a WebSocket sync clears pending offline changes', () => {
  const state = new SyncStatus();
  state.transport('disconnected');
  assert.equal(shouldGuardUnload(state.getSnapshot()), false);
  state.localChange(false);
  assert.equal(shouldGuardUnload(state.getSnapshot()), true);
  state.transport('connecting');
  state.transport('connected');
  state.synced(false);
  assert.equal(state.getSnapshot().status, 'disconnected');
  assert.equal(shouldGuardUnload(state.getSnapshot()), true);
  state.synced(true);
  assert.deepEqual(state.getSnapshot(), { status: 'connected', hasUnsyncedLocalChanges: false });
  assert.equal(shouldGuardUnload(state.getSnapshot()), false);
});

test('session loss survives transport events and recovery preserves pending edits until sync', () => {
  const state = new SyncStatus();
  state.synced(true);
  state.sessionLost(true);
  state.localChange(true);
  state.transport('disconnected');
  state.transport('connecting');
  assert.equal(state.getSnapshot().status, 'session-lost');
  state.sessionLost(false);
  assert.equal(shouldGuardUnload(state.getSnapshot()), true);
  state.synced(true);
  assert.equal(shouldGuardUnload(state.getSnapshot()), false);
});

test('online changes do not claim missing acknowledgements; subscriptions clean up', () => {
  const state = new SyncStatus();
  let updates = 0;
  const unsubscribe = state.subscribe(() => { updates += 1; });
  state.synced(true);
  const snapshot = state.getSnapshot();
  state.localChange(true);
  assert.equal(state.getSnapshot(), snapshot);
  assert.equal(updates, 1);
  unsubscribe();
  state.transport('disconnected');
  assert.equal(updates, 1);
});

test('socket recovery does not hide a concurrent HTTP session-refresh failure', () => {
  const state = new SyncStatus();
  state.synced(true);
  state.sessionLost(true);
  state.socketExpired();
  state.transport('disconnected');
  state.localChange(false);
  state.synced(false);
  assert.equal(shouldGuardUnload(state.getSnapshot()), true);
  state.synced(true);
  assert.equal(state.getSnapshot().status, 'session-lost');
  state.sessionLost(false);
  assert.deepEqual(state.getSnapshot(), { status: 'connected', hasUnsyncedLocalChanges: false });
});
