import test from 'node:test';
import assert from 'node:assert/strict';
import {
  E2E_FRAME, E2E_REJECT, E2E_CIPHERTEXT_OVERHEAD_BYTES, E2E_EPHEMERAL_MAX_BYTES, E2E_MAX_FRAME_HEADER_BYTES,
  encodeFrame, decodeClientFrame, decodeServerFrame, e2eFrameHeaderBytes,
} from './e2e-envelope.js';

const MAX_BYTES = 1024;
const CIPHER = Uint8Array.from([9, 8, 7]);
const SEQ = 0x1_0000_0005;
const CLIENT_REF = 0xdeadbeef;
const limits = { maxBytes: MAX_BYTES, maxEphemeralBytes: E2E_EPHEMERAL_MAX_BYTES };

test('frame constants match the wire contract', () => {
  assert.deepEqual({ ...E2E_FRAME }, { APPEND: 1, SNAPSHOT: 2, EPHEMERAL: 3, UPDATE: 11, SNAPSHOT_OUT: 12, SYNCED: 13, ACK: 14, EPHEMERAL_OUT: 15, REJECT: 16, RESUMED: 17 });
  assert.deepEqual({ ...E2E_REJECT }, { QUOTA: 1, STALE_SNAPSHOT: 2, RATE: 3, MALFORMED: 4, FROZEN: 5 });
  assert.equal(E2E_CIPHERTEXT_OVERHEAD_BYTES, 28);
});

test('APPEND has exact bytes and round-trips', () => {
  const bytes = encodeFrame(E2E_FRAME.APPEND, { clientRef: CLIENT_REF, ciphertext: CIPHER });
  assert.deepEqual([...bytes], [1, 0xde, 0xad, 0xbe, 0xef, 9, 8, 7]);
  const frame = decodeClientFrame(bytes, limits);
  assert.equal(frame.type, E2E_FRAME.APPEND);
  assert.equal(frame.clientRef, CLIENT_REF);
  assert.deepEqual([...frame.ciphertext], [9, 8, 7]);
});

test('seq-bearing frames have exact bytes and round-trip', () => {
  const KNOWN_BASE = 3;
  const bytes = encodeFrame(E2E_FRAME.SNAPSHOT, { seq: SEQ, knownBase: KNOWN_BASE, ciphertext: CIPHER });
  assert.deepEqual([...bytes], [2, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 3, 9, 8, 7]);
  const client = decodeClientFrame(bytes, limits);
  assert.equal(client.seq, SEQ);
  assert.equal(client.knownBase, KNOWN_BASE);
  assert.throws(() => encodeFrame(E2E_FRAME.SNAPSHOT, { seq: SEQ, ciphertext: CIPHER }), RangeError, 'knownBase is required');
  for (const type of [E2E_FRAME.UPDATE, E2E_FRAME.SNAPSHOT_OUT]) {
    const frame = decodeServerFrame(encodeFrame(type, { seq: SEQ, ciphertext: CIPHER }), limits);
    assert.equal(frame.type, type);
    assert.equal(frame.seq, SEQ);
    assert.deepEqual([...frame.ciphertext], [9, 8, 7]);
  }
});

test('SYNCED, ACK and REJECT round-trip', () => {
  const synced = decodeServerFrame(encodeFrame(E2E_FRAME.SYNCED, { seq: SEQ }), limits);
  assert.deepEqual({ type: synced.type, seq: synced.seq }, { type: 13, seq: SEQ });
  const ack = encodeFrame(E2E_FRAME.ACK, { seq: SEQ, clientRef: CLIENT_REF });
  assert.equal(ack.length, 13);
  const ackFrame = decodeServerFrame(ack, limits);
  assert.deepEqual({ seq: ackFrame.seq, clientRef: ackFrame.clientRef }, { seq: SEQ, clientRef: CLIENT_REF });
  const reject = encodeFrame(E2E_FRAME.REJECT, { code: E2E_REJECT.QUOTA, clientRef: 7 });
  assert.deepEqual([...reject], [16, 1, 0, 0, 0, 7]);
  const rejectFrame = decodeServerFrame(reject, limits);
  assert.deepEqual({ code: rejectFrame.code, clientRef: rejectFrame.clientRef }, { code: 1, clientRef: 7 });
});

