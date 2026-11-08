import { syncResponseLimits } from './relay-config.js';
import { createTrafficBucket, takeTrafficBudget, takeTrafficTokens } from './relay-rate-bucket.js';
import { roomLogId } from './relay-log-id.js';

export const POLICY_CLOSE_CODE = 1008;
export const SESSION_EXPIRED_REASON = 'session expired';
const EGRESS_LIMIT_REASON = 'egress rate-limit';
const SLOW_CONSUMER_REASON = 'slow consumer';
const EGRESS_LIMIT_LOG = '[yjs] egress-limit close';
// Frame headers and protocol framing around the largest document an egress message may carry.
const EGRESS_MESSAGE_SLACK_BYTES = 64 * 1024;
const MIN_TIMER_MS = 1;
const UNAVAILABLE_STATUS = 503;
const TOO_MANY_STATUS = 429;

const limitsOf = (maxMessages, messagesPerSecond, maxBytes, bytesPerSecond) => ({ maxMessages, messagesPerSecond, maxBytes, bytesPerSecond });
const bucketFor = (limits) => createTrafficBucket(limits.maxMessages, limits.maxBytes);
const messageSize = (data) => (typeof data === 'string' ? Buffer.byteLength(data) : (data?.byteLength ?? data?.length ?? 0));
const decrementKey = (map, key) => {
  const next = (map.get(key) || 1) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
  return next;
};
/** Closes a socket that may already be closing. */
export const safeClose = (conn, code, reason) => {
  try { conn.close(code, reason); } catch { /* already closing */ }
};

/** Closes the socket when its room session cookie expires. */
export function closeOnSessionExpiry(conn, expiresAt, now = Date.now()) {
  if (!expiresAt) return;
  const timer = setTimeout(() => safeClose(conn, POLICY_CLOSE_CODE, SESSION_EXPIRED_REASON), Math.max(MIN_TIMER_MS, expiresAt - now));
  timer.unref();
  conn.once('close', () => clearTimeout(timer));
}

/**
 * WebSocket admission and traffic accounting shared by every socket path of the relay:
 * connection counts (global, per IP, per room) and ingress, egress and sync-response
 * token buckets (per connection, per room, global).
 */
export class RelayWsTraffic {
  connectionsByRoom = new Map();
  #connectionsByIp = new Map();
  #connectionCount = 0;
  #config;
  #ingress;
  #egress;
  #sync;
  #maxEgressMessageBytes;
  #global;
  #rooms = new Map();
  #log;

