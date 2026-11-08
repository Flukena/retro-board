import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { tempRoot } from '../test-support/relay-harness.mjs';
import {
  ORIGIN, PASSWORD, createLockedRoom as createLockedRoomWith, createNormalRoom, lockedRelay,
} from '../test-support/locked-room-harness.mjs';
import { createRoomLock, encryptFrame } from '../client/room-lock/e2e-crypto.js';
import { e2eAad } from '../domain/room-lock-contract.js';
import { E2E_FRAME, E2E_REJECT, decodeServerFrame, encodeFrame } from '../domain/e2e-envelope.js';
import { ROOM_LOCK_META, decodeLockRecord, encodeLockRecord } from './room-lock-record.js';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');

const FRAME_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024 });
const WAIT_MS = 5_000;
const NORMAL_CLOSE = 1000;
const UNSUPPORTED_DATA = 1003;
const STREAM_APPENDS = 100;
const ACKS_BEFORE_JOIN = 20;
const ACKS_BEFORE_SIGTERM = 10;
const ROTATED_EPOCH = 1;
const CORRUPT_RECORD = 'not a lock record';
const STATUS = Object.freeze({ OK: 200, CREATED: 201, UNAUTHORIZED: 401, NOT_FOUND: 404, UNAVAILABLE: 503 });
const encoder = new TextEncoder();
// One PBKDF2 derivation for the whole file; every locked room in it shares these params.
const ROOM_LOCK = await createRoomLock(PASSWORD);

const createLockedRoom = (env) => createLockedRoomWith(env, ROOM_LOCK);

const e2eUrl = (relay, room) => `${relay.wsUrl}/rooms/${room.handle}/e2e`;
const socketOptions = (cookie) => ({ origin: ORIGIN, ...(cookie ? { headers: { cookie } } : {}) });

const upgradeStatus = (url, cookie) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, socketOptions(cookie));
  ws.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
  ws.once('open', () => { ws.close(); reject(new Error('upgrade unexpectedly succeeded')); });
  ws.once('error', () => { /* unexpected-response is authoritative */ });
});

const openPlain = async (url, cookie) => {
  const ws = new WebSocket(url, socketOptions(cookie));
  await once(ws, 'open');
  return ws;
};

const RETRY_DELAY_MS = 50;
// The relay frees a room slot when its raw socket closes, a moment after the client sees the close.
async function openPlainEventually(url, cookie, deadline = Date.now() + WAIT_MS) {
  try {
    return await openPlain(url, cookie);
  } catch (error) {
    if (Date.now() > deadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return openPlainEventually(url, cookie, deadline);
  }
}

/** A test browser on the encrypted socket: records every decoded server frame. */
class E2EClient {
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

  // The listener must exist before 'open': replay frames can arrive in the same read as the 101.
  static async connect(url, cookie) {
    const client = new E2EClient(new WebSocket(url, socketOptions(cookie)));
    await once(client.ws, 'open');
    return client;
  }

  static async join(relay, room, url = e2eUrl(relay, room)) {
    const client = await E2EClient.connect(url, room.cookie);
    try {
      await client.until((frames) => frames.some((frame) => frame?.type === E2E_FRAME.SYNCED));
    } catch (error) {
      throw new Error(`${error.message}\nrelay output:\n${relay.output()}`);
    }
    return client;
  }

  until(predicate, timeoutMs = WAIT_MS) {
    if (predicate(this.frames)) return Promise.resolve(this.frames);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#waiters.delete(check); reject(new Error(`timed out; frames ${JSON.stringify(this.frames.map((f) => f?.type))}`)); }, timeoutMs);
      const check = () => {
        if (!predicate(this.frames)) return;
        clearTimeout(timer);
        this.#waiters.delete(check);
        resolve(this.frames);
      };
      this.#waiters.add(check);
    });
  }

  ofType(type) { return this.frames.filter((frame) => frame?.type === type); }
  append(clientRef, ciphertext) { this.ws.send(encodeFrame(E2E_FRAME.APPEND, { clientRef, ciphertext })); }
  snapshot(seq, ciphertext, knownBase = 0) { this.ws.send(encodeFrame(E2E_FRAME.SNAPSHOT, { seq, knownBase, ciphertext })); }
  ephemeral(ciphertext) { this.ws.send(encodeFrame(E2E_FRAME.EPHEMERAL, { ciphertext })); }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close(NORMAL_CLOSE);
    await this.closed;
  }
}

const cipher = (label) => encoder.encode(`ciphertext-${label}-${Math.random()}`);
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const ackCount = (frames) => frames.filter((frame) => frame?.type === E2E_FRAME.ACK).length;

