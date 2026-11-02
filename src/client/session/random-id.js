// URL-safe random ids for documents and participants (Web Crypto, not Math.random).
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
// 12 chars * 6 bits = 72 bits; 256 is a multiple of 64 so `% 64` is unbiased.
const RANDOM_ID_LENGTH = 12;

export function createRandomId(cryptoSource = globalThis.crypto) {
  const bytes = cryptoSource.getRandomValues(new Uint8Array(RANDOM_ID_LENGTH));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}
