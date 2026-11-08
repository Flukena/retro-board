export const E2E_FRAME = Object.freeze({
  APPEND: 1, SNAPSHOT: 2, EPHEMERAL: 3,
  UPDATE: 11, SNAPSHOT_OUT: 12, SYNCED: 13, ACK: 14, EPHEMERAL_OUT: 15, REJECT: 16,
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

const CLIENT_TYPES = new Set([E2E_FRAME.APPEND, E2E_FRAME.SNAPSHOT, E2E_FRAME.EPHEMERAL]);
const SERVER_TYPES = new Set([E2E_FRAME.UPDATE, E2E_FRAME.SNAPSHOT_OUT, E2E_FRAME.SYNCED,
  E2E_FRAME.ACK, E2E_FRAME.EPHEMERAL_OUT, E2E_FRAME.REJECT]);
const SEQ_TYPES = new Set([E2E_FRAME.SNAPSHOT, E2E_FRAME.UPDATE, E2E_FRAME.SNAPSHOT_OUT, E2E_FRAME.SYNCED]);
const EPHEMERAL_TYPES = new Set([E2E_FRAME.EPHEMERAL, E2E_FRAME.EPHEMERAL_OUT]);

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

const assertSeq = (seq) => {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError('seq out of range');
};

const assertRef = (clientRef) => {
  if (!Number.isInteger(clientRef) || clientRef < 0 || clientRef >= UINT32_RANGE) throw new RangeError('clientRef out of range');
};

/** Layout parts: [{ width, value }] followed by an optional trailing ciphertext. */
const layoutFor = (type, { seq, ciphertext, code, clientRef }) => {
  if (type === E2E_FRAME.APPEND) { assertRef(clientRef); return [[REF_BYTES, clientRef]]; }
  if (SEQ_TYPES.has(type)) { assertSeq(seq); return [[SEQ_BYTES, seq]]; }
  if (type === E2E_FRAME.ACK) { assertSeq(seq); assertRef(clientRef); return [[SEQ_BYTES, seq], [REF_BYTES, clientRef]]; }
  if (type === E2E_FRAME.REJECT) { assertRef(clientRef); return [[CODE_BYTES, code], [REF_BYTES, clientRef]]; }
  if (EPHEMERAL_TYPES.has(type)) return [];
  throw new RangeError(`unknown frame type ${type}`);
};

export function encodeFrame(type, fields = {}) {
  const parts = layoutFor(type, fields);
  const tail = fields.ciphertext ?? new Uint8Array(0);
  const headerBytes = parts.reduce((sum, [width]) => sum + width, TYPE_BYTES);
  const out = new Uint8Array(headerBytes + tail.length);
  out[0] = type;
  let offset = TYPE_BYTES;
  for (const [width, value] of parts) { writeUint(out, offset, width, value); offset += width; }
  out.set(tail, offset);
  return out;
}

const headerBytesFor = (type) => {
  if (type === E2E_FRAME.APPEND) return REF_BYTES;
  if (SEQ_TYPES.has(type)) return SEQ_BYTES;
  if (type === E2E_FRAME.ACK) return SEQ_BYTES + REF_BYTES;
  if (type === E2E_FRAME.REJECT) return CODE_BYTES + REF_BYTES;
  return 0;
};

const readFields = (type, bytes) => {
  const at = TYPE_BYTES;
  if (type === E2E_FRAME.APPEND) return { clientRef: readUint(bytes, at, REF_BYTES) };
  if (SEQ_TYPES.has(type)) return { seq: readUint(bytes, at, SEQ_BYTES) };
  if (type === E2E_FRAME.ACK) return { seq: readUint(bytes, at, SEQ_BYTES), clientRef: readUint(bytes, at + SEQ_BYTES, REF_BYTES) };
  if (type === E2E_FRAME.REJECT) return { code: bytes[at], clientRef: readUint(bytes, at + CODE_BYTES, REF_BYTES) };
  return {};
};

const needsCiphertext = (type) => type !== E2E_FRAME.SYNCED && type !== E2E_FRAME.ACK && type !== E2E_FRAME.REJECT;

function decodeFrame(bytes, allowed, maxBytes, maxEphemeralBytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < TYPE_BYTES || bytes.length > maxBytes) return null;
  const type = bytes[0];
  if (!allowed.has(type)) return null;
  const bodyStart = TYPE_BYTES + headerBytesFor(type);
  if (bytes.length < bodyStart) return null;
  const fields = readFields(type, bytes);
  if (fields.seq > Number.MAX_SAFE_INTEGER) return null;
  const ciphertext = bytes.subarray(bodyStart);
  if (needsCiphertext(type) ? ciphertext.length === 0 : ciphertext.length !== 0) return null;
  if (EPHEMERAL_TYPES.has(type) && ciphertext.length > maxEphemeralBytes) return null;
  return { type, ...fields, ...(needsCiphertext(type) ? { ciphertext } : {}) };
}

export const decodeClientFrame = (bytes, { maxBytes, maxEphemeralBytes = E2E_EPHEMERAL_MAX_BYTES }) =>
  decodeFrame(bytes, CLIENT_TYPES, maxBytes, maxEphemeralBytes);

export const decodeServerFrame = (bytes, { maxBytes, maxEphemeralBytes = E2E_EPHEMERAL_MAX_BYTES }) =>
  decodeFrame(bytes, SERVER_TYPES, maxBytes, maxEphemeralBytes);
