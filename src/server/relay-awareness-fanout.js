import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const MESSAGE_AWARENESS = 1;
const SOCKET_OPEN = 1;
const FANOUT_WINDOW_MS = 50;
const MAX_PENDING_CALLBACKS = 65_536;
const MAX_PENDING_IDENTITIES = 1024;
const FRAME_OVERHEAD_BYTES = 16;
const batches = new WeakMap();

function decodeEntries(frame) {
  const outer = decoding.createDecoder(frame);
  decoding.readVarUint(outer);
  const inner = decoding.createDecoder(decoding.readVarUint8Array(outer));
  const count = decoding.readVarUint(inner);
  const entries = [];
  for (let index = 0; index < count; index++) entries.push({
    id: decoding.readVarUint(inner), clock: decoding.readVarUint(inner), state: decoding.readVarString(inner),
  });
  return entries;
}

function encodeEntry(entry) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entry.id);
  encoding.writeVarUint(encoder, entry.clock);
  encoding.writeVarString(encoder, entry.state);
  return encoding.toUint8Array(encoder);
}

function encodeFrame(entries) {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  entries.forEach(entry => encoding.writeUint8Array(inner, entry));
  const outer = encoding.createEncoder();
  encoding.writeVarUint(outer, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
  return encoding.toUint8Array(outer);
}

function framesFor(entries, maxBytes) {
  const frames = [];
  let group = [];
  let bytes = FRAME_OVERHEAD_BYTES;
  for (const value of entries) {
    const entry = encodeEntry(value);
    if (group.length && bytes + entry.byteLength > maxBytes) {
      frames.push(encodeFrame(group)); group = []; bytes = FRAME_OVERHEAD_BYTES;
    }
    group.push(entry); bytes += entry.byteLength;
  }
  if (group.length) frames.push(encodeFrame(group));
  return frames;
}

function sendBatch(peer, frames) {
  let remaining = frames.length;
  let failure;
  const complete = error => {
    failure ||= error;
    if (--remaining === 0) peer.callbacks.forEach(callback => callback(failure));
  };
  if (peer.connection.readyState !== SOCKET_OPEN) {
    const error = new Error('awareness socket closed before flush');
    peer.callbacks.forEach(callback => callback(error));
    return;
  }
  frames.forEach(frame => peer.send(frame, complete));
}

class AwarenessFanout {
  #maxBytes;
  #entries = new Map();
  #peers = new Map();
  #cache = new WeakMap();
  #generation = 0;
  #callbackCount = 0;
  #timer;
  #closed = false;

  constructor(maxBytes) { this.#maxBytes = maxBytes; }

  enqueue(connection, send, frame, callback) {
    if (this.#closed || !(frame instanceof Uint8Array) || frame[0] !== MESSAGE_AWARENESS || frame.byteLength > this.#maxBytes) return false;
    if (this.#callbackCount >= MAX_PENDING_CALLBACKS) this.flush();
    let cached = this.#cache.get(frame);
    if (!cached) {
      const entries = decodeEntries(frame);
      // Initial rosters and bulk removals already share one frame. Keep their
      // exact recipients instead of expanding a targeted snapshot room-wide.
      if (entries.length !== 1) return false;
      cached = { entries, generation: -1 }; this.#cache.set(frame, cached);
    }
    if (cached.generation !== this.#generation) this.#merge(cached);
    let peer = this.#peers.get(connection);
    if (!peer) { peer = { connection, send, callbacks: [] }; this.#peers.set(connection, peer); }
    if (typeof callback === 'function') { peer.callbacks.push(callback); this.#callbackCount++; }
    this.#timer ||= setTimeout(() => this.flush(), FANOUT_WINDOW_MS);
    return true;
  }

  #merge(cached) {
    if (this.#entries.size + cached.entries.length > MAX_PENDING_IDENTITIES) this.flush();
    for (const entry of cached.entries) {
      const previous = this.#entries.get(entry.id);
      if (!previous || entry.clock > previous.clock || (entry.clock === previous.clock && entry.state === 'null')) this.#entries.set(entry.id, entry);
    }
    cached.generation = this.#generation;
  }

  flush() {
    clearTimeout(this.#timer); this.#timer = undefined;
    const frames = framesFor(this.#entries.values(), this.#maxBytes);
    const peers = this.#peers;
    this.#entries = new Map(); this.#peers = new Map(); this.#callbackCount = 0; this.#generation++;
    if (frames.length) peers.forEach(peer => sendBatch(peer, frames));
  }

  close() { this.#closed = true; this.flush(); }
}

// Capture the already rate-limited send method. Sync/document frames remain
// immediate; only trusted upstream awareness frames share this room-wide window.
export function coalesceAwarenessSends(connection, doc, maxFrameBytes) {
  let batch = batches.get(doc);
  if (!batch) {
    batch = new AwarenessFanout(maxFrameBytes);
    batches.set(doc, batch);
    doc.on('destroy', () => batch.close());
  }
  const send = connection.send.bind(connection);
  connection.send = (data, ...args) => {
    if (!batch.enqueue(connection, send, data, args[0])) return send(data, ...args);
    return undefined;
  };
}
