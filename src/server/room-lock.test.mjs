import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCK_BYTES, LOCK_KDF } from '../domain/room-lock-contract.js';
import { RIGHT_KEY, START_MS, WRONG_KEY, b64, lockRecord } from './room-lock-fixtures.mjs';
import { decodeLockRecord, encodeLockRecord, RoomLockVerifier, WRONG_PASSWORD_WINDOW_MS } from './room-lock.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DOC = 'yjs/board-Example1-abcdefgh12345678';
const OTHER_DOC = 'yjs/board-Example2-abcdefgh12345678';
const IP = '203.0.113.7';
const ROOM_WIDE_LIMIT = 50;
const PER_IP_LIMIT = 5;
const clockFixture = (options = {}) => {
  const clock = { now: START_MS };
  const verifier = new RoomLockVerifier({ now: () => clock.now, ...options });
  return { clock, verifier, record: decodeLockRecord(lockRecord()) };
};

test('lock record codec round-trips and rejects everything that is not exactly a v1 record', () => {
  const record = decodeLockRecord(lockRecord());
  assert.deepEqual(decodeLockRecord(encodeLockRecord(record)), record);
  const bad = [
    null, [], 'x', { ...lockRecord(), extra: 1 }, lockRecord({ v: 2 }), lockRecord({ keyEpoch: -1 }),
    lockRecord({ keyEpoch: 1.5 }), lockRecord({ lockRevision: Number.MAX_SAFE_INTEGER + 1 }),
    lockRecord({ createdAt: '1' }), lockRecord({ ownerAccountId: '' }), lockRecord({ ownerAccountId: 'a/b' }),
    lockRecord({ salt: b64(LOCK_BYTES.salt - 1, 1) }), lockRecord({ kdf: { ...LOCK_KDF, iterations: 1 } }),
  ];
  for (const value of bad) assert.equal(decodeLockRecord(value), null, JSON.stringify(value)?.slice(0, 60));
  const { lockRevision, ...missing } = lockRecord();
  assert.equal(lockRevision, 0);
  assert.equal(decodeLockRecord(missing), null);
  assert.throws(() => encodeLockRecord({ ...lockRecord(), v: 2 }), TypeError);
});

test('verifier answers ok and wrong, and refuses a missing record', () => {
  const { verifier, record } = clockFixture();
  assert.equal(verifier.check(IP, DOC, record, RIGHT_KEY), 'ok');
  assert.equal(verifier.check(IP, DOC, record, WRONG_KEY), 'wrong');
  assert.equal(verifier.check(IP, DOC, record, 'not base64!'), 'wrong');
  assert.equal(verifier.check(IP, DOC, record, undefined), 'wrong');
  assert.throws(() => verifier.check(IP, DOC, null, RIGHT_KEY));
});

test('the 6th failure inside the window is limited and even the right key is refused', () => {
  const { clock, verifier, record } = clockFixture();
  for (let i = 0; i < PER_IP_LIMIT; i += 1) {
    assert.equal(verifier.check(IP, DOC, record, WRONG_KEY), 'wrong');
    clock.now += SECOND_MS;
  }
  clock.now = START_MS + WRONG_PASSWORD_WINDOW_MS - SECOND_MS;
  assert.deepEqual(verifier.check(IP, DOC, record, WRONG_KEY), { limited: 1 });
  assert.deepEqual(verifier.check(IP, DOC, record, RIGHT_KEY), { limited: 1 });
});

test('one attempt is allowed again exactly 15 minutes after the oldest failure, and retry-after is exact', () => {
  const { clock, verifier, record } = clockFixture();
  for (let i = 0; i < PER_IP_LIMIT; i += 1) {
    verifier.check(IP, DOC, record, WRONG_KEY);
    clock.now += 100;
  }
  clock.now = START_MS + 10 * MINUTE_MS;
  assert.deepEqual(verifier.check(IP, DOC, record, RIGHT_KEY), { limited: 5 * 60 });
  clock.now = START_MS + 10 * MINUTE_MS + 1;
  assert.deepEqual(verifier.check(IP, DOC, record, RIGHT_KEY), { limited: 5 * 60 });
  clock.now = START_MS + WRONG_PASSWORD_WINDOW_MS - 1;
  assert.deepEqual(verifier.check(IP, DOC, record, RIGHT_KEY), { limited: 1 });
  clock.now = START_MS + WRONG_PASSWORD_WINDOW_MS;
  assert.equal(verifier.check(IP, DOC, record, RIGHT_KEY), 'ok');
});

test('another IP is still allowed until the room-wide 50 failures, and other rooms are unaffected', () => {
  const { verifier, record } = clockFixture();
  for (let i = 0; i < PER_IP_LIMIT + 1; i += 1) verifier.check(IP, DOC, record, WRONG_KEY);
  assert.equal(verifier.check('203.0.113.8', DOC, record, RIGHT_KEY), 'ok');
  assert.equal(verifier.check(IP, OTHER_DOC, record, RIGHT_KEY), 'ok');
  const fresh = clockFixture();
  for (let i = 0; i < ROOM_WIDE_LIMIT; i += 1) {
    assert.equal(fresh.verifier.check(`198.51.100.${i}`, DOC, fresh.record, WRONG_KEY), 'wrong', `failure ${i}`);
  }
  assert.deepEqual(fresh.verifier.check('192.0.2.1', DOC, fresh.record, RIGHT_KEY), { limited: WRONG_PASSWORD_WINDOW_MS / SECOND_MS });
  assert.equal(fresh.verifier.check('192.0.2.1', OTHER_DOC, fresh.record, RIGHT_KEY), 'ok');
});

test('a full map refuses new keys, keeps tracked allowances, and the sweep frees expired keys', () => {
  const { clock, verifier, record } = clockFixture({ maxKeys: 2 });
  verifier.check('10.0.0.1', DOC, record, WRONG_KEY);
  clock.now += SECOND_MS;
  verifier.check('10.0.0.2', DOC, record, WRONG_KEY);
  assert.deepEqual(verifier.check('10.0.0.3', DOC, record, RIGHT_KEY), { limited: WRONG_PASSWORD_WINDOW_MS / SECOND_MS });
  // Tracked keys keep their allowance: 4 more failures for 10.0.0.1 are still counted, not reset.
  for (let i = 0; i < PER_IP_LIMIT - 1; i += 1) assert.equal(verifier.check('10.0.0.1', DOC, record, WRONG_KEY), 'wrong');
  assert.equal(typeof verifier.check('10.0.0.1', DOC, record, RIGHT_KEY), 'object');
  clock.now = START_MS + WRONG_PASSWORD_WINDOW_MS + SECOND_MS;
  verifier.sweep();
  assert.equal(verifier.check('10.0.0.3', DOC, record, RIGHT_KEY), 'ok');
});
