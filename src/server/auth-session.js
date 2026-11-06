import { createHmac } from 'node:crypto';
import { MILLISECONDS_PER_DAY, MILLISECONDS_PER_SECOND } from './relay-config.js';
import { canonicalSignature, singleCookieValue } from './relay-session.js';
import { fixedDigestEqual } from './relay-room-registry.js';

export const ACCOUNT_SESSION_TTL_MS = 30 * MILLISECONDS_PER_DAY;

const COOKIE_NAME = 'rb_account';
const SESSION_VERSION = 'v1';
const SIGNATURE_DOMAIN = 'account-session-v1\0';
const SIGNATURE_ENCODING = 'base64url';
const COOKIE_VALUE_MAX_CHARACTERS = 160;
const COOKIE_PART_COUNT = 5;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const GENERATION_PATTERN = /^\d{1,15}$/;
const EXPIRY_PATTERN = /^\d{13}$/;
const PREFIXED_COOKIE_PATH = '/yjs/api';
const UNPREFIXED_COOKIE_PATH = '/api';
const COOKIE_ATTRIBUTES = 'HttpOnly; SameSite=Lax';

export const accountCookiePath = (prefixed) => (prefixed ? PREFIXED_COOKIE_PATH : UNPREFIXED_COOKIE_PATH);

function decodedSession(value) {
  if (!value || value.length > COOKIE_VALUE_MAX_CHARACTERS) return null;
  const parts = value.split('.');
  if (parts.length !== COOKIE_PART_COUNT || parts[0] !== SESSION_VERSION) return null;
  const [, accountId, rawGeneration, rawExpiry, rawSignature] = parts;
  const signature = canonicalSignature(rawSignature);
  if (!ACCOUNT_ID_PATTERN.test(accountId) || !GENERATION_PATTERN.test(rawGeneration)
    || !EXPIRY_PATTERN.test(rawExpiry) || !signature) return null;
  return { accountId, generation: Number(rawGeneration), expiresAt: Number(rawExpiry), signature };
}

export class AccountSessions {
  #config;

  constructor({ signingKey, allowInsecureHttp, maxCookieHeaderBytes }) {
    this.#config = Object.freeze({ signingKey, allowInsecureHttp, maxCookieHeaderBytes });
  }

  #signature(accountId, generation, expiresAt) {
    return createHmac('sha256', this.#config.signingKey).update(SIGNATURE_DOMAIN)
      .update(accountId).update('\0').update(String(generation)).update('\0').update(String(expiresAt)).digest();
  }

  #secureAttribute() { return this.#config.allowInsecureHttp ? '' : '; Secure'; }

  createCookie(accountId, generation, path) {
    const expiresAt = Date.now() + ACCOUNT_SESSION_TTL_MS;
    const signature = this.#signature(accountId, generation, expiresAt).toString(SIGNATURE_ENCODING);
    const value = `${SESSION_VERSION}.${accountId}.${generation}.${expiresAt}.${signature}`;
    const maxAge = ACCOUNT_SESSION_TTL_MS / MILLISECONDS_PER_SECOND;
    return `${COOKIE_NAME}=${value}; Path=${path}; ${COOKIE_ATTRIBUTES}; Max-Age=${maxAge}${this.#secureAttribute()}`;
  }

  clearCookie(path) {
    return `${COOKIE_NAME}=; Path=${path}; ${COOKIE_ATTRIBUTES}; Max-Age=0${this.#secureAttribute()}`;
  }

  /** @returns {{ accountId: string, generation: number, expiresAt: number } | null} */
  read(req) {
    const session = decodedSession(singleCookieValue(req, COOKIE_NAME, this.#config.maxCookieHeaderBytes));
    if (!session) return null;
    const { accountId, generation, expiresAt, signature } = session;
    const now = Date.now();
    if (!Number.isSafeInteger(generation) || expiresAt <= now || expiresAt > now + ACCOUNT_SESSION_TTL_MS) return null;
    const expected = this.#signature(accountId, generation, expiresAt);
    return fixedDigestEqual(signature, expected) ? { accountId, generation, expiresAt } : null;
  }
}

/** Account behind a valid cookie whose generation still matches the stored account, else null. */
export async function authenticateAccount(req, sessions, store) {
  const session = sessions.read(req);
  if (!session) return null;
  const account = await store.get(session.accountId);
  return account && account.sessionGeneration === session.generation ? account : null;
}
