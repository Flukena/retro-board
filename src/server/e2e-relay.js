import { WebSocketServer } from 'ws';
import {
  E2E_EPHEMERAL_MAX_BYTES, E2E_FRAME, E2E_MAX_FRAME_HEADER_BYTES, E2E_REJECT, decodeClientFrame, encodeFrame,
} from '../domain/e2e-envelope.js';
import { E2E_BUSY, E2E_CORRUPT, E2E_FROZEN, E2E_QUOTA, E2E_STALE_SNAPSHOT } from './e2e-room-log.js';
import { closeWebSocket } from './relay-lifecycle.js';
import { roomLogId } from './relay-log-id.js';
import { ROOM_CAPACITY_CODE } from './relay-room-registry.js';
import { POLICY_CLOSE_CODE, closeOnSessionExpiry, safeClose } from './relay-ws-traffic.js';

/** One SNAPSHOT per connection per this interval; more are REJECT RATE. */
export const E2E_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
/** Replay is sent in chunks of at most this many frames or bytes, whichever comes first. */
export const REPLAY_CHUNK_FRAMES = 256;
export const REPLAY_CHUNK_BYTES = 1024 * 1024;
/** A joiner whose buffer never drains below the slow-consumer limit within this time is closed. */
export const REPLAY_DRAIN_TIMEOUT_MS = 30_000;
const REPLAY_DRAIN_POLL_MS = 10;
const WS_OPEN_STATE = 1;
const UNSUPPORTED_DATA_CLOSE_CODE = 1003;
const SERVER_ERROR_CLOSE_CODE = 1011;
const GOING_AWAY_CLOSE_CODE = 1001;
const MALFORMED_REASON = 'malformed frame';
const RATE_LIMIT_REASON = 'rate-limit';
const SLOW_CONSUMER_REASON = 'slow consumer';
const UNAVAILABLE_REASON = 'room unavailable';
const RETIRED_REASON = 'room retired';
const NO_CLIENT_REF = 0;
const OPEN_LOG = '[yjs] e2e conn open';
const ERROR_LOG = '[yjs] e2e conn error';
const RATE_LIMIT_LOG = '[yjs] e2e rate-limit close';
const CORRUPT_LOG = '[yjs] e2e room log corrupt';

/** Log error code → REJECT code the client can act on. Anything else is a storage failure. */
const REJECT_FOR_ERROR = new Map([
  [E2E_QUOTA, E2E_REJECT.QUOTA],
  [E2E_FROZEN, E2E_REJECT.FROZEN],
  [E2E_BUSY, E2E_REJECT.RATE],
  [ROOM_CAPACITY_CODE, E2E_REJECT.RATE],
  [E2E_STALE_SNAPSHOT, E2E_REJECT.STALE_SNAPSHOT],
]);

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

/** Replay frames, encoded lazily so the whole history is never pre-encoded. */
function* replayFrames(state) {
  if (state.snapshot) yield encodeFrame(E2E_FRAME.SNAPSHOT_OUT, { seq: state.snapshot.baseSeq, ciphertext: state.snapshot.bytes });
  for (const { seq, bytes } of state.updates) yield encodeFrame(E2E_FRAME.UPDATE, { seq, ciphertext: bytes });
  yield encodeFrame(E2E_FRAME.SYNCED, { seq: state.head });
}

/** Groups frames into chunks bounded by REPLAY_CHUNK_FRAMES and REPLAY_CHUNK_BYTES. */
function* replayChunks(frames) {
  let chunk = [];
  let bytes = 0;
  for (const frame of frames) {
    if (chunk.length > 0 && (chunk.length >= REPLAY_CHUNK_FRAMES || bytes + frame.byteLength > REPLAY_CHUNK_BYTES)) {
      yield { frames: chunk, bytes };
      chunk = [];
      bytes = 0;
    }
    chunk.push(frame);
    bytes += frame.byteLength;
  }
  if (chunk.length > 0) yield { frames: chunk, bytes };
}

/** One encrypted-room socket: paced replay on join, then ordered live delivery of the room log. */
class E2EConnection {
  #ws;
  #docName;
  #room;
  #meter;
  #deps;
  #joined = false;
  #closed = false;
  #limited = false;
  #backlog = [];
  #lastSnapshotAt = Number.NEGATIVE_INFINITY;
  // The log hands listeners the same ciphertext object that was appended, so identity
  // tells this socket which entries are its own: those become ACKs, never echoes.
  #ownAppends = new Map();
  #ownSnapshots = new Set();
  #unsubscribe = null;

  constructor(ws, docName, room, deps) {
    this.#ws = ws;
    this.#docName = docName;
    this.#room = room;
    this.#deps = deps;
    this.#meter = deps.traffic.attach(ws, docName);
  }

