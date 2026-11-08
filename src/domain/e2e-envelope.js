export const E2E_FRAME = Object.freeze({
  APPEND: 1, SNAPSHOT: 2, EPHEMERAL: 3,
  UPDATE: 11, SNAPSHOT_OUT: 12, SYNCED: 13, ACK: 14, EPHEMERAL_OUT: 15, REJECT: 16, RESUMED: 17,
});
export const E2E_REJECT = Object.freeze({ QUOTA: 1, STALE_SNAPSHOT: 2, RATE: 3, MALFORMED: 4, FROZEN: 5 });
export const E2E_CIPHERTEXT_OVERHEAD_BYTES = 28;
export const E2E_EPHEMERAL_MAX_BYTES = 64 * 1024;

const TYPE_BYTES = 1;
const SEQ_BYTES = 8;
const REF_BYTES = 4;
const CODE_BYTES = 1;
const UINT32_RANGE = 2 ** 32;
const BYTE_RANGE = 256;

const writeUint = (view, offset, width, value) => {
  let rest = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    view[offset + i] = rest % BYTE_RANGE;
    rest = Math.floor(rest / BYTE_RANGE);
  }
};

const readUint = (bytes, offset, width) => {
  let value = 0;
  for (let i = 0; i < width; i += 1) value = value * BYTE_RANGE + bytes[offset + i];
  return value;
};

const REJECT_CODES = new Set(Object.values(E2E_REJECT));
const FIELD_SPECS = Object.freeze({
  seq: { width: SEQ_BYTES, valid: (v) => Number.isSafeInteger(v) && v >= 0 },
  // SNAPSHOT: the baseSeq of the latest snapshot the sender has applied (0 for none); the relay fences on it.
  knownBase: { width: SEQ_BYTES, valid: (v) => Number.isSafeInteger(v) && v >= 0 },
  clientRef: { width: REF_BYTES, valid: (v) => Number.isInteger(v) && v >= 0 && v < UINT32_RANGE },
  code: { width: CODE_BYTES, valid: (v) => REJECT_CODES.has(v) },
});

const CLIENT = 'client';
const SERVER = 'server';
/** One row per frame type: sender, ordered header fields, whether ciphertext follows. */
const LAYOUTS = Object.freeze({
  [E2E_FRAME.APPEND]: { side: CLIENT, fields: ['clientRef'], cipher: true },
  [E2E_FRAME.SNAPSHOT]: { side: CLIENT, fields: ['seq', 'knownBase'], cipher: true },
  [E2E_FRAME.EPHEMERAL]: { side: CLIENT, fields: [], cipher: true, ephemeral: true },
  [E2E_FRAME.UPDATE]: { side: SERVER, fields: ['seq'], cipher: true },
  [E2E_FRAME.SNAPSHOT_OUT]: { side: SERVER, fields: ['seq'], cipher: true },
  [E2E_FRAME.SYNCED]: { side: SERVER, fields: ['seq'], cipher: false },
  [E2E_FRAME.ACK]: { side: SERVER, fields: ['seq', 'clientRef'], cipher: false },
  [E2E_FRAME.EPHEMERAL_OUT]: { side: SERVER, fields: [], cipher: true, ephemeral: true },
  [E2E_FRAME.REJECT]: { side: SERVER, fields: ['code', 'clientRef'], cipher: false },
  [E2E_FRAME.RESUMED]: { side: SERVER, fields: [], cipher: false },
});

const headerBytes = (layout) => layout.fields.reduce((sum, name) => sum + FIELD_SPECS[name].width, TYPE_BYTES);

/** Bytes before the ciphertext in the widest frame; a transport limit adds this to its payload cap. */
export const E2E_MAX_FRAME_HEADER_BYTES = Math.max(...Object.values(LAYOUTS).map(headerBytes));
/** Bytes before the ciphertext in one frame type; a per-type cap adds this to its ciphertext limit. */
export const e2eFrameHeaderBytes = (type) => headerBytes(LAYOUTS[type]);

export function encodeFrame(type, values = {}) {
  const layout = LAYOUTS[type];
  if (!layout) throw new RangeError(`unknown frame type ${type}`);
  const tail = layout.cipher ? (values.ciphertext ?? new Uint8Array(0)) : new Uint8Array(0);
  const out = new Uint8Array(headerBytes(layout) + tail.length);
  out[0] = type;
  let offset = TYPE_BYTES;
  for (const name of layout.fields) {
    const { width, valid } = FIELD_SPECS[name];
    if (!valid(values[name])) throw new RangeError(`${name} out of range`);
    writeUint(out, offset, width, values[name]);
    offset += width;
  }
  out.set(tail, offset);
  return out;
}

const readFields = (layout, bytes) => {
  const fields = {};
  let offset = TYPE_BYTES;
  for (const name of layout.fields) {
    const { width, valid } = FIELD_SPECS[name];
    fields[name] = readUint(bytes, offset, width);
    if (!valid(fields[name])) return null;
    offset += width;
  }
  return fields;
};

function decodeFrame(bytes, side, { maxBytes, maxEphemeralBytes = E2E_EPHEMERAL_MAX_BYTES, maxFrameBytesByType = {} }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  if (!(bytes instanceof Uint8Array) || bytes.length < TYPE_BYTES || bytes.length > maxBytes) return null;
  const type = bytes[0];
  const layout = LAYOUTS[type];
  if (layout?.side !== side) return null;
  if (bytes.length > (maxFrameBytesByType[type] ?? maxBytes)) return null;
  const bodyStart = headerBytes(layout);
  if (bytes.length < bodyStart) return null;
  const fields = readFields(layout, bytes);
  const ciphertext = bytes.subarray(bodyStart);
  if (!fields || (layout.cipher ? ciphertext.length === 0 : ciphertext.length !== 0)) return null;
  if (layout.ephemeral && ciphertext.length > maxEphemeralBytes) return null;
  return { type, ...fields, ...(layout.cipher ? { ciphertext } : {}) };
}

export const decodeClientFrame = (bytes, limits) => decodeFrame(bytes, CLIENT, limits);

export const decodeServerFrame = (bytes, limits) => decodeFrame(bytes, SERVER, limits);
