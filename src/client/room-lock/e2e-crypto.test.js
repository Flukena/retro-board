import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { LOCK_BYTES, LOCK_KDF, decodeBase64Url, encodeBase64Url, e2eAad, parseAuthKey, parseLockParams } from '../../domain/room-lock-contract.js';
import {
  RoomKeyError, createNextRoomKey, createRoomLock, decryptFrame, deriveRoomSecrets, encryptFrame, rewrapRoomLock, unwrapRoomKey,
} from './e2e-crypto.js';

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'another long passphrase';
const WRONG_PASSWORD = 'wrong horse battery!';
const PLAINTEXT = new TextEncoder().encode('sticky note');
const AAD = e2eAad('room_1', 1, 'update');
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const EMOJI_BELOW_MIN_COUNT = 9;
const SHA256_ALGORITHM = 'SHA-256';
const LITERAL_ITERATIONS = 600000;
const MASTER_BITS = 256;
const AUTH_BITS = 256;
const utf8 = (text) => new TextEncoder().encode(text);
const { subtle } = globalThis.crypto;

// Independent re-derivation using only literals from the spec.
async function referenceSecrets(password, saltB64) {
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: LITERAL_ITERATIONS, salt: decodeBase64Url(saltB64) }, base, MASTER_BITS);
  const hkdf = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) });
  const auth = new Uint8Array(await subtle.deriveBits(params('retroroom/auth/v1'), hkdf, AUTH_BITS));
  const kek = await subtle.deriveKey(params('retroroom/kek/v1'), hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { authKey: encodeBase64Url(auth), kek };
}

const sha256Base64Url = async (bytes) => encodeBase64Url(new Uint8Array(await globalThis.crypto.subtle.digest(SHA256_ALGORITHM, bytes)));
const flipBit = (bytes, index) => { const copy = Uint8Array.from(bytes); copy[index] ^= 1; return copy; };
const rejectsWith = (promise, code) => assert.rejects(promise, (e) => e instanceof RoomKeyError && e.code === code);

