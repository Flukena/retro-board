import { createHmac } from 'node:crypto';
import { ROOM_HANDLE_RE, MILLISECONDS_PER_SECOND } from './relay-config.js';
import { fixedDigestEqual } from './relay-room-registry.js';

const COOKIE_NAME = 'rb_room_session';
const SESSION_VERSION = 'v1';
const SIGNATURE_DOMAIN = 'room-session-v1\0';
const SIGNATURE_ENCODING = 'base64url';
const COOKIE_VALUE_MAX_CHARACTERS = 160;
const COOKIE_PART_COUNT = 4;
const MIN_COOKIE_MAX_AGE_SECONDS = 1;
const EXPIRY_PATTERN = /^\d{13}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function cookieValue(req, maxHeaderBytes) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > maxHeaderBytes) return null;
  let found = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1 || part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found;
}

function decodedSession(value) {
  if (!value || value.length > COOKIE_VALUE_MAX_CHARACTERS) return null;
  const parts = value.split('.');
  if (parts.length !== COOKIE_PART_COUNT || parts[0] !== SESSION_VERSION) return null;
  const [, handle, rawExpiry, rawSignature] = parts;
  if (!ROOM_HANDLE_RE.test(handle) || !EXPIRY_PATTERN.test(rawExpiry) || !SIGNATURE_PATTERN.test(rawSignature)) return null;
  const signature = Buffer.from(rawSignature, SIGNATURE_ENCODING);
  // Alternate spellings with nonzero unused padding bits are tampering too.
  if (signature.toString(SIGNATURE_ENCODING) !== rawSignature) return null;
  return { handle, expiresAt: Number(rawExpiry), signature };
}

export class RoomSessions {
  #config;

  constructor(config) { this.#config = Object.freeze({ ...config }); }

  #signature(handle, expiresAt, docName) {
    return createHmac('sha256', this.#config.signingKey).update(SIGNATURE_DOMAIN)
      .update(handle).update('\0').update(String(expiresAt)).update('\0').update(docName).digest();
  }

  createCookie(handle, expiresAt, docName, path) {
    const signature = this.#signature(handle, expiresAt, docName).toString(SIGNATURE_ENCODING);
    const value = `${SESSION_VERSION}.${handle}.${expiresAt}.${signature}`;
    const maxAge = Math.max(MIN_COOKIE_MAX_AGE_SECONDS, Math.floor((expiresAt - Date.now()) / MILLISECONDS_PER_SECOND));
    return `${COOKIE_NAME}=${value}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.#config.allowInsecureHttp ? '' : '; Secure'}`;
  }

  authenticate(req, requestedHandle) {
    if (!ROOM_HANDLE_RE.test(requestedHandle)) return null;
    const docName = this.#config.rooms.get(requestedHandle);
    const session = decodedSession(cookieValue(req, this.#config.maxCookieHeaderBytes));
    if (!docName || !session) return null;
    const now = Date.now();
    const { expiresAt } = session;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + this.#config.ttlMs) return null;
    const handleMatches = fixedDigestEqual(Buffer.from(session.handle), Buffer.from(requestedHandle));
    const expected = this.#signature(requestedHandle, expiresAt, docName);
    return handleMatches && fixedDigestEqual(session.signature, expected) ? { docName, expiresAt } : null;
  }
}