test('ephemeral frames carry ciphertext only', () => {
  const out = decodeServerFrame(encodeFrame(E2E_FRAME.EPHEMERAL_OUT, { ciphertext: CIPHER }), limits);
  assert.deepEqual([...out.ciphertext], [9, 8, 7]);
  const inbound = decodeClientFrame(encodeFrame(E2E_FRAME.EPHEMERAL, { ciphertext: CIPHER }), limits);
  assert.deepEqual([...inbound.ciphertext], [9, 8, 7]);
});

test('clients cannot send server types and servers cannot send client types', () => {
  assert.equal(decodeClientFrame(encodeFrame(E2E_FRAME.UPDATE, { seq: 1, ciphertext: CIPHER }), limits), null);
  assert.equal(decodeServerFrame(encodeFrame(E2E_FRAME.APPEND, { clientRef: 1, ciphertext: CIPHER }), limits), null);
});

test('unknown types, short frames and empty ciphertext are rejected', () => {
  for (const type of [0, 4, 99]) assert.equal(decodeClientFrame(Uint8Array.of(type, 1, 2, 3, 4, 5, 6, 7, 8, 9), limits), null);
  assert.equal(decodeClientFrame(new Uint8Array(0), limits), null);
  assert.equal(decodeClientFrame(Uint8Array.of(1, 0, 0, 0), limits), null);
  assert.equal(decodeClientFrame(Uint8Array.of(1, 0, 0, 0, 1), limits), null);
  assert.equal(decodeClientFrame(Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0, 1), limits), null);
  assert.equal(decodeClientFrame(Uint8Array.of(3), limits), null);
  assert.equal(decodeServerFrame(Uint8Array.of(14, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0), limits), null);
  assert.equal(decodeServerFrame(Uint8Array.of(16, 1, 0, 0, 0), limits), null);
  assert.equal(decodeServerFrame(Uint8Array.of(13, 0, 0, 0), limits), null);
});

test('size limits are enforced exactly', () => {
  const header = 1 + 4;
  const fits = encodeFrame(E2E_FRAME.APPEND, { clientRef: 1, ciphertext: new Uint8Array(MAX_BYTES - header) });
  assert.equal(fits.length, MAX_BYTES);
  assert.notEqual(decodeClientFrame(fits, limits), null);
  const over = encodeFrame(E2E_FRAME.APPEND, { clientRef: 1, ciphertext: new Uint8Array(MAX_BYTES - header + 1) });
  assert.equal(decodeClientFrame(over, limits), null);
  const bigLimits = { maxBytes: 1 << 20, maxEphemeralBytes: E2E_EPHEMERAL_MAX_BYTES };
  const eph = (n) => encodeFrame(E2E_FRAME.EPHEMERAL, { ciphertext: new Uint8Array(n) });
  assert.notEqual(decodeClientFrame(eph(E2E_EPHEMERAL_MAX_BYTES), bigLimits), null);
  assert.equal(decodeClientFrame(eph(E2E_EPHEMERAL_MAX_BYTES + 1), bigLimits), null);
});

test('seq above 2^53-1 is rejected on decode and encode', () => {
  const tooBig = Uint8Array.of(12, 0, 0x20, 0, 0, 0, 0, 0, 0, 5);
  assert.equal(decodeServerFrame(tooBig, limits), null);
  const max = Uint8Array.of(12, 0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 5);
  assert.equal(decodeServerFrame(max, limits).seq, Number.MAX_SAFE_INTEGER);
  assert.throws(() => encodeFrame(E2E_FRAME.SNAPSHOT, { seq: 2 ** 53, knownBase: 0, ciphertext: CIPHER }));
});

test('RESUMED is a bare type byte accepted only from the server', () => {
  const bytes = encodeFrame(E2E_FRAME.RESUMED);
  assert.deepEqual([...bytes], [17]);
  assert.deepEqual({ ...decodeServerFrame(bytes, limits) }, { type: 17 });
  assert.equal(decodeServerFrame(Uint8Array.of(17, 1), limits), null);
  assert.equal(decodeClientFrame(bytes, limits), null);
});

