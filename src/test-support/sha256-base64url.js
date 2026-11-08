import { decodeBase64Url, encodeBase64Url } from '../domain/room-lock-contract.js';

/** SHA-256 of a base64url value, base64url encoded: how the relay checks an authKey against a verifier. */
export async function sha256Base64Url(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', decodeBase64Url(value));
  return encodeBase64Url(new Uint8Array(digest));
}
