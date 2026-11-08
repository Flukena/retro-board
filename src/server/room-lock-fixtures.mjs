import { createHash } from 'node:crypto';
import { LOCK_BYTES, LOCK_KDF, encodeBase64Url } from '../domain/room-lock-contract.js';

export const START_MS = 1_800_000_000_000;
export const OWNER = 'A'.repeat(22);
const bytes = (length, fill) => new Uint8Array(length).fill(fill);
export const b64 = (length, fill) => encodeBase64Url(bytes(length, fill));
export const RIGHT_KEY = b64(LOCK_BYTES.authKey, 7);
export const WRONG_KEY = b64(LOCK_BYTES.authKey, 8);

export const lockRecord = (overrides = {}) => ({
  v: 1,
  salt: b64(LOCK_BYTES.salt, 1),
  kdf: { ...LOCK_KDF },
  verifier: encodeBase64Url(createHash('sha256').update(bytes(LOCK_BYTES.authKey, 7)).digest()),
  wrappedDek: b64(LOCK_BYTES.wrappedDek, 3),
  wrapIv: b64(LOCK_BYTES.wrapIv, 4),
  keyEpoch: 0,
  ownerAccountId: OWNER,
  createdAt: START_MS,
  lockRevision: 0,
  ...overrides,
});
