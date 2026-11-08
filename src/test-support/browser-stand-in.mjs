import { ORIGIN } from './locked-room-harness.mjs';
import { clearRoomSession } from '../client/session/room-session.js';

const CLIENT_DEFAULT_RELAY = 'http://127.0.0.1:1234';

/**
 * Stands in for the browser around the real client code: a cookie jar, the page's Origin header, the relay's real
 * port, and the password proof (when `authKey` is given) the session exchange carries. `sent` records every request the page made as
 * `{ url, method, body }` (bodies as bytes), so a test can scan what left the browser. `cookies` seeds the jar with
 * `name=value` pairs (for example the account cookie); `cookieHeader()` is what the jar sends now, for sockets.
 */
export function installBrowserStandIn(t, relayUrl, authKey, { cookies = [] } = {}) {
  const realFetch = globalThis.fetch;
  const jar = new Map(cookies.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const sent = [];
  globalThis.window = { location: { origin: ORIGIN, hostname: '127.0.0.1', protocol: 'http:', pathname: '/b/room' } };
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url).replace(CLIENT_DEFAULT_RELAY, relayUrl);
    const headers = new Headers(init.headers);
    headers.set('origin', ORIGIN);
    if (jar.size) headers.set('cookie', cookieHeader());
    const body = authKey && target.endsWith('/api/room-session') ? JSON.stringify({ ...JSON.parse(init.body), authKey }) : init.body;
    sent.push({ url: target, method: init.method ?? 'GET', body: body instanceof Uint8Array ? body.slice() : body });
    const response = await realFetch(target, { ...init, headers, body });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
  t.after(() => {
    clearRoomSession();
    globalThis.fetch = realFetch;
    delete globalThis.window;
  });
  return { sent, cookieHeader };
}
