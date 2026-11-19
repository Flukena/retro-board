import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { relayEntrypoint } from '../test-support/relay-entrypoint.js';
import * as plainUpgradeModule from './plain-upgrade.js';
import { RoomSessions } from './relay-session.js';
import { RelayWsTraffic } from './relay-ws-traffic.js';

const ORIGIN = 'https://allowed.example';
const HANDLE = 'a'.repeat(32);
const DOC_NAME = 'upgrade-test';
const EXPIRES_AT_MS = 100_000;
const AWARENESS_ID = 42;

const socketStub = () => Object.assign(new EventEmitter(), { replies: [], end(value) { this.replies.push(value); }, destroy() {} });

test('upgrade carries canonical security context and holds fence through plain attachment', async t => {
  const attachments = [];
  const releases = [];
  t.mock.method(RoomSessions.prototype, 'authenticate', () => ({ docName: DOC_NAME, expiresAt: EXPIRES_AT_MS }));
  t.mock.method(RelayWsTraffic.prototype, 'reserve', () => ({ status: 0, release: () => releases.push('released') }));
  const state = await relayEntrypoint(t, { modules: {
    './src/server/plain-upgrade.js': { ...plainUpgradeModule, createPlainUpgrades: () => ({ attach: (...args) => attachments.push(args) }) },
  } });
  state.registry.registeredRoomsByHandle.set(HANDLE, DOC_NAME);
  const socket = socketStub();
  const req = { url: `/yjs/rooms/${HANDLE}?awarenessId=${AWARENESS_ID}`, headers: { origin: ORIGIN }, socket: { remoteAddress: '127.0.0.1' } };
  const head = Buffer.from([0]);
  state.server.emit('upgrade', req, socket, head);
  assert.equal(attachments.length, 1);
  assert.deepEqual(req.wsSecurityContext, { docName: DOC_NAME, clientIp: '127.0.0.1', expiresAt: EXPIRES_AT_MS,
    expectedAwarenessClientId: AWARENESS_ID, supportsQuota: false, e2e: false, keyEpoch: null });
  assert.equal(attachments[0][3], DOC_NAME);
  assert.equal(state.registry.registeredRoomsByHandle.get(HANDLE), DOC_NAME);
  attachments[0][4]();
  socket.emit('close');
  assert.deepEqual(releases, ['released']);
  assert.deepEqual(socket.replies, []);
});

test('upgrade rejects hostile origin before authentication or reserving a slot', async t => {
  t.mock.method(RoomSessions.prototype, 'authenticate', () => assert.fail('origin must be checked first'));
  t.mock.method(RelayWsTraffic.prototype, 'reserve', () => assert.fail('slot must not be reserved'));
  const state = await relayEntrypoint(t);
  const socket = socketStub();
  state.server.emit('upgrade', { url: `/rooms/${HANDLE}`, headers: { origin: 'https://hostile.example' } }, socket, Buffer.alloc(0));
  assert.match(socket.replies[0], /^HTTP\/1.1 403 Forbidden\r\n/);
});
