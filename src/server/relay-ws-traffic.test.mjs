import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readRelayConfig } from './relay-config.js';
import { RelayWsTraffic, closeOnSessionExpiry, POLICY_CLOSE_CODE, SESSION_EXPIRED_REASON } from './relay-ws-traffic.js';

const ROOM = 'yjs/board-room';
const OTHER_ROOM = 'yjs/board-other';
const IP = '203.0.113.1';
const OTHER_IP = '203.0.113.2';
const TOO_MANY = 429;
const UNAVAILABLE = 503;
const SMALL = 10;
const quietLog = { warn() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));

const configWith = (env) => readRelayConfig({ YJS_ALLOWED_ORIGINS: '', ...env });

class FakeSocket extends EventEmitter {
  sent = [];
  closed = null;
  bufferedAmount = 0;
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed ??= { code, reason }; this.emit('close'); }
}

test('reserve enforces the global, per-IP and per-room caps and releases exactly once', () => {
  const traffic = new RelayWsTraffic(configWith({ YJS_MAX_CONNECTIONS: '3', YJS_MAX_CONNECTIONS_PER_IP: '2', YJS_MAX_CONNECTIONS_PER_ROOM: '2' }), { log: quietLog });
  const first = traffic.reserve(IP, ROOM);
  const second = traffic.reserve(OTHER_IP, ROOM);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(traffic.reserve(OTHER_IP, ROOM).status, TOO_MANY, 'room cap');
  assert.equal(traffic.reserve(IP, OTHER_ROOM).status, 0);
  assert.equal(traffic.reserve(OTHER_IP, OTHER_ROOM).status, UNAVAILABLE, 'global cap');
  assert.equal(traffic.connectionsByRoom.get(ROOM), 2);
  first.release();
  first.release();
  assert.equal(traffic.connectionsByRoom.get(ROOM), 1, 'a double release counts once');
  second.release();
  assert.equal(traffic.connectionsByRoom.has(ROOM), false);
  assert.equal(traffic.reserve(IP, ROOM).status, 0, 'IP now holds this room and the other one');
  assert.equal(traffic.reserve(IP, 'yjs/board-third').status, TOO_MANY, 'per-IP cap');
});

test('ingress is refused once the per-connection message burst is spent', () => {
  const traffic = new RelayWsTraffic(configWith({ YJS_WS_BURST_MESSAGES: '2', YJS_WS_MESSAGES_PER_SECOND: '1' }), { log: quietLog });
  const meter = traffic.attach(new FakeSocket(), ROOM);
  assert.equal(meter.admitIngress(SMALL), true);
  assert.equal(meter.admitIngress(SMALL), true);
  assert.equal(meter.admitIngress(SMALL), false);
  assert.equal(traffic.attach(new FakeSocket(), ROOM).admitIngress(SMALL), true, 'each connection has its own bucket');
});

test('the room ingress bucket is shared by every connection of the room', () => {
  const traffic = new RelayWsTraffic(configWith({ YJS_ROOM_WS_BURST_MESSAGES: '2', YJS_ROOM_WS_MESSAGES_PER_SECOND: '1' }), { log: quietLog });
  assert.equal(traffic.attach(new FakeSocket(), ROOM).admitIngress(SMALL), true);
  assert.equal(traffic.attach(new FakeSocket(), ROOM).admitIngress(SMALL), true);
  assert.equal(traffic.attach(new FakeSocket(), ROOM).admitIngress(SMALL), false);
  assert.equal(traffic.attach(new FakeSocket(), OTHER_ROOM).admitIngress(SMALL), true);
});

test('egress over budget drops the send and closes the socket once with 1008', async () => {
  const traffic = new RelayWsTraffic(configWith({ YJS_WS_EGRESS_CONNECTION_BURST_MESSAGES: '2', YJS_WS_EGRESS_CONNECTION_MESSAGES_PER_SECOND: '1' }), { log: quietLog });
  const socket = new FakeSocket();
  traffic.attach(socket, ROOM);
  socket.send('a');
  socket.send('b');
  socket.send('c');
  socket.send('d');
  assert.deepEqual(socket.sent, ['a', 'b']);
  await settle();
  assert.deepEqual(socket.closed, { code: POLICY_CLOSE_CODE, reason: 'egress rate-limit' });
});