describe('e2e-crypto', () => {
  let created;
  let ciphertext;
  let rewrapped;
  let reference;

  before(async () => {
    created = await createRoomLock(PASSWORD);
    ciphertext = await encryptFrame(created.dek, AAD, PLAINTEXT);
    reference = await referenceSecrets(PASSWORD, created.lock.salt);
    rewrapped = await rewrapRoomLock({ currentPassword: PASSWORD, lock: created.lock, newPassword: NEW_PASSWORD });
  });

  it('creates a lock that satisfies the contract', () => {
    assert.ok(parseLockParams(created.lock));
    assert.ok(parseAuthKey(created.authKey));
    assert.equal(decodeBase64Url(created.lock.wrappedDek).length, LOCK_BYTES.wrappedDek);
    assert.deepEqual(created.lock.kdf, LOCK_KDF);
  });

  it('verifier equals SHA-256 of the auth key bytes', async () => {
    assert.equal(created.lock.verifier, await sha256Base64Url(decodeBase64Url(created.authKey)));
  });

  it('round-trips a frame and unwraps the DEK from the password', async () => {
    const { kek, authKey } = await deriveRoomSecrets(PASSWORD, created.lock.salt, created.lock.kdf);
    assert.equal(authKey, created.authKey);
    const dek = await unwrapRoomKey(kek, created.lock.wrappedDek, created.lock.wrapIv);
    assert.deepEqual(await decryptFrame(dek, AAD, ciphertext), PLAINTEXT);
    assert.equal(ciphertext.length, IV_BYTES + PLAINTEXT.length + GCM_TAG_BYTES);
  });

  it('rejects a wrong password with wrong-password', async () => {
    const { kek } = await deriveRoomSecrets(WRONG_PASSWORD, created.lock.salt, created.lock.kdf);
    await rejectsWith(unwrapRoomKey(kek, created.lock.wrappedDek, created.lock.wrapIv), 'wrong-password');
  });

  it('rejects tampering with room, epoch, kind, binding or a bit as tampered', async () => {
    const wrongAads = [e2eAad('room_2', 1, 'update'), e2eAad('room_1', 2, 'update'), e2eAad('room_1', 1, 'ephemeral')];
    for (const aad of wrongAads) await rejectsWith(decryptFrame(created.dek, aad, ciphertext), 'tampered');
    const snapshot = await encryptFrame(created.dek, e2eAad('room_1', 1, 'snapshot', 5), PLAINTEXT);
    await rejectsWith(decryptFrame(created.dek, e2eAad('room_1', 1, 'snapshot', 6), snapshot), 'tampered');
    await rejectsWith(decryptFrame(created.dek, AAD, flipBit(ciphertext, ciphertext.length - 1)), 'tampered');
    await rejectsWith(decryptFrame(created.dek, AAD, flipBit(ciphertext, 0)), 'tampered');
    await rejectsWith(decryptFrame(created.dek, AAD, ciphertext.slice(0, IV_BYTES)), 'tampered');
  });

  it('uses a fresh IV for every frame', async () => {
    const second = await encryptFrame(created.dek, AAD, PLAINTEXT);
    assert.notDeepEqual(second.slice(0, IV_BYTES), ciphertext.slice(0, IV_BYTES));
  });

  it('keeps the DEK non-extractable', async () => {
    await assert.rejects(globalThis.crypto.subtle.exportKey('raw', created.dek));
    assert.equal(created.dek.extractable, false);
  });

  it('rewrap keeps the DEK so old ciphertext still decrypts under the new password', async () => {
    assert.equal(rewrapped.oldAuthKey, created.authKey);
    assert.notEqual(rewrapped.authKey, created.authKey);
    assert.notEqual(rewrapped.lock.salt, created.lock.salt);
    assert.ok(parseLockParams(rewrapped.lock));
    assert.equal(rewrapped.dek, undefined);
    const { kek } = await deriveRoomSecrets(NEW_PASSWORD, rewrapped.lock.salt, rewrapped.lock.kdf);
    const dek = await unwrapRoomKey(kek, rewrapped.lock.wrappedDek, rewrapped.lock.wrapIv);
    assert.equal(dek.extractable, false);
    assert.deepEqual(await decryptFrame(dek, AAD, ciphertext), PLAINTEXT);
  });

  it('createNextRoomKey produces an independent DEK and salt', async () => {
    const next = await createNextRoomKey(PASSWORD);
    assert.notEqual(next.lock.salt, created.lock.salt);
    await rejectsWith(decryptFrame(next.dek, AAD, ciphertext), 'tampered');
  });

  it('validates passwords and kdf before deriving', async () => {
    await assert.rejects(createRoomLock('short'), RangeError);
    await assert.rejects(createNextRoomKey('😀'.repeat(EMOJI_BELOW_MIN_COUNT)), RangeError);
    await assert.rejects(rewrapRoomLock({ currentPassword: PASSWORD, lock: created.lock, newPassword: 'short' }), RangeError);
    await assert.rejects(rewrapRoomLock({ currentPassword: PASSWORD, lock: created.lock, newPassword: PASSWORD }), RangeError);
    await assert.rejects(deriveRoomSecrets(PASSWORD, created.lock.salt, { ...LOCK_KDF, iterations: 1 }), RangeError);
    await assert.rejects(deriveRoomSecrets(PASSWORD, 'AAAA', created.lock.kdf), RangeError);
  });

  it('matches an independent known-answer derivation of authKey and KEK', async () => {
    assert.equal(created.authKey, reference.authKey);
    const iv = decodeBase64Url(created.lock.wrapIv);
    const wrapAad = utf8('retroroom/kek-wrap/v1');
    const rawDek = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: wrapAad }, reference.kek, decodeBase64Url(created.lock.wrappedDek));
    const dek = await subtle.importKey('raw', rawDek, 'AES-GCM', false, ['decrypt']);
    const frame = ciphertext;
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: frame.slice(0, IV_BYTES), additionalData: AAD }, dek, frame.slice(IV_BYTES));
    assert.deepEqual(new Uint8Array(plain), PLAINTEXT);
  });

  it('rejects a DEK wrapped with a different or absent AAD', async () => {
    const rawDek = new Uint8Array(32).fill(7);
    const iv = new Uint8Array(IV_BYTES).fill(1);
    for (const additionalData of [utf8('retroroom/other/v1'), undefined]) {
      const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, reference.kek, rawDek));
      await rejectsWith(unwrapRoomKey(reference.kek, encodeBase64Url(wrapped), encodeBase64Url(iv)), 'wrong-password');
    }
  });
});
