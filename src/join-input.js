const CODE_MIN_LENGTH = 3;
const CODE_MAX_LENGTH = 32;
const TOKEN_MIN_LENGTH = 8;
const TOKEN_MAX_LENGTH = 64;
const JOIN_CHARACTERS_PATTERN = /^[A-Za-z0-9_-]+$/;
const URL_ORIGIN_PATTERN = /^https?:\/\/[^/]+\//;
const BOARD_PATH_PATTERN = /^\/?b\//;
const TRAILING_SLASH_PATTERN = /\/$/;
const HASH_SEPARATOR = '#';

function validJoinPart(value, minimumLength, maximumLength) {
  return value.length >= minimumLength && value.length <= maximumLength
    && JOIN_CHARACTERS_PATTERN.test(value);
}

export function parseJoinInput(raw) {
  const trimmed = raw.trim();
  const hashIndex = trimmed.indexOf(HASH_SEPARATOR);
  const path = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const hash = hashIndex >= 0 ? trimmed.slice(hashIndex + HASH_SEPARATOR.length) : '';
  const code = path.replace(URL_ORIGIN_PATTERN, '')
    .replace(BOARD_PATH_PATTERN, '').replace(TRAILING_SLASH_PATTERN, '');
  if (!validJoinPart(code, CODE_MIN_LENGTH, CODE_MAX_LENGTH)) return null;
  const token = validJoinPart(hash, TOKEN_MIN_LENGTH, TOKEN_MAX_LENGTH) ? hash : null;
  return { code, token };
}
