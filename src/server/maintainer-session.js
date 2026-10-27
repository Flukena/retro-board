import { createHash, randomBytes } from 'node:crypto';

export const MAINTAINER_SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSIONS = 32;
const TOKEN_BYTES = 32;
const COOKIE_SCOPE_HASH_LENGTH = 16;
const MILLISECONDS_PER_SECOND = 1000;

export function createMaintainerSessions(key, now = Date.now) {
  // Cookies share a host across ports; each relay key needs its own name.
  const scope = createHash('sha256').update(key).digest('hex').slice(0, COOKIE_SCOPE_HASH_LENGTH);
  const name = `maintainer_${scope}`;
  const sessions = new Map();
  const tokenFrom = header => {
    const matches = (header ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
    return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
  };
  const cookie = (token, seconds, secure) => `${name}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return {
    valid(header) {
      const token = tokenFrom(header);
      const expiresAt = sessions.get(token);
      if (expiresAt > now()) return true;
      sessions.delete(token);
      return false;
    },
    issue(header, secure) {
      sessions.delete(tokenFrom(header));
      for (const [token, expiresAt] of sessions) if (expiresAt <= now()) sessions.delete(token);
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      sessions.set(token, now() + MAINTAINER_SESSION_SECONDS * MILLISECONDS_PER_SECOND);
      return cookie(token, MAINTAINER_SESSION_SECONDS, secure);
    },
    revoke(header, secure) {
      sessions.delete(tokenFrom(header));
      return cookie('', 0, secure);
    },
  };
}
