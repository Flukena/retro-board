import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayLateBindings } from './relay-late-bindings.js';
import { relayEntrypoint } from '../test-support/relay-entrypoint.js';
import { RoomRegistry, REGISTRY_STORAGE_FAILURE_EVENT } from './relay-room-registry.js';

test('composition cannot silently call storage-failure shutdown before its binding exists', async t => {
  const on = RoomRegistry.prototype.on;
  t.mock.method(console, 'error', () => {});
  t.mock.method(RoomRegistry.prototype, 'on', function (event, listener) {
    if (event === REGISTRY_STORAGE_FAILURE_EVENT) listener(new Error('early fake storage failure'));
    return on.call(this, event, listener);
  });
  await assert.rejects(relayEntrypoint(t), Error);
});

for (const name of ['shutdown', 'activeRooms', 'deleteRoom', 'recoverRooms', 'roomLockRoutes', 'e2eBlobs']) {
  test(`late binding ${name} fails fast until assigned`, () => {
    const bindings = createRelayLateBindings();
    assert.throws(() => bindings[name], new RegExp(`relay binding is unset: ${name}`));
  });
}

test('late bindings read current peer services and wrappers preserve the peer receiver', () => {
  const bindings = createRelayLateBindings();
  const peer = { count: 1, activeRooms() { assert.equal(this, peer); return this.count; } };
  bindings.bind('activeRooms', () => peer.activeRooms());
  assert.equal(bindings.activeRooms(), 1);
  peer.count = 2;
  assert.equal(bindings.activeRooms(), 2);
  const routes = { handle() {} };
  bindings.bind('roomLockRoutes', routes);
  assert.equal(bindings.roomLockRoutes, routes);
});