test('a batch pays as one message of its total size', async () => {
  const traffic = new RelayWsTraffic(configWith({ YJS_WS_EGRESS_CONNECTION_BURST_MESSAGES: '2', YJS_WS_EGRESS_CONNECTION_MESSAGES_PER_SECOND: '1' }), { log: quietLog });
  const socket = new FakeSocket();
  const meter = traffic.attach(socket, ROOM);
  const frames = Array.from({ length: 5 }, (_, i) => new Uint8Array([i]));
  assert.equal(meter.sendBatch(frames), true);
  socket.send('after');
  assert.equal(socket.sent.length, frames.length + 1);
  assert.equal(meter.sendBatch(frames), false, 'the burst is spent');
  await settle();
  assert.equal(socket.closed?.code, POLICY_CLOSE_CODE);
});

test('slow consumers above the buffered limit are closed; others are left alone', () => {
  const config = configWith({});
  const traffic = new RelayWsTraffic(config, { log: quietLog });
  const slow = new FakeSocket();
  const fine = new FakeSocket();
  slow.bufferedAmount = config.MAX_WS_BUFFERED_BYTES + 1;
  fine.bufferedAmount = config.MAX_WS_BUFFERED_BYTES;
  traffic.closeSlowConsumers([slow, fine]);
  assert.deepEqual(slow.closed, { code: POLICY_CLOSE_CODE, reason: 'slow consumer' });
  assert.equal(fine.closed, null);
});

test('a session-bound socket closes 1008 session expired at its expiry, and not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new FakeSocket();
  const now = 1_000;
  const lifetimeMs = 500;
  closeOnSessionExpiry(socket, now + lifetimeMs, now);
  t.mock.timers.tick(lifetimeMs - 1);
  assert.equal(socket.closed, null);
  t.mock.timers.tick(1);
  assert.deepEqual(socket.closed, { code: POLICY_CLOSE_CODE, reason: SESSION_EXPIRED_REASON });
});

// Moved with the code from relay-rate-bucket.test.js: ingress charges connection, then global,
// then room, and a later refusal never refunds an earlier charge.
test('ingress fails at global: the connection stays charged and the room is not charged', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const traffic = new RelayWsTraffic(configWith({
    YJS_WS_BURST_MESSAGES: '2', YJS_WS_MESSAGES_PER_SECOND: '1',
    YJS_GLOBAL_WS_BURST_MESSAGES: '1', YJS_GLOBAL_WS_MESSAGES_PER_SECOND: '1000',
    YJS_ROOM_WS_BURST_MESSAGES: '2', YJS_ROOM_WS_MESSAGES_PER_SECOND: '1',
  }), { log: quietLog });
  const [first, second] = [traffic.attach(new FakeSocket(), ROOM), traffic.attach(new FakeSocket(), ROOM)];
  assert.equal(first.admitIngress(SMALL), true);
  assert.equal(second.admitIngress(SMALL), false, 'global spent');
  assert.equal(second.admitIngress(SMALL), false, 'global spent');
  t.mock.timers.tick(1);
  assert.equal(second.admitIngress(SMALL), false, 'both refused attempts kept their connection charge');
  assert.equal(traffic.attach(new FakeSocket(), ROOM).admitIngress(SMALL), true, 'the room kept the token the refusals did not take');
});

test('ingress fails at room: connection and global stay charged', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const traffic = new RelayWsTraffic(configWith({
    YJS_GLOBAL_WS_BURST_MESSAGES: '2', YJS_GLOBAL_WS_MESSAGES_PER_SECOND: '1',
    YJS_ROOM_WS_BURST_MESSAGES: '1', YJS_ROOM_WS_MESSAGES_PER_SECOND: '1',
  }), { log: quietLog });
  assert.equal(traffic.attach(new FakeSocket(), ROOM).admitIngress(SMALL), true);
  assert.equal(traffic.attach(new FakeSocket(), ROOM).admitIngress(SMALL), false, 'room spent');
  assert.equal(traffic.attach(new FakeSocket(), OTHER_ROOM).admitIngress(SMALL), false, 'the room refusal still took the last global token');
});
