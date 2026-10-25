import { createRequire } from 'node:module';

const decoding = createRequire(import.meta.url)('lib0/decoding');
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const MAX_CLIENT_ID = 0xffffffff;
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function protocolBytes(data) {
  if (data instanceof Uint8Array) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('non-binary WebSocket message');
}

function awarenessEntry(inner, seen, maxStateBytes) {
  const clientId = decoding.readVarUint(inner);
  const clock = decoding.readVarUint(inner);
  const encodedState = decoding.readVarUint8Array(inner);
  if (!Number.isSafeInteger(clientId) || clientId < 0 || clientId > MAX_CLIENT_ID
    || !Number.isSafeInteger(clock) || clock < 0 || encodedState.byteLength > maxStateBytes || seen.has(clientId)) {
    throw new Error('invalid awareness entry');
  }
  seen.add(clientId);
  const state = JSON.parse(strictUtf8Decoder.decode(encodedState));
  if (state !== null && (typeof state !== 'object' || Array.isArray(state))) throw new Error('invalid awareness state');
  return { clientId, clock, stateIsNull: state === null, stateBytes: encodedState.byteLength };
}

// Validate the entire envelope before upstream Yjs/Awareness mutates state.
export class RelayProtocol {
  #limits;

  constructor(limits) { this.#limits = Object.freeze({ ...limits }); }

  inspect(data) {
    const bytes = protocolBytes(data);
    if (bytes.byteLength === 0) throw new Error('empty protocol message');
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) return this.#sync(decoder);
    if (type === MESSAGE_AWARENESS) return this.#awareness(bytes, decoder);
    throw new Error('unknown protocol message');
  }

  #sync(decoder) {
    const type = decoding.readVarUint(decoder);
    if (type === SYNC_STEP_1) {
      const vector = decoding.readVarUint8Array(decoder);
      if (vector.byteLength > this.#limits.maxStateVectorBytes || decoding.hasContent(decoder)) throw new Error('invalid sync state vector');
      return { kind: 'sync-step-1' };
    }
    if (type === SYNC_STEP_2 || type === SYNC_UPDATE) {
      const update = decoding.readVarUint8Array(decoder);
      if (update.byteLength > this.#limits.maxUpdateBytes || decoding.hasContent(decoder)) throw new Error('invalid sync update');
      return { kind: 'sync-update', updateBytes: update.byteLength };
    }
    throw new Error('unknown sync message');
  }

  #awareness(bytes, decoder) {
    if (bytes.byteLength > this.#limits.maxAwarenessMessageBytes) throw new Error('awareness frame too large');
    const update = decoding.readVarUint8Array(decoder);
    if (decoding.hasContent(decoder)) throw new Error('invalid awareness envelope');
    const inner = decoding.createDecoder(update);
    const count = decoding.readVarUint(inner);
    // Standard clients echo the room-wide snapshot; identity ownership is checked separately.
    if (count < 1 || count > this.#limits.maxAwarenessClientsPerRoom) throw new Error('invalid awareness entry count');
    const entries = [];
    const seen = new Set();
    for (let index = 0; index < count; index += 1) entries.push(awarenessEntry(inner, seen, this.#limits.maxAwarenessStateBytes));
    if (decoding.hasContent(inner)) throw new Error('invalid awareness payload');
    return { kind: 'awareness', entries };
  }
}