async function filesUnder(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

async function occurrencesInDb(dbDir, needle) {
  let hits = 0;
  for (const file of await filesUnder(dbDir)) {
    const bytes = await readFile(file);
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) hits += 1;
  }
  return hits;
}

test('an append is ACKed to its sender with the clientRef and fanned out to the others only', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env);
  const [a, b] = [await E2EClient.join(env.relay, room), await E2EClient.join(env.relay, room)];
  assert.deepEqual(a.ofType(E2E_FRAME.SYNCED), [{ type: E2E_FRAME.SYNCED, seq: 0 }]);
  const payload = cipher('fan-out');
  a.append(7, payload);
  await a.until((frames) => ackCount(frames) === 1);
  await b.until((frames) => frames.some((frame) => frame?.type === E2E_FRAME.UPDATE));
  assert.deepEqual(a.ofType(E2E_FRAME.ACK), [{ type: E2E_FRAME.ACK, seq: 1, clientRef: 7 }]);
  assert.equal(a.ofType(E2E_FRAME.UPDATE).length, 0, 'the sender gets no echo');
  const [update] = b.ofType(E2E_FRAME.UPDATE);
  assert.equal(update.seq, 1);
  assert.ok(sameBytes(update.ciphertext, payload));
  assert.equal(b.ofType(E2E_FRAME.ACK).length, 0);
  await Promise.all([a.close(), b.close()]);
});

test('a late joiner gets the snapshot, then the tail after it, then SYNCED at the head', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env);
  const writer = await E2EClient.join(env.relay, room);
  const watcher = await E2EClient.join(env.relay, room);
  const updates = [cipher('u1'), cipher('u2'), cipher('u3'), cipher('u4')];
  updates.slice(0, 3).forEach((bytes, i) => writer.append(i + 1, bytes));
  await writer.until((frames) => ackCount(frames) === 3);
  const snapshot = cipher('snapshot');
  writer.snapshot(2, snapshot);
  await watcher.until((frames) => frames.some((frame) => frame?.type === E2E_FRAME.SNAPSHOT_OUT));
  writer.append(4, updates[3]);
  await writer.until((frames) => ackCount(frames) === 4);
  assert.equal(writer.ofType(E2E_FRAME.SNAPSHOT_OUT).length, 0, 'the snapshot writer gets no echo');
  const late = await E2EClient.join(env.relay, room);
  const [snapshotOut, ...rest] = late.frames;
  assert.equal(snapshotOut.type, E2E_FRAME.SNAPSHOT_OUT);
  assert.equal(snapshotOut.seq, 2);
  assert.ok(sameBytes(snapshotOut.ciphertext, snapshot));
  assert.deepEqual(rest.map(({ type, seq }) => ({ type, seq })), [
    { type: E2E_FRAME.UPDATE, seq: 3 }, { type: E2E_FRAME.UPDATE, seq: 4 }, { type: E2E_FRAME.SYNCED, seq: 4 },
  ]);
  assert.ok(sameBytes(rest[1].ciphertext, updates[3]));
  await Promise.all([writer.close(), watcher.close(), late.close()]);
});

test('a socket that joins during a stream of appends misses none and sees each seq once', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env);
  const writer = await E2EClient.join(env.relay, room);
  for (let ref = 1; ref <= STREAM_APPENDS; ref += 1) writer.append(ref, cipher(`stream-${ref}`));
  await writer.until((frames) => ackCount(frames) >= ACKS_BEFORE_JOIN);
  const joiner = await E2EClient.join(env.relay, room);
  await joiner.until((frames) => frames.filter((frame) => frame?.type === E2E_FRAME.UPDATE).at(-1)?.seq === STREAM_APPENDS);
  const seen = joiner.ofType(E2E_FRAME.UPDATE).map((frame) => frame.seq);
  assert.deepEqual(seen, Array.from({ length: STREAM_APPENDS }, (_, i) => i + 1));
  await writer.until((frames) => ackCount(frames) === STREAM_APPENDS);
  await Promise.all([writer.close(), joiner.close()]);
});