test('trailing bytes on payload-free frames are rejected', () => {
  const frames = [
    encodeFrame(E2E_FRAME.SYNCED, { seq: 1 }),
    encodeFrame(E2E_FRAME.ACK, { seq: 1, clientRef: 2 }),
    encodeFrame(E2E_FRAME.REJECT, { code: E2E_REJECT.RATE, clientRef: 2 }),
    encodeFrame(E2E_FRAME.RESUMED),
  ];
  for (const frame of frames) {
    assert.notEqual(decodeServerFrame(frame, limits), null);
    assert.equal(decodeServerFrame(Uint8Array.of(...frame, 0), limits), null);
  }
});

test('server frame maxBytes boundary is exact', () => {
  const header = 1 + 8;
  const at = encodeFrame(E2E_FRAME.UPDATE, { seq: 1, ciphertext: new Uint8Array(MAX_BYTES - header) });
  const over = encodeFrame(E2E_FRAME.UPDATE, { seq: 1, ciphertext: new Uint8Array(MAX_BYTES - header + 1) });
  assert.notEqual(decodeServerFrame(at, limits), null);
  assert.equal(decodeServerFrame(over, limits), null);
});

test('decoders throw when maxBytes is not a positive safe integer', () => {
  const frame = encodeFrame(E2E_FRAME.RESUMED);
  for (const maxBytes of [undefined, 0, -1, 1.5, NaN, Infinity, '10']) {
    assert.throws(() => decodeServerFrame(frame, { maxBytes }), TypeError);
    assert.throws(() => decodeClientFrame(frame, { maxBytes }), TypeError);
  }
});

test('REJECT codes are validated on encode and decode', () => {
  for (const code of [undefined, 0, 6, 255]) {
    assert.throws(() => encodeFrame(E2E_FRAME.REJECT, { code, clientRef: 1 }), RangeError);
  }
  assert.equal(decodeServerFrame(Uint8Array.of(16, 9, 0, 0, 0, 1), limits), null);
  assert.equal(decodeServerFrame(Uint8Array.of(16, 0, 0, 0, 0, 1), limits), null);
});

test('a per-type frame cap bounds that type only, inclusive, below the overall maxBytes', () => {
  const APPEND_CAP = 32;
  const capped = { ...limits, maxFrameBytesByType: { [E2E_FRAME.APPEND]: APPEND_CAP } };
  const append = (frameBytes) => encodeFrame(E2E_FRAME.APPEND, { clientRef: 1, ciphertext: new Uint8Array(frameBytes - 5).fill(1) });
  assert.equal(decodeClientFrame(append(APPEND_CAP), capped)?.type, E2E_FRAME.APPEND);
  assert.equal(decodeClientFrame(append(APPEND_CAP + 1), capped), null);
  const snapshot = encodeFrame(E2E_FRAME.SNAPSHOT, { seq: 1, knownBase: 0, ciphertext: new Uint8Array(APPEND_CAP * 2).fill(1) });
  assert.equal(decodeClientFrame(snapshot, capped)?.type, E2E_FRAME.SNAPSHOT, 'other types keep the overall limit');
});

test('the largest header is the SNAPSHOT: type + baseSeq + knownBase', () => {
  assert.equal(E2E_MAX_FRAME_HEADER_BYTES, 1 + 8 + 8);
});

test('a frame type header is the bytes an encoded frame adds before its ciphertext', () => {
  const ciphertext = new Uint8Array(5);
  assert.equal(e2eFrameHeaderBytes(E2E_FRAME.SNAPSHOT), 1 + 8 + 8);
  assert.equal(encodeFrame(E2E_FRAME.SNAPSHOT, { seq: 1, knownBase: 0, ciphertext }).length - ciphertext.length, e2eFrameHeaderBytes(E2E_FRAME.SNAPSHOT));
  assert.equal(e2eFrameHeaderBytes(E2E_FRAME.APPEND), 1 + 4);
});