  constructor(config, { log = console } = {}) {
    this.#config = config;
    this.#log = log;
    this.#ingress = {
      connection: limitsOf(config.RL_MAX_MSGS, config.RL_REFILL_MSGS_PER_SEC, config.RL_MAX_BYTES, config.RL_REFILL_BYTES_PER_SEC),
      room: limitsOf(config.ROOM_RL_MAX_MSGS, config.ROOM_RL_REFILL_MSGS_PER_SEC, config.ROOM_RL_MAX_BYTES, config.ROOM_RL_REFILL_BYTES_PER_SEC),
      global: limitsOf(config.GLOBAL_RL_MAX_MSGS, config.GLOBAL_RL_REFILL_MSGS_PER_SEC, config.GLOBAL_RL_MAX_BYTES, config.GLOBAL_RL_REFILL_BYTES_PER_SEC),
    };
    this.#egress = {
      connection: limitsOf(config.WS_EGRESS_CONNECTION_BURST_MESSAGES, config.WS_EGRESS_CONNECTION_MESSAGES_PER_SECOND,
        config.WS_EGRESS_CONNECTION_BURST_BYTES, config.WS_EGRESS_CONNECTION_BYTES_PER_SECOND),
      room: limitsOf(config.WS_EGRESS_ROOM_BURST_MESSAGES, config.WS_EGRESS_ROOM_MESSAGES_PER_SECOND,
        config.WS_EGRESS_ROOM_BURST_BYTES, config.WS_EGRESS_ROOM_BYTES_PER_SECOND),
      global: limitsOf(config.WS_EGRESS_GLOBAL_BURST_MESSAGES, config.WS_EGRESS_GLOBAL_MESSAGES_PER_SECOND,
        config.WS_EGRESS_GLOBAL_BURST_BYTES, config.WS_EGRESS_GLOBAL_BYTES_PER_SECOND),
    };
    this.#sync = syncResponseLimits(config);
    this.#maxEgressMessageBytes = config.MAX_DOCUMENT_BYTES + config.MAX_AWARENESS_ROOM_BYTES + EGRESS_MESSAGE_SLACK_BYTES;
    this.#global = { ingress: bucketFor(this.#ingress.global), egress: bucketFor(this.#egress.global), sync: bucketFor(this.#sync.global) };
  }

  /** Reserves one socket slot; `status` is 0 on success, else the HTTP status to refuse with. */
  reserve(ip, docName) {
    const { MAX_CONNECTIONS, MAX_CONNECTIONS_PER_IP, MAX_CONNECTIONS_PER_ROOM } = this.#config;
    if (this.#connectionCount >= MAX_CONNECTIONS) return { status: UNAVAILABLE_STATUS };
    if ((this.#connectionsByIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) return { status: TOO_MANY_STATUS };
    if ((this.connectionsByRoom.get(docName) || 0) >= MAX_CONNECTIONS_PER_ROOM) return { status: TOO_MANY_STATUS };
    this.#connectionCount += 1;
    this.#connectionsByIp.set(ip, (this.#connectionsByIp.get(ip) || 0) + 1);
    this.connectionsByRoom.set(docName, (this.connectionsByRoom.get(docName) || 0) + 1);
    let released = false;
    return {
      status: 0,
      release: () => {
        if (released) return;
        released = true;
        this.#connectionCount = Math.max(0, this.#connectionCount - 1);
        decrementKey(this.#connectionsByIp, ip);
        if (decrementKey(this.connectionsByRoom, docName) === 0) this.#rooms.delete(docName);
      },
    };
  }

  #room(docName) {
    let room = this.#rooms.get(docName);
    if (!room) {
      room = { ingress: bucketFor(this.#ingress.room), egress: bucketFor(this.#egress.room), sync: bucketFor(this.#sync.room) };
      this.#rooms.set(docName, room);
    }
    return room;
  }

  /**
   * Meters one socket. Replaces `conn.send` so every outbound message pays the egress budgets;
   * an over-budget send is dropped and the socket closed once.
   */
  attach(conn, docName) {
    const buckets = { ingress: bucketFor(this.#ingress.connection), egress: bucketFor(this.#egress.connection), sync: bucketFor(this.#sync.connection) };
    const originalSend = conn.send.bind(conn);
    let egressLimited = false;
    const admitEgress = (size) => {
      const admitted = Number.isSafeInteger(size) && size >= 0 && size <= this.#maxEgressMessageBytes && takeTrafficBudget([
        { bucket: buckets.egress, size, limits: this.#egress.connection },
        { bucket: this.#room(docName).egress, size, limits: this.#egress.room },
        { bucket: this.#global.egress, size, limits: this.#egress.global },
      ]);
      if (!admitted && !egressLimited) {
        egressLimited = true;
        this.#log.warn(EGRESS_LIMIT_LOG, { docName: roomLogId(docName), size });
        setImmediate(() => safeClose(conn, POLICY_CLOSE_CODE, EGRESS_LIMIT_REASON));
      }
      return admitted;
    };
    conn.send = (data, ...args) => (admitEgress(messageSize(data)) ? originalSend(data, ...args) : undefined);
    return {
      /** Same order as before extraction: connection, then global, then room. */
      admitIngress: (size) => takeTrafficTokens(buckets.ingress, size, this.#ingress.connection)
        && takeTrafficTokens(this.#global.ingress, size, this.#ingress.global)
        && takeTrafficTokens(this.#room(docName).ingress, size, this.#ingress.room),
      takeSyncResponse: (estimatedBytes) => {
        const charge = Math.max(this.#config.SYNC_RESPONSE_MIN_CHARGE_BYTES, estimatedBytes);
        return takeTrafficBudget([
          { bucket: buckets.sync, size: charge, limits: this.#sync.connection },
          { bucket: this.#room(docName).sync, size: charge, limits: this.#sync.room },
          { bucket: this.#global.sync, size: charge, limits: this.#sync.global },
        ]);
      },
      /** A replay burst pays as one message of its total size, like one sync response. */
      sendBatch: (messages) => {
        if (!admitEgress(messages.reduce((sum, data) => sum + messageSize(data), 0))) return false;
        for (const data of messages) originalSend(data);
        return true;
      },
    };
  }

  /** True when `bytes` more can be queued without crossing the slow-consumer limit (an empty buffer always can). */
  canBuffer(peer, bytes) {
    return peer.bufferedAmount === 0 || peer.bufferedAmount + bytes <= this.#config.MAX_WS_BUFFERED_BYTES;
  }

  closeSlowConsumers(peers) {
    for (const peer of peers) {
      if (peer.bufferedAmount > this.#config.MAX_WS_BUFFERED_BYTES) safeClose(peer, POLICY_CLOSE_CODE, SLOW_CONSUMER_REASON);
    }
  }
}
