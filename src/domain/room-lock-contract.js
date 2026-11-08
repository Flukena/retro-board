export const LOCK_KDF = Object.freeze({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 });
export const LOCK_BYTES = Object.freeze({ salt: 16, verifier: 32, wrappedDek: 48, wrapIv: 12, authKey: 32 });
export const ROOM_PASSWORD_MIN_LENGTH = 10;

const AAD_PREFIX = 'retroroom/e2e/v1';
const AAD_SEPARATOR = '|';
const BOUND_KINDS = new Set(['snapshot', 'blob']);
const UNBOUND_KINDS = new Set(['update', 'ephemeral']);
const LOCK_FIELDS = ['salt', 'kdf', 'verifier', 'wrappedDek', 'wrapIv'];
const KDF_FIELDS = Object.keys(LOCK_KDF);
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const BITS_PER_BYTE = 8;
const BITS_PER_CHAR = 6;
const BYTE_MASK = 0xff;
const CHAR_MASK = 0x3f;
const INVALID_LENGTH_REMAINDER = 1;
const CHAR_GROUP = 4;
const ROOM_HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BLOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const textEncoder = new TextEncoder();

export function encodeBase64Url(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BITS_PER_CHAR) {
      bits -= BITS_PER_CHAR;
      out += BASE64URL_ALPHABET[(buffer >> bits) & CHAR_MASK];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE64URL_ALPHABET[(buffer << (BITS_PER_CHAR - bits)) & CHAR_MASK];
  return out;
}

/** Returns Uint8Array, or null when the text is not canonical unpadded base64url. */
export function decodeBase64Url(text) {
  if (typeof text !== 'string' || !BASE64URL_PATTERN.test(text) || text.length % CHAR_GROUP === INVALID_LENGTH_REMAINDER) return null;
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << BITS_PER_CHAR) | BASE64URL_ALPHABET.indexOf(char);
    bits += BITS_PER_CHAR;
    if (bits >= BITS_PER_BYTE) {
      bits -= BITS_PER_BYTE;
      out.push((buffer >> bits) & BYTE_MASK);
    }
    buffer &= (1 << bits) - 1;
  }
  return buffer === 0 ? Uint8Array.from(out) : null;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const hasBytes = (value, length) => decodeBase64Url(value)?.length === length;

const isLockKdf = (kdf) => isPlainObject(kdf) && hasExactKeys(kdf, KDF_FIELDS)
  && KDF_FIELDS.every((key) => kdf[key] === LOCK_KDF[key]);

export function parseLockParams(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, LOCK_FIELDS) || !isLockKdf(value.kdf)) return null;
  const sizes = { salt: LOCK_BYTES.salt, verifier: LOCK_BYTES.verifier, wrappedDek: LOCK_BYTES.wrappedDek, wrapIv: LOCK_BYTES.wrapIv };
  if (!Object.entries(sizes).every(([key, length]) => hasBytes(value[key], length))) return null;
  const { salt, verifier, wrappedDek, wrapIv } = value;
  return Object.freeze({ salt, kdf: Object.freeze({ ...LOCK_KDF }), verifier, wrappedDek, wrapIv });
}

export const parseAuthKey = (value) => (hasBytes(value, LOCK_BYTES.authKey) ? value : null);

const isCounter = (value) => Number.isSafeInteger(value) && value >= 0;

const bindingIsValid = (kind, binding) => (kind === 'snapshot' ? isCounter(binding) : BLOB_ID_PATTERN.test(binding ?? ''));

export function e2eAad(roomHandle, keyEpoch, kind, binding) {
  const bound = BOUND_KINDS.has(kind);
  if (!bound && !UNBOUND_KINDS.has(kind)) throw new RangeError(`unknown AAD kind ${kind}`);
  const hasBinding = binding !== undefined;
  if (bound !== hasBinding) throw new RangeError(`AAD kind ${kind} ${bound ? 'requires' : 'forbids'} a binding`);
  if (typeof roomHandle !== 'string' || !ROOM_HANDLE_PATTERN.test(roomHandle)) throw new RangeError('invalid roomHandle');
  if (!isCounter(keyEpoch)) throw new RangeError('invalid keyEpoch');
  if (bound && !bindingIsValid(kind, binding)) throw new RangeError(`invalid ${kind} binding`);
  const parts = [AAD_PREFIX, roomHandle, keyEpoch, kind, ...(bound ? [binding] : [])];
  return textEncoder.encode(parts.join(AAD_SEPARATOR));
}
