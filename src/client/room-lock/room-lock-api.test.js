import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCK_ACTION_ERROR, encodeCommitBody, lockActionErrorForStatus } from './room-lock-api.js';

const HEADER_LENGTH_BYTES = 4;

test('a commit body is a big-endian u32 header length, the UTF-8 JSON header, then the snapshot bytes', () => {
  const header = { rotationId: 'r', keepBlobs: ['ü'] };
  const snapshot = Uint8Array.from([9, 8, 7]);
  const body = encodeCommitBody(header, snapshot);
  const length = new DataView(body.buffer, body.byteOffset).getUint32(0, false);
  const json = new TextDecoder().decode(body.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + length));
  assert.deepEqual(JSON.parse(json), header);
  assert.deepEqual([...body.subarray(HEADER_LENGTH_BYTES + length)], [9, 8, 7]);
  assert.equal(body.length, HEADER_LENGTH_BYTES + length + snapshot.length);
  assert.equal(length, Buffer.byteLength(JSON.stringify(header)), 'the length counts bytes, not characters');
});

test('lock statuses map to what the dialogs show; room storage limits (413 and 507) are both "storage full"', () => {
  const cases = [
    [403, LOCK_ACTION_ERROR.WRONG_PASSWORD], [429, LOCK_ACTION_ERROR.LOCKED_OUT], [409, LOCK_ACTION_ERROR.CONFLICT],
    [413, LOCK_ACTION_ERROR.STORAGE_FULL], [507, LOCK_ACTION_ERROR.STORAGE_FULL], [503, LOCK_ACTION_ERROR.UNAVAILABLE],
    [401, LOCK_ACTION_ERROR.UNAVAILABLE],
  ];
  for (const [status, kind] of cases) assert.equal(lockActionErrorForStatus(status).kind, kind, String(status));
  assert.equal(lockActionErrorForStatus(429, 12).retryAfterSeconds, 12);
});
