import { ORIGIN } from './locked-room-harness.mjs';
import { clearRoomSession } from '../client/session/room-session.js';

const CLIENT_DEFAULT_RELAY = 'http://127.0.0.1:1234';

const ROOT_PATH = '/';
const PATH_ATTRIBUTE = 'path';
const MAX_AGE_ATTRIBUTE = 'max-age';

// RFC 6265 §5.1.4: the directory of the request path, used when a Set-Cookie names no Path.
const defaultPath = (requestPath) => {
  const lastSlash = requestPath.lastIndexOf(ROOT_PATH);
  return lastSlash <= 0 ? ROOT_PATH : requestPath.slice(0, lastSlash);
};

// RFC 6265 §5.1.4 path-match: the cookie path itself, or below it at a `/` boundary.
const pathMatches = (requestPath, cookiePath) => requestPath === cookiePath || (requestPath.startsWith(cookiePath)
  && (cookiePath.endsWith(ROOT_PATH) || requestPath[cookiePath.length] === ROOT_PATH));

/** `{ name, value, path, expired }` of one Set-Cookie line; `fallbackPath` stands in for a missing Path. */
function parseSetCookie(line, fallbackPath) {
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  const at = pair.indexOf('=');
  const cookie = { name: pair.slice(0, at), value: pair.slice(at + 1), path: fallbackPath, expired: false };
  for (const attribute of attributes) {
    const [key, attributeValue = ''] = attribute.split('=');
    if (key.toLowerCase() === PATH_ATTRIBUTE && attributeValue.startsWith(ROOT_PATH)) cookie.path = attributeValue;
    if (key.toLowerCase() === MAX_AGE_ATTRIBUTE && Number(attributeValue) <= 0) cookie.expired = true;
  }
  return cookie;
}

/** A cookie jar that, like a browser, sends a cookie only to URLs under its Path. */
class CookieJar {
  #cookies = new Map();

  store(line, requestUrl) {
    const cookie = parseSetCookie(line, requestUrl === null ? null : defaultPath(new URL(requestUrl).pathname));
    if (cookie.path === null) throw new TypeError(`a seeded cookie needs a Path: ${cookie.name}`);
    const id = `${cookie.name}\0${cookie.path}`;
    if (cookie.expired) this.#cookies.delete(id);
    else this.#cookies.set(id, cookie);
  }

  header(url) {
    const { pathname } = new URL(url);
    return [...this.#cookies.values()].filter((cookie) => pathMatches(pathname, cookie.path))
      .map(({ name, value }) => `${name}=${value}`).join('; ');
  }
}

/**
 * Stands in for the browser around the real client code: a path-scoped cookie jar, the page's Origin header, the
 * relay's real port, and the password proof (when `authKey` is given) the session exchange carries. `sent` records
 * every request the page made as `{ url, method, body }` (bodies as bytes), so a test can scan what left the browser.
 * `cookies` seeds the jar with whole Set-Cookie lines, Path included (for example the account cookie);
 * `cookieHeader(url)` is what the jar sends to `url` now, for sockets and direct checks.
 */
export function installBrowserStandIn(t, relayUrl, authKey, { cookies = [] } = {}) {
  const realFetch = globalThis.fetch;
  const jar = new CookieJar();
  cookies.forEach((line) => jar.store(line, null));
  const cookieHeader = (url) => jar.header(url);
  const sent = [];
  globalThis.window = { location: { origin: ORIGIN, hostname: '127.0.0.1', protocol: 'http:', pathname: '/b/room' } };
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url).replace(CLIENT_DEFAULT_RELAY, relayUrl);
    const headers = new Headers(init.headers);
    headers.set('origin', ORIGIN);
    const cookie = cookieHeader(target);
    if (cookie) headers.set('cookie', cookie);
    const body = authKey && target.endsWith('/api/room-session') ? JSON.stringify({ ...JSON.parse(init.body), authKey }) : init.body;
    sent.push({ url: target, method: init.method ?? 'GET', body: body instanceof Uint8Array ? body.slice() : body });
    const response = await realFetch(target, { ...init, headers, body });
    response.headers.getSetCookie().forEach((line) => jar.store(line, target));
    return response;
  };
  t.after(() => {
    clearRoomSession();
    globalThis.fetch = realFetch;
    delete globalThis.window;
  });
  return { sent, cookieHeader };
}
