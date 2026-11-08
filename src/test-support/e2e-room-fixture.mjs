import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { decodeClientFrame, decodeServerFrame } from '../domain/e2e-envelope.js';
import { KEY_ROTATED_CLOSE_CODE, e2eAad } from '../domain/room-lock-contract.js';
import { encryptFrame } from '../client/room-lock/e2e-crypto.js';
import { E2EProvider } from '../client/session/e2e-provider.js';
import { E2ERoomLog } from '../server/e2e-room-log.js';
import { createE2ERelay } from '../server/e2e-relay.js';
import { readRelayConfig } from '../server/relay-config.js';
import { RelayWsTraffic } from '../server/relay-ws-traffic.js';
import { ROOM_LOCK_META, encodeLockRecord } from '../server/room-lock-record.js';
import { lockRecord } from '../server/room-lock-fixtures.mjs';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');

export const E2E_TEST_HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const DOC = 'yjs/board-e2e-provider-room';
const IP = '203.0.113.7';
const GENEROUS = '100000';
const FRAME_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024 });
const POLL_MS = 5;
const WAIT_MS = 5_000;
const FREEZE_TTL_MS = 60_000;
const KEY_ROTATED_REASON = 'key rotated';
const quietLogger = { log() {}, warn() {} };
const approve = async () => true;

const generousConfig = () => readRelayConfig({
  YJS_WS_BURST_MESSAGES: GENEROUS, YJS_ROOM_WS_BURST_MESSAGES: GENEROUS, YJS_GLOBAL_WS_BURST_MESSAGES: GENEROUS,
  YJS_WS_EGRESS_CONNECTION_BURST_MESSAGES: GENEROUS, YJS_WS_EGRESS_ROOM_BURST_MESSAGES: GENEROUS,
  YJS_WS_EGRESS_GLOBAL_BURST_MESSAGES: GENEROUS,
});

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Polls until `predicate` holds; fails with `label` after a bounded wait. */
export async function until(predicate, label = 'condition') {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(POLL_MS);
  }
}

export async function roomKey(keyEpoch = 0) {
  const dek = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { roomHandle: E2E_TEST_HANDLE, keyEpoch, dek };
}

/**
 * Records and rewrites frames on the provider's real sockets. A rule `{ type, action, once }` matches a server frame
 * by type; the action returns the bytes to deliver, or null to drop the frame.
 */
export class SocketTap {
  sockets = [];
  sent = [];
  received = [];
  #rules = [];

  constructor() {
    const tap = this;
    this.Impl = class TapSocket extends WebSocket {
      constructor(url) {
        super(url);
        tap.sockets.push(this);
      }

      get onmessage() { return super.onmessage; }

      set onmessage(handler) {
        super.onmessage = (event) => {
          const bytes = tap.#inbound(new Uint8Array(event.data));
          if (bytes) handler({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
        };
      }

      send(data) {
        tap.sent.push(decodeClientFrame(data, FRAME_LIMITS));
        super.send(data);
      }
    };
  }

  rule(type, action, { once = true } = {}) { this.#rules.push({ type, action, once }); }

  get last() { return this.sockets.at(-1); }

  sentOfType(type) { return this.sent.filter((frame) => frame?.type === type); }

  receivedOfType(type) { return this.received.filter((frame) => frame?.type === type); }

  #inbound(bytes) {
    const frame = decodeServerFrame(bytes, FRAME_LIMITS);
    this.received.push(frame);
    const index = this.#rules.findIndex((rule) => rule.type === frame?.type);
    if (index < 0) return bytes;
    const rule = this.#rules[index];
    if (rule.once) this.#rules.splice(index, 1);
    return rule.action(bytes);
  }
}

export const dropFrame = () => null;
/** Flips one ciphertext bit so AES-GCM authentication fails. */
export const flipLastBit = (bytes) => {
  const copy = Uint8Array.from(bytes);
  copy[copy.length - 1] ^= 1;
  return copy;
};

/** A real E2E relay with the real E2ERoomLog over a temp LevelDB, plus helpers to make providers on it. */
export async function e2eRoom(t, { maxRoomBytes = 1024 * 1024, maxAppendBytes = 256 * 1024 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-provider-'));
  const ldb = new LeveldbPersistence(dir);
  await ldb.setMeta(DOC, ROOM_LOCK_META, encodeLockRecord(lockRecord()));
  const roomLog = new E2ERoomLog({ ldb, maxRoomBytes, reserveStore: () => () => {} });
  const relay = createE2ERelay({
    roomLog, traffic: new RelayWsTraffic(generousConfig(), { log: quietLogger }), maxRoomBytes, maxAppendBytes,
    touch: () => {}, onStorageFailure: () => {}, logger: quietLogger,
  });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    req.wsSecurityContext = { docName: DOC, clientIp: IP, expiresAt: null };
    relay.handleUpgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const created = [];
  t.after(async () => {
    created.forEach(({ provider, doc }) => { provider.destroy(); doc.destroy(); });
    for (const client of relay.wss.clients) client.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    await roomLog.whenIdle();
    await ldb.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  const wsBaseUrl = `ws://127.0.0.1:${server.address().port}/rooms`;
  return {
    roomLog, relay, docName: DOC,
    /** A connected provider on a fresh doc; options go to E2EProvider. */
    join(key, { clientID, tap = new SocketTap(), events = new EventTarget(), ...options } = {}) {
      const doc = new Y.Doc();
      if (clientID !== undefined) doc.clientID = clientID;
      const provider = new E2EProvider(wsBaseUrl, E2E_TEST_HANDLE, doc, {
        key, WebSocketImpl: tap.Impl, eventTarget: events, random: () => 0, syncedSettleMs: 0, ...options,
      });
      created.push({ provider, doc });
      return { doc, provider, tap, events };
    },
    freeze: () => roomLog.freeze(DOC, FREEZE_TTL_MS, { verify: approve }),
    release: (rotationId) => roomLog.release(DOC, rotationId),
    /** Commits a key rotation whose snapshot is `state` under `nextKey`, then closes every socket with 4001. */
    async rotate(rotationId, nextKey, state) {
      const { head } = await roomLog.open(DOC);
      const aad = e2eAad(E2E_TEST_HANDLE, nextKey.keyEpoch, 'snapshot', head);
      const snapshot = await encryptFrame(nextKey.dek, aad, state);
      await roomLog.commitRotation(DOC, {
        rotationId, expectedHead: head, verify: approve, snapshot, blobInventory: [],
        lockRecord: lockRecord({ keyEpoch: nextKey.keyEpoch }),
      });
      relay.closeRoom(DOC, KEY_ROTATED_CLOSE_CODE, KEY_ROTATED_REASON);
    },
  };
}

export const synced = (...peers) => until(() => peers.every(({ provider }) => provider.synced), 'synced');
export const delivered = (...peers) => until(() => peers.every(({ provider }) => provider.pendingDelivery === 0), 'delivery');
export const textOf = ({ doc }, name = 'text') => doc.getText(name).toString();