  get ws() { return this.#ws; }

  start(clientIp) {
    const { roomLog, logger } = this.#deps;
    logger.log(OPEN_LOG, { docName: roomLogId(this.#docName), client: roomLogId(`ip:${clientIp}`) });
    this.#ws.on('error', (error) => {
      logger.warn(ERROR_LOG, { docName: roomLogId(this.#docName), err: error.message, code: error.code });
      try { this.#ws.terminate(); } catch { /* already closed */ }
    });
    this.#ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    this.#ws.once('close', () => this.#onClose());
    roomLog.subscribeAfterReplay(this.#docName, (entry) => this.#onEntry(entry))
      .then(({ state, unsubscribe }) => this.#join(state, unsubscribe), (error) => this.#fail(error));
  }

  /** Sends one frame, then enforces the slow-consumer limit on what is actually buffered. */
  send(frame) {
    if (this.#ws.readyState !== WS_OPEN_STATE) return;
    this.#ws.send(frame);
    this.#deps.traffic.closeSlowConsumers([this.#ws]);
  }

  async #join(state, unsubscribe) {
    if (this.#closed) { unsubscribe(); return; }
    this.#unsubscribe = unsubscribe;
    for (const chunk of replayChunks(replayFrames(state))) {
      if (!(await this.#sendChunk(chunk))) return;
    }
    this.#joined = true;
    const backlog = this.#backlog;
    this.#backlog = [];
    backlog.forEach((entry) => this.#deliver(entry));
  }

  // Waits until the chunk fits under the slow-consumer limit, pays egress for the chunk, sends it.
  async #sendChunk({ frames, bytes }) {
    const { traffic } = this.#deps;
    const deadline = Date.now() + REPLAY_DRAIN_TIMEOUT_MS;
    while (!this.#closed && !traffic.canBuffer(this.#ws, bytes)) {
      if (Date.now() >= deadline) {
        safeClose(this.#ws, POLICY_CLOSE_CODE, SLOW_CONSUMER_REASON);
        return false;
      }
      await delay(REPLAY_DRAIN_POLL_MS);
    }
    if (this.#closed || this.#ws.readyState !== WS_OPEN_STATE || !this.#meter.sendBatch(frames)) return false;
    traffic.closeSlowConsumers([this.#ws]);
    return true;
  }

  // Entries notified before the replay finished wait here, in order, so a joiner during a
  // stream of appends sees every seq once and nothing before its SYNCED.
  #onEntry(entry) {
    if (this.#joined) this.#deliver(entry);
    else this.#backlog.push(entry);
  }

  #deliver(entry) {
    if (entry.kind === 'update') this.#deliverUpdate(entry);
    else if (entry.kind === 'snapshot') this.#deliverSnapshot(entry);
    else if (entry.kind === 'resumed') this.send(encodeFrame(E2E_FRAME.RESUMED));
  }

  #deliverUpdate({ seq, bytes }) {
    const clientRef = this.#ownAppends.get(bytes);
    if (clientRef === undefined) {
      this.send(encodeFrame(E2E_FRAME.UPDATE, { seq, ciphertext: bytes }));
      return;
    }
    this.#ownAppends.delete(bytes);
    this.send(encodeFrame(E2E_FRAME.ACK, { seq, clientRef }));
  }

  #deliverSnapshot({ baseSeq, bytes }) {
    if (this.#ownSnapshots.delete(bytes)) return;
    this.send(encodeFrame(E2E_FRAME.SNAPSHOT_OUT, { seq: baseSeq, ciphertext: bytes }));
  }

  #onMessage(data, isBinary) {
    if (this.#limited) return;
    const size = data?.byteLength ?? 0;
    const isSnapshot = isBinary && data[0] === E2E_FRAME.SNAPSHOT;
    // A snapshot pays a message token but not ordinary bytes; its own allowance bounds it.
    if (!this.#meter.admitIngress(isSnapshot ? 0 : size)) {
      this.#limited = true;
      this.#deps.logger.warn(RATE_LIMIT_LOG, { docName: roomLogId(this.#docName), size });
      safeClose(this.#ws, POLICY_CLOSE_CODE, RATE_LIMIT_REASON);
      return;
    }
    if (isSnapshot && !this.#takeSnapshotAllowance()) {
      this.send(encodeFrame(E2E_FRAME.REJECT, { code: E2E_REJECT.RATE, clientRef: NO_CLIENT_REF }));
      return;
    }
    const frame = isBinary ? decodeClientFrame(data, this.#deps.frameLimits) : null;
    if (!frame) {
      this.#limited = true;
      this.send(encodeFrame(E2E_FRAME.REJECT, { code: E2E_REJECT.MALFORMED, clientRef: NO_CLIENT_REF }));
      safeClose(this.#ws, UNSUPPORTED_DATA_CLOSE_CODE, MALFORMED_REASON);
      return;
    }
    if (frame.type === E2E_FRAME.APPEND) this.#append(frame);
    else if (frame.type === E2E_FRAME.SNAPSHOT) this.#snapshot(frame);
    else this.#ephemeral(frame);
  }

  #takeSnapshotAllowance() {
    const now = Date.now();
    if (now - this.#lastSnapshotAt < E2E_SNAPSHOT_MIN_INTERVAL_MS) return false;
    this.#lastSnapshotAt = now;
    return true;
  }

  #append({ clientRef, ciphertext }) {
    const { roomLog, touch } = this.#deps;
    this.#ownAppends.set(ciphertext, clientRef);
    roomLog.append(this.#docName, ciphertext).then(() => touch(this.#docName), (error) => {
      this.#ownAppends.delete(ciphertext);
      this.#refuse(error, clientRef);
    });
  }

  #snapshot({ seq, ciphertext }) {
    this.#ownSnapshots.add(ciphertext);
    this.#deps.roomLog.snapshot(this.#docName, seq, ciphertext).catch((error) => {
      this.#ownSnapshots.delete(ciphertext);
      this.#refuse(error, NO_CLIENT_REF);
    });
  }

  #ephemeral({ ciphertext }) {
    const frame = encodeFrame(E2E_FRAME.EPHEMERAL_OUT, { ciphertext });
    for (const peer of this.#room.connections) if (peer !== this) peer.send(frame);
  }

  #refuse(error, clientRef) {
    const code = REJECT_FOR_ERROR.get(error?.code);
    if (code === undefined) this.#fail(error);
    else this.send(encodeFrame(E2E_FRAME.REJECT, { code, clientRef }));
  }

  #fail(error) {
    if (error?.code === E2E_CORRUPT) this.#deps.logger.warn(CORRUPT_LOG, { docName: roomLogId(this.#docName) });
    else this.#deps.onStorageFailure(error);
    safeClose(this.#ws, SERVER_ERROR_CLOSE_CODE, UNAVAILABLE_REASON);
  }

  #onClose() {
    this.#closed = true;
    this.#room.connections.delete(this);
    this.#ownAppends.clear();
    this.#ownSnapshots.clear();
    this.#backlog = [];
    this.#unsubscribe?.();
  }
}

/**
 * WebSocket path `/rooms/<handle>/e2e`: carries framed ciphertext between browsers and the
 * encrypted room log. The relay never decrypts and never creates a Y.Doc for these rooms.
 * Admission (origin, cookie+epoch, gates, upgrade tokens, connection slots) is done by the
 * caller before handleUpgrade. The relay owns its own `wss`, whose payload ceiling fits one
 * room-sized snapshot; normal rooms keep their smaller limit.
 * Ports: roomLog (E2ERoomLog), traffic (RelayWsTraffic), touch(docName), onStorageFailure(error).
 */
export function createE2ERelay({ roomLog, traffic, maxRoomBytes, maxAppendBytes, touch, onStorageFailure, logger = console }) {
  const maxSnapshotFrameBytes = maxRoomBytes + E2E_MAX_FRAME_HEADER_BYTES;
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxSnapshotFrameBytes });
  const deps = {
    roomLog, traffic, touch, onStorageFailure, logger,
    frameLimits: {
      maxBytes: maxSnapshotFrameBytes,
      maxEphemeralBytes: E2E_EPHEMERAL_MAX_BYTES,
      maxFrameBytesByType: { [E2E_FRAME.APPEND]: maxAppendBytes, [E2E_FRAME.SNAPSHOT]: maxSnapshotFrameBytes },
    },
  };
  // A room counts as active from its first admitted upgrade until its last raw socket closes.
  const rooms = new Map();

  const leave = (docName, room) => {
    room.members -= 1;
    if (room.members > 0 || rooms.get(docName) !== room) return;
    rooms.delete(docName);
    roomLog.forget(docName);
  };

  const closeRoom = (docName, code, reason) => {
    for (const connection of rooms.get(docName)?.connections ?? []) safeClose(connection.ws, code, reason);
  };

  return {
    wss,
    /** Call only after the shared admission gates passed and `req.wsSecurityContext` is set. */
    handleUpgrade(req, socket, head) {
      const { docName, clientIp, expiresAt } = req.wsSecurityContext;
      let room = rooms.get(docName);
      if (!room) {
        room = { members: 0, connections: new Set() };
        rooms.set(docName, room);
      }
      room.members += 1;
      const joined = room;
      socket.once('close', () => leave(docName, joined));
      wss.handleUpgrade(req, socket, head, (ws) => {
        const connection = new E2EConnection(ws, docName, joined, deps);
        joined.connections.add(connection);
        closeOnSessionExpiry(ws, expiresAt);
        connection.start(clientIp);
        wss.emit('connection', ws, req);
      });
    },
    closeRoom,
    /** Retirement: no socket may outlive the room, and the log drops its memory of it. */
    retireRoom(docName) {
      closeRoom(docName, GOING_AWAY_CLOSE_CODE, RETIRED_REASON);
      roomLog.forget(docName);
    },
    connectionsFor: (docName) => rooms.get(docName)?.members ?? 0,
    activeRooms: () => rooms.size,
    /** Shutdown: close every encrypted socket like the main path, then let queued log writes land. */
    async drain() {
      await Promise.all([...wss.clients].map(closeWebSocket));
      await roomLog.whenIdle();
    },
  };
}
