import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { E2E_FRAME, E2E_REJECT, decodeServerFrame, encodeFrame } from '../domain/e2e-envelope.js';
import { E2ERoomLog, MAX_PENDING_OPS_PER_ROOM } from './e2e-room-log.js';
import { createE2ERelay } from './e2e-relay.js';
import { readRelayConfig } from './relay-config.js';
import { RelayWsTraffic, POLICY_CLOSE_CODE, SESSION_EXPIRED_REASON } from './relay-ws-traffic.js';
import { ROOM_LOCK_META, encodeLockRecord } from './room-lock-record.js';
import { lockRecord } from './room-lock-fixtures.mjs';
import { sharedReservations } from '../test-support/store-reservations.mjs';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');

const DOC = 'yjs/board-e2e-protocol-room';
const IP = '203.0.113.9';
const MAX_ROOM_BYTES = 4096;
const MAX_FRAME_BYTES = 64 * 1024;
const FRAME_LIMITS = Object.freeze({ maxBytes: MAX_FRAME_BYTES });
const WAIT_MS = 3_000;
const SERVER_ERROR_CLOSE = 1011;
const FREEZE_TTL_MS = 60_000;
const DRAIN_APPENDS = 200;
const SESSION_LIFETIME_MS = 150;
const GENEROUS = '100000';
const quietLogger = { log() {}, warn() {} };
const bytes = (length, fill = 1) => new Uint8Array(length).fill(fill);
const approve = async () => true;

const generousConfig = (env = {}) => readRelayConfig({
  YJS_WS_BURST_MESSAGES: GENEROUS, YJS_ROOM_WS_BURST_MESSAGES: GENEROUS, YJS_GLOBAL_WS_BURST_MESSAGES: GENEROUS,
  YJS_WS_EGRESS_CONNECTION_BURST_MESSAGES: GENEROUS, YJS_WS_EGRESS_ROOM_BURST_MESSAGES: GENEROUS, YJS_WS_EGRESS_GLOBAL_BURST_MESSAGES: GENEROUS,
  ...env,
});

async function fixture(t, {
  config = generousConfig(), expiresAt = null, prepare = () => {}, maxRoomBytes = MAX_ROOM_BYTES, maxAppendBytes = MAX_FRAME_BYTES,
  reserveStore = () => () => {},
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-relay-protocol-'));
  const ldb = new LeveldbPersistence(dir);
  await ldb.setMeta(DOC, ROOM_LOCK_META, encodeLockRecord(lockRecord()));
  prepare(ldb);
  const failures = [];
  const touched = [];
  const roomLog = new E2ERoomLog({ ldb, maxRoomBytes, reserveStore, onError: (error) => failures.push(error) });
  const relay = createE2ERelay({
    roomLog, traffic: new RelayWsTraffic(config, { log: quietLogger }), maxRoomBytes, maxAppendBytes,
    touch: (docName) => touched.push(docName), onStorageFailure: (error) => failures.push(error), logger: quietLogger,
  });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    req.wsSecurityContext = { docName: DOC, clientIp: IP, expiresAt };
    relay.handleUpgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of relay.wss.clients) client.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    await roomLog.whenIdle();
    await ldb.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `ws://127.0.0.1:${server.address().port}/`;
  return { relay, roomLog, ldb, url, failures, touched };
}

class Client {
  frames = [];
  #waiters = new Set();

  constructor(ws) {
    this.ws = ws;
    ws.on('message', (data) => {
      this.frames.push(decodeServerFrame(new Uint8Array(data), FRAME_LIMITS));
      for (const waiter of [...this.#waiters]) waiter();
    });
    this.closed = once(ws, 'close').then(([code, reason]) => ({ code, reason: String(reason) }));
  }

  static async join(f) {
    const ws = new WebSocket(f.url);
    const client = new Client(ws);
    await once(ws, 'open');
    await client.until(() => client.has(E2E_FRAME.SYNCED));
    return client;
  }

  has(type, count = 1) { return this.ofType(type).length >= count; }
  ofType(type) { return this.frames.filter((frame) => frame?.type === type); }
  append(clientRef, ciphertext) { this.ws.send(encodeFrame(E2E_FRAME.APPEND, { clientRef, ciphertext })); }

  until(predicate) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#waiters.delete(check); reject(new Error(`timed out; frames ${JSON.stringify(this.frames)}`)); }, WAIT_MS);
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.#waiters.delete(check);
        resolve();
      };
      this.#waiters.add(check);
    });
  }
}