test('ephemeral frames reach the other sockets only and are never stored; stored ciphertext holds no plaintext', async (t) => {
  const root = await tempRoot(t);
  const env = await lockedRelay(t, {}, { root });
  const room = await createLockedRoom(env);
  const [a, b] = [await E2EClient.join(env.relay, room), await E2EClient.join(env.relay, room)];
  const marker = encoder.encode(`PLAINTEXT-MARKER-${crypto.randomUUID()}`);
  const stored = await encryptFrame(ROOM_LOCK.dek, e2eAad(room.handle, 0, 'update'), marker);
  const ephemeral = await encryptFrame(ROOM_LOCK.dek, e2eAad(room.handle, 0, 'ephemeral'), encoder.encode('cursor'));
  a.ephemeral(ephemeral);
  a.append(1, stored);
  await a.until((frames) => ackCount(frames) === 1);
  await b.until((frames) => frames.some((frame) => frame?.type === E2E_FRAME.EPHEMERAL_OUT));
  assert.ok(sameBytes(b.ofType(E2E_FRAME.EPHEMERAL_OUT)[0].ciphertext, ephemeral));
  assert.equal(a.ofType(E2E_FRAME.EPHEMERAL_OUT).length, 0);
  await Promise.all([a.close(), b.close()]);
  assert.equal((await env.relay.stop()).code, 0, env.relay.output());
  assert.ok(await occurrencesInDb(env.relay.dbDir, Buffer.from(stored)) > 0, 'positive control: the scan finds stored ciphertext');
  assert.equal(await occurrencesInDb(env.relay.dbDir, Buffer.from(marker)), 0, 'no plaintext in LevelDB');
  assert.equal(await occurrencesInDb(env.relay.dbDir, Buffer.from(ephemeral)), 0, 'ephemeral ciphertext is not stored');
});

test('a malformed frame gets REJECT MALFORMED with clientRef 0, then close 1003', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env);
  const client = await E2EClient.join(env.relay, room);
  const UNKNOWN_FRAME_TYPE = 99;
  client.ws.send(new Uint8Array([UNKNOWN_FRAME_TYPE, 1, 2, 3]));
  const { code } = await client.closed;
  assert.equal(code, UNSUPPORTED_DATA);
  assert.deepEqual(client.ofType(E2E_FRAME.REJECT), [{ type: E2E_FRAME.REJECT, code: E2E_REJECT.MALFORMED, clientRef: 0 }]);
});

test('upgrade gates: no cookie 401, normal room on /e2e 404, locked room on the y-websocket path 404', async (t) => {
  const env = await lockedRelay(t);
  const locked = await createLockedRoom(env);
  const normal = await createNormalRoom(env.relay);
  assert.equal(await upgradeStatus(e2eUrl(env.relay, locked), null), STATUS.UNAUTHORIZED);
  assert.equal(await upgradeStatus(e2eUrl(env.relay, normal), normal.cookie), STATUS.NOT_FOUND);
  assert.equal(await upgradeStatus(`${env.relay.wsUrl}/rooms/${locked.handle}`, locked.cookie), STATUS.NOT_FOUND);
  assert.equal(await upgradeStatus(`${env.relay.wsUrl}/yjs/rooms/${locked.handle}?awarenessId=1`, locked.cookie), STATUS.NOT_FOUND);
  const prefixed = await E2EClient.join(env.relay, locked, `${env.relay.wsUrl}/yjs/rooms/${locked.handle}/e2e`);
  await prefixed.close();
});

test('normal and encrypted rooms share the active-room cap', async (t) => {
  const env = await lockedRelay(t, { YJS_MAX_ACTIVE_ROOMS: '1' });
  const locked = await createLockedRoom(env);
  const normal = await createNormalRoom(env.relay);
  const encrypted = await E2EClient.join(env.relay, locked);
  assert.equal(await upgradeStatus(`${env.relay.wsUrl}/rooms/${normal.handle}`, normal.cookie), STATUS.UNAVAILABLE);
  const second = await E2EClient.join(env.relay, locked);
  await Promise.all([encrypted.close(), second.close()]);
  const plain = await openPlainEventually(`${env.relay.wsUrl}/rooms/${normal.handle}`, normal.cookie);
  assert.equal(await upgradeStatus(e2eUrl(env.relay, locked), locked.cookie), STATUS.UNAVAILABLE);
  plain.close();
  await once(plain, 'close');
});

test('SIGTERM under writes exits cleanly and a reopen replays every ACKed seq', async (t) => {
  const root = await tempRoot(t);
  const env = await lockedRelay(t, {}, { root });
  const room = await createLockedRoom(env);
  const writer = await E2EClient.join(env.relay, room);
  const sent = new Map();
  for (let ref = 1; ref <= STREAM_APPENDS; ref += 1) {
    sent.set(ref, cipher(`drain-${ref}`));
    writer.append(ref, sent.get(ref));
  }
  await writer.until((frames) => ackCount(frames) >= ACKS_BEFORE_SIGTERM);
  const exit = await env.relay.stop('SIGTERM');
  assert.equal(exit.code, 0, env.relay.output());
  assert.equal((await writer.closed).code, 1001, 'encrypted sockets close like the main path on shutdown');
  const acked = writer.ofType(E2E_FRAME.ACK);
  const reopened = await lockedRelay(t, {}, { root });
  const reader = await E2EClient.join(reopened.relay, room);
  const replay = new Map(reader.ofType(E2E_FRAME.UPDATE).map((frame) => [frame.seq, frame.ciphertext]));
  for (const { seq, clientRef } of acked) {
    assert.ok(replay.has(seq), `ACKed seq ${seq} survives the restart`);
    assert.ok(sameBytes(replay.get(seq), sent.get(clientRef)), `seq ${seq} holds clientRef ${clientRef}'s bytes`);
  }
  await reader.close();
});

