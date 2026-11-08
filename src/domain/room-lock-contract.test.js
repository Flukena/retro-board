import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCK_KDF, LOCK_BYTES, ROOM_PASSWORD_MIN_LENGTH, parseLockParams, parseAuthKey, e2eAad,
  encodeBase64Url, decodeBase64Url,
} from './room-lock-contract.js';

const BLOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const b64 = (length, fill = 1) => encodeBase64Url(new Uint8Array(length).fill(fill));
const validLock = () => ({
  salt: b64(LOCK_BYTES.salt), kdf: { ...LOCK_KDF }, verifier: b64(LOCK_BYTES.verifier),
  wrappedDek: b64(LOCK_BYTES.wrappedDek), wrapIv: b64(LOCK_BYTES.wrapIv),
});

test('constants match the contract', () => {
  assert.deepEqual({ ...LOCK_KDF }, { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 });
  assert.deepEqual({ ...LOCK_BYTES }, { salt: 16, verifier: 32, wrappedDek: 48, wrapIv: 12, authKey: 32 });
  assert.equal(ROOM_PASSWORD_MIN_LENGTH, 10);
  assert.ok(Object.isFrozen(LOCK_KDF));
});

test('base64url round-trips every remainder length and avoids padding', () => {
  for (let length = 0; length < 8; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, i) => 250 - i * 37);
    const text = encodeBase64Url(bytes);
    assert.match(text, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual([...decodeBase64Url(text)], [...bytes]);
  }
  assert.equal(encodeBase64Url(Uint8Array.of(0xfb, 0xff)), '-_8');
});

test('a valid lock parses to a frozen object', () => {
  const lock = parseLockParams(validLock());
  assert.ok(Object.isFrozen(lock));
  assert.deepEqual(Object.keys(lock).sort(), ['kdf', 'salt', 'verifier', 'wrapIv', 'wrappedDek']);
});

test('invalid locks are rejected', () => {
  assert.equal(parseLockParams(null), null);
  assert.equal(parseLockParams('x'), null);
  assert.equal(parseLockParams([]), null);
  assert.equal(parseLockParams({ ...validLock(), extra: 'x' }), null);
  const { salt: _salt, ...missing } = validLock();
  assert.equal(parseLockParams(missing), null);
  assert.equal(parseLockParams({ ...validLock(), kdf: { ...LOCK_KDF, iterations: 1 } }), null);
  assert.equal(parseLockParams({ ...validLock(), kdf: { ...LOCK_KDF, extra: 1 } }), null);
  assert.equal(parseLockParams({ ...validLock(), salt: b64(LOCK_BYTES.salt - 1) }), null);
  assert.equal(parseLockParams({ ...validLock(), verifier: b64(LOCK_BYTES.verifier + 1) }), null);
  assert.equal(parseLockParams({ ...validLock(), wrapIv: `${b64(LOCK_BYTES.wrapIv - 1)}+` }), null);
  assert.equal(parseLockParams({ ...validLock(), salt: `${b64(LOCK_BYTES.salt)}=` }), null);
  assert.equal(parseLockParams({ ...validLock(), wrappedDek: 42 }), null);
});

test('parseAuthKey enforces base64url and exact length', () => {
  const key = b64(LOCK_BYTES.authKey);
  assert.equal(parseAuthKey(key), key);
  assert.equal(parseAuthKey(b64(LOCK_BYTES.authKey - 1)), null);
  assert.equal(parseAuthKey(`${key}=`), null);
  assert.equal(parseAuthKey(null), null);
});

test('AAD has exact bytes for snapshot and blob bindings', () => {
  const handle = 'A'.repeat(32);
  const aad = e2eAad(handle, 3, 'snapshot', 7);
  assert.deepEqual([...aad], [...new TextEncoder().encode(`retroroom/e2e/v1|${handle}|3|snapshot|7`)]);
  assert.equal(new TextDecoder().decode(e2eAad(handle, 3, 'blob', BLOB_ID)), `retroroom/e2e/v1|${handle}|3|blob|${BLOB_ID}`);
  assert.equal(new TextDecoder().decode(e2eAad(handle, 3, 'update')), `retroroom/e2e/v1|${handle}|3|update`);
});

test('AAD binding misuse throws', () => {
  const handle = 'A'.repeat(32);
  assert.throws(() => e2eAad(handle, 3, 'snapshot'));
  assert.throws(() => e2eAad(handle, 3, 'blob'));
  assert.throws(() => e2eAad(handle, 3, 'update', 5));
  assert.throws(() => e2eAad(handle, 3, 'bogus'));
});

test('AAD rejects ambiguous or malformed parts', () => {
  const handle = 'A'.repeat(32);
  assert.throws(() => e2eAad('a|b', 3, 'update'));
  assert.throws(() => e2eAad('', 3, 'update'));
  assert.throws(() => e2eAad(null, 3, 'update'));
  assert.throws(() => e2eAad('A'.repeat(65), 3, 'update'));
  for (const epoch of [-1, 1.5, NaN, '3', null]) assert.throws(() => e2eAad(handle, epoch, 'update'));
  for (const base of [-1, 1.5, '7', NaN]) assert.throws(() => e2eAad(handle, 3, 'snapshot', base));
  for (const id of ['img|1', 'img1', 7, null]) assert.throws(() => e2eAad(handle, 3, 'blob', id));
});

test('blob bindings accept only lowercase UUID v4', () => {
  const handle = 'A'.repeat(32);
  assert.ok(e2eAad(handle, 3, 'blob', '123e4567-e89b-42d3-b456-426614174000'));
  for (const id of [
    '123e4567-e89b-12d3-a456-426614174000', // version 1
    '00000000-0000-0000-0000-000000000000', // version 0
    '123e4567-e89b-42d3-c456-426614174000', // variant bits
    BLOB_ID.toUpperCase(),
  ]) assert.throws(() => e2eAad(handle, 3, 'blob', id), id);
});

test('decodeBase64Url is strict', () => {
  assert.deepEqual([...decodeBase64Url('AA')], [0]);
  assert.equal(decodeBase64Url('AB'), null);
  assert.equal(decodeBase64Url('AAAAA'), null);
  for (const value of [null, undefined, 42, {}, ['AA']]) assert.equal(decodeBase64Url(value), null);
  assert.equal(decodeBase64Url('AA=='), null);
});