const within = (promise) => Promise.race([promise, new Promise((_, reject) => {
  setTimeout(() => reject(new Error('not settled in time')), WAIT_MS).unref();
})]);

const waitUntil = async (predicate) => {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('an append during a freeze is REJECT FROZEN with its clientRef; release sends RESUMED to every socket', async (t) => {
  const f = await fixture(t);
  const [writer, other] = [await Client.join(f), await Client.join(f)];
  const { rotationId } = await f.roomLog.freeze(DOC, FREEZE_TTL_MS, { verify: approve });
  writer.append(41, bytes(8));
  await writer.until(() => writer.has(E2E_FRAME.REJECT));
  assert.deepEqual(writer.ofType(E2E_FRAME.REJECT), [{ type: E2E_FRAME.REJECT, code: E2E_REJECT.FROZEN, clientRef: 41 }]);
  await f.roomLog.release(DOC, rotationId);
  await Promise.all([writer.until(() => writer.has(E2E_FRAME.RESUMED)), other.until(() => other.has(E2E_FRAME.RESUMED))]);
  writer.append(41, bytes(8));
  await writer.until(() => writer.has(E2E_FRAME.ACK));
  assert.deepEqual(writer.ofType(E2E_FRAME.ACK), [{ type: E2E_FRAME.ACK, seq: 1, clientRef: 41 }]);
  assert.deepEqual(f.touched, [DOC], 'activity is touched on the successful append only');
});

test('an append over the room quota is REJECT QUOTA with its clientRef and is not fanned out', async (t) => {
  const f = await fixture(t);
  const [writer, other] = [await Client.join(f), await Client.join(f)];
  writer.append(9, bytes(MAX_ROOM_BYTES + 1));
  await writer.until(() => writer.has(E2E_FRAME.REJECT));
  assert.deepEqual(writer.ofType(E2E_FRAME.REJECT), [{ type: E2E_FRAME.REJECT, code: E2E_REJECT.QUOTA, clientRef: 9 }]);
  assert.equal(other.ofType(E2E_FRAME.UPDATE).length, 0);
});

test('a snapshot that does not advance the base is REJECT STALE_SNAPSHOT with clientRef 0', async (t) => {
  const f = await fixture(t);
  const writer = await Client.join(f);
  writer.ws.send(encodeFrame(E2E_FRAME.SNAPSHOT, { seq: 5, knownBase: 0, ciphertext: bytes(4) }));
  await writer.until(() => writer.has(E2E_FRAME.REJECT));
  assert.deepEqual(writer.ofType(E2E_FRAME.REJECT), [{ type: E2E_FRAME.REJECT, code: E2E_REJECT.STALE_SNAPSHOT, clientRef: 0 }]);
});

test('appends beyond the per-room queue are REJECT RATE; every append is answered exactly once', async (t) => {
  const f = await fixture(t);
  const writer = await Client.join(f);
  const total = MAX_PENDING_OPS_PER_ROOM * 2;
  for (let ref = 1; ref <= total; ref += 1) writer.append(ref, bytes(1));
  await writer.until(() => writer.ofType(E2E_FRAME.ACK).length + writer.ofType(E2E_FRAME.REJECT).length === total);
  const rejects = writer.ofType(E2E_FRAME.REJECT);
  assert.ok(rejects.length > 0, 'the queue overflowed');
  assert.ok(rejects.every((frame) => frame.code === E2E_REJECT.RATE));
  const answered = [...writer.ofType(E2E_FRAME.ACK), ...rejects].map((frame) => frame.clientRef).sort((a, b) => a - b);
  assert.deepEqual(answered, Array.from({ length: total }, (_, i) => i + 1));
});

test('drain closes the sockets with 1001 and resolves only after every queued append is written', async (t) => {
  const f = await fixture(t);
  const writer = await Client.join(f);
  const append = f.roomLog.append.bind(f.roomLog);
  let received = 0;
  f.roomLog.append = (...args) => { received += 1; return append(...args); };
  for (let ref = 1; ref <= DRAIN_APPENDS; ref += 1) writer.append(ref, bytes(1));
  await waitUntil(() => received === DRAIN_APPENDS);
  await f.relay.drain();
  const reader = new E2ERoomLog({ ldb: f.ldb, maxRoomBytes: MAX_ROOM_BYTES, reserveStore: () => () => {} });
  assert.equal((await reader.open(DOC)).head, DRAIN_APPENDS);
  assert.equal((await writer.closed).code, 1001);
});

test('a session-bound socket closes 1008 session expired', async (t) => {
  const f = await fixture(t, { expiresAt: Date.now() + SESSION_LIFETIME_MS });
  const client = await Client.join(f);
  assert.deepEqual(await client.closed, { code: POLICY_CLOSE_CODE, reason: SESSION_EXPIRED_REASON });
});

test('traffic-bucket exhaustion closes 1008 rate-limit like the y-websocket path', async (t) => {
  const f = await fixture(t, { config: generousConfig({ YJS_WS_BURST_MESSAGES: '2', YJS_WS_MESSAGES_PER_SECOND: '1' }) });
  const client = await Client.join(f);
  for (let ref = 1; ref <= 3; ref += 1) client.append(ref, bytes(1));
  assert.deepEqual(await client.closed, { code: POLICY_CLOSE_CODE, reason: 'rate-limit' });
});

test('a storage read failure on join goes to the fatal storage path and closes 1011', async (t) => {
  const f = await fixture(t, { prepare: (ldb) => { ldb.getMetas = async () => null; } });
  const ws = new WebSocket(f.url);
  const client = new Client(ws);
  assert.equal((await client.closed).code, SERVER_ERROR_CLOSE);
  assert.equal(f.failures.length, 1);
  await waitUntil(() => f.relay.activeRooms() === 0);
});

test('active rooms and per-room connections follow admitted sockets', async (t) => {
  const f = await fixture(t);
  assert.equal(f.relay.activeRooms(), 0);
  const [a, b] = [await Client.join(f), await Client.join(f)];
  assert.equal(f.relay.connectionsFor(DOC), 2);
  assert.equal(f.relay.activeRooms(), 1);
  f.relay.closeRoom(DOC, 4001, 'key rotated');
  assert.deepEqual(await a.closed, { code: 4001, reason: 'key rotated' });
  await b.closed;
  await waitUntil(() => f.relay.activeRooms() === 0);
  assert.equal(f.relay.connectionsFor(DOC), 0);
});

test('an entry notified while a joiner\'s replay is in flight is delivered after its SYNCED', async (t) => {
  const f = await fixture(t);
  const { rotationId } = await f.roomLog.freeze(DOC, FREEZE_TTL_MS, { verify: approve });
  const subscribe = f.roomLog.subscribeAfterReplay.bind(f.roomLog);
  // The release queues right behind the join and notifies without any disk write.
  f.roomLog.subscribeAfterReplay = (...args) => {
    const joined = subscribe(...args);
    void f.roomLog.release(DOC, rotationId);
    return joined;
  };
  const client = await Client.join(f);
  await client.until(() => client.has(E2E_FRAME.RESUMED));
  assert.deepEqual(client.frames.map((frame) => frame.type), [E2E_FRAME.SYNCED, E2E_FRAME.RESUMED]);
});

const SMALL_APPEND_CAP = 1024;
/** The relay's shared pending-store byte cap, set to the room size as in production defaults. */
const pendingCapOfRoomBytes = () => sharedReservations({ maxBytes: MAX_ROOM_BYTES }).reserveStore;

test('APPEND keeps its own frame cap while the largest SNAPSHOT is stored under a maxRoomBytes pending cap', async (t) => {
  const f = await fixture(t, { maxAppendBytes: SMALL_APPEND_CAP, reserveStore: pendingCapOfRoomBytes() });
  const [writer, other] = [await Client.join(f), await Client.join(f)];
  writer.append(1, bytes(8));
  await writer.until(() => writer.has(E2E_FRAME.ACK));
  const snapshot = bytes(f.roomLog.maxSnapshotBytes, 5);
  writer.ws.send(encodeFrame(E2E_FRAME.SNAPSHOT, { seq: 1, knownBase: 0, ciphertext: snapshot }));
  await other.until(() => other.has(E2E_FRAME.SNAPSHOT_OUT));
  assert.equal(other.ofType(E2E_FRAME.SNAPSHOT_OUT)[0].ciphertext.length, snapshot.length);
  assert.ok(snapshot.length > SMALL_APPEND_CAP);
  writer.append(2, bytes(SMALL_APPEND_CAP));
  assert.equal((await writer.closed).code, 1003, 'an APPEND frame over its own cap is malformed');
  assert.deepEqual(writer.ofType(E2E_FRAME.REJECT), [{ type: E2E_FRAME.REJECT, code: E2E_REJECT.MALFORMED, clientRef: 0 }]);
});

test('a SNAPSHOT one byte over the largest is closed by the decode cap and not stored', async (t) => {
  const f = await fixture(t, { reserveStore: pendingCapOfRoomBytes() });
  const writer = await Client.join(f);
  writer.append(1, bytes(8));
  await writer.until(() => writer.has(E2E_FRAME.ACK));
  writer.ws.send(encodeFrame(E2E_FRAME.SNAPSHOT, { seq: 1, knownBase: 0, ciphertext: bytes(f.roomLog.maxSnapshotBytes + 1, 5) }));
  assert.equal((await within(writer.closed)).code, 1003);
  assert.deepEqual(writer.ofType(E2E_FRAME.REJECT), [{ type: E2E_FRAME.REJECT, code: E2E_REJECT.MALFORMED, clientRef: 0 }]);
  await f.roomLog.whenIdle();
  assert.equal((await f.roomLog.open(DOC)).snapshot, null);
});

test('a second SNAPSHOT within the allowance interval is REJECT RATE and is not stored', async (t) => {
  const f = await fixture(t);
  const writer = await Client.join(f);
  for (let ref = 1; ref <= 2; ref += 1) writer.append(ref, bytes(4));
  await writer.until(() => writer.has(E2E_FRAME.ACK, 2));
  writer.ws.send(encodeFrame(E2E_FRAME.SNAPSHOT, { seq: 1, knownBase: 0, ciphertext: bytes(4) }));
  writer.ws.send(encodeFrame(E2E_FRAME.SNAPSHOT, { seq: 2, knownBase: 1, ciphertext: bytes(4) }));
  await writer.until(() => writer.has(E2E_FRAME.REJECT));
  assert.deepEqual(writer.ofType(E2E_FRAME.REJECT), [{ type: E2E_FRAME.REJECT, code: E2E_REJECT.RATE, clientRef: 0 }]);
  await f.roomLog.whenIdle();
  assert.equal((await f.roomLog.open(DOC)).snapshot.baseSeq, 1);
});

test('a joiner behind a multi-chunk backlog and a live stream sees every seq once, in order', async (t) => {
  const BACKLOG = 1000;
  const LIVE = 200;
  const f = await fixture(t, { maxRoomBytes: 1024 * 1024 });
  for (let i = 0; i < BACKLOG; i += 1) await f.roomLog.append(DOC, bytes(16, i % 255));
  const writer = await Client.join(f);
  for (let ref = 1; ref <= LIVE; ref += 1) writer.append(ref, bytes(16));
  const joiner = await Client.join(f);
  await joiner.until(() => joiner.ofType(E2E_FRAME.UPDATE).at(-1)?.seq === BACKLOG + LIVE);
  assert.deepEqual(joiner.ofType(E2E_FRAME.UPDATE).map((frame) => frame.seq), Array.from({ length: BACKLOG + LIVE }, (_, i) => i + 1));
  const synced = joiner.frames.findIndex((frame) => frame.type === E2E_FRAME.SYNCED);
  assert.ok(joiner.frames.slice(0, synced).every((frame) => frame.seq <= joiner.frames[synced].seq), 'replay precedes live entries');
});

const stallStorage = (ldb) => {
  const transact = ldb._transact.bind(ldb);
  let resume;
  const stalled = new Promise((resolve) => { resume = resolve; });
  ldb._transact = (fn) => stalled.then(() => transact(fn));
  return resume;
};

test('the slow-consumer limit is checked after the fan-out a delayed write produces', async (t) => {
  const config = generousConfig();
  const f = await fixture(t, { config });
  const [writer, peer] = [await Client.join(f), await Client.join(f)];
  const serverPeer = [...f.relay.wss.clients].at(-1);
  const append = f.roomLog.append.bind(f.roomLog);
  let received = 0;
  f.roomLog.append = (...args) => { received += 1; return append(...args); };
  const resume = stallStorage(f.ldb);
  writer.append(1, bytes(8));
  await waitUntil(() => received === 1);
  // The peer falls behind only after the frame was received, while its write is still pending.
  Object.defineProperty(serverPeer, 'bufferedAmount', { get: () => config.MAX_WS_BUFFERED_BYTES + 1 });
  resume();
  assert.deepEqual(await within(peer.closed), { code: POLICY_CLOSE_CODE, reason: 'slow consumer' });
  await writer.until(() => writer.has(E2E_FRAME.ACK));
});