test('a restart replays snapshot and tail from LevelDB', async (t) => {
  const root = await tempRoot(t);
  const env = await lockedRelay(t, {}, { root });
  const room = await createLockedRoom(env);
  const writer = await E2EClient.join(env.relay, room);
  const [first, second, third] = [cipher('r1'), cipher('r2'), cipher('r3')];
  writer.append(1, first);
  writer.append(2, second);
  await writer.until((frames) => ackCount(frames) === 2);
  writer.snapshot(1, cipher('r-snapshot'));
  writer.append(3, third);
  await writer.until((frames) => ackCount(frames) === 3);
  await writer.close();
  await env.relay.stop();
  const reopened = await lockedRelay(t, {}, { root });
  const reader = await E2EClient.join(reopened.relay, room);
  assert.deepEqual(reader.frames.map(({ type, seq }) => ({ type, seq })), [
    { type: E2E_FRAME.SNAPSHOT_OUT, seq: 1 }, { type: E2E_FRAME.UPDATE, seq: 2 }, { type: E2E_FRAME.UPDATE, seq: 3 }, { type: E2E_FRAME.SYNCED, seq: 3 },
  ]);
  assert.ok(sameBytes(reader.frames[1].ciphertext, second));
  await reader.close();
});

async function rewriteLock(dbDir, docName, rewrite) {
  const ldb = new LeveldbPersistence(dbDir);
  try {
    await ldb.setMeta(docName, ROOM_LOCK_META, rewrite(await ldb.getMeta(docName, ROOM_LOCK_META)));
  } finally {
    await ldb.destroy();
  }
}

test('a cookie from an older key epoch fails the upgrade with 401; an unreadable lock refuses with 503', async (t) => {
  const root = await tempRoot(t);
  const env = await lockedRelay(t, {}, { root });
  const room = await createLockedRoom(env);
  await (await E2EClient.join(env.relay, room)).close();
  await env.relay.stop();
  await rewriteLock(env.relay.dbDir, room.docName, (raw) => encodeLockRecord({ ...decodeLockRecord(raw), keyEpoch: ROTATED_EPOCH }));
  const rotated = await lockedRelay(t, {}, { root });
  assert.equal(await upgradeStatus(e2eUrl(rotated.relay, room), room.cookie), STATUS.UNAUTHORIZED);
  await rotated.relay.stop();
  await rewriteLock(env.relay.dbDir, room.docName, () => CORRUPT_RECORD);
  const corrupt = await lockedRelay(t, {}, { root });
  assert.equal(await upgradeStatus(e2eUrl(corrupt.relay, room), room.cookie), STATUS.UNAVAILABLE);
});

test('legacy token URLs get the same lock checks: a locked room is 404, an unreadable lock 503, a normal room still opens', async (t) => {
  const root = await tempRoot(t);
  const legacyEnv = { YJS_ALLOW_LEGACY_URL_TOKENS: '1' };
  const env = await lockedRelay(t, legacyEnv, { root });
  const locked = await createLockedRoom(env);
  const normal = await createNormalRoom(env.relay);
  const legacyUrl = (relay, room, prefix = '') => `${relay.wsUrl}${prefix}/board-${room.code}-${room.token}`;
  const plain = await openPlain(legacyUrl(env.relay, normal));
  plain.close();
  await once(plain, 'close');
  assert.equal(await upgradeStatus(legacyUrl(env.relay, locked), null), STATUS.NOT_FOUND);
  assert.equal(await upgradeStatus(legacyUrl(env.relay, locked, '/yjs'), locked.cookie), STATUS.NOT_FOUND);
  const opens = env.relay.output().match(/\[yjs\] conn open/g) ?? [];
  assert.equal(opens.length, 1, 'only the normal room opened a y-websocket connection; the locked room never got a Y.Doc');
  await env.relay.stop();
  await rewriteLock(env.relay.dbDir, locked.docName, () => CORRUPT_RECORD);
  const corrupt = await lockedRelay(t, legacyEnv, { root });
  assert.equal(await upgradeStatus(legacyUrl(corrupt.relay, locked), null), STATUS.UNAVAILABLE);
});
