import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MAINTAINER_REFRESH_MS } from './maintainer-snapshot.js';
import { envBool } from './relay-config.js';
import { createMaintainerSessions } from './maintainer-session.js';
import { createMaintainerRoomLinks } from './maintainer-room-access.js';

const DEFAULT_PORT = 1240;
const MAX_PORT = 65535;
const HEADER_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_HEADER_BYTES = 4096;
const SOCKET_TIMEOUT_MS = 15000;
const MAX_CONNECTIONS = 16;
const KEY_RE = /^[A-Za-z0-9_-]{43,128}$/;
const ASSETS = [['/', 'index.html', 'text/html; charset=utf-8'], ['/maintainer.js', 'maintainer.js', 'text/javascript'], ['/maintainer.css', 'maintainer.css', 'text/css']];
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const digest = (value) => createHash('sha256').update(value).digest();

export function maintainerConfig(env) {
  if (!env.YJS_MAINTAINER_KEY) return null;
  if (!KEY_RE.test(env.YJS_MAINTAINER_KEY)) throw new Error('YJS_MAINTAINER_KEY must be a random base64url key of at least 43 characters');
  const port = Number(env.YJS_MAINTAINER_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) throw new Error('Invalid maintainer port');
  const origins = new Set();
  if (env.YJS_MAINTAINER_ORIGIN) {
    const origin = new URL(env.YJS_MAINTAINER_ORIGIN);
    if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.ts.net') || origin.origin !== env.YJS_MAINTAINER_ORIGIN) {
      throw new Error('Maintainer origin must be an exact HTTPS Tailscale .ts.net origin');
    }
    origins.add(origin.origin);
  }
  // Container mode relies on an explicit loopback-only host port publication.
  const container = envBool('YJS_MAINTAINER_CONTAINER', false, env);
  return { port, key: env.YJS_MAINTAINER_KEY, origins, container };
}

function allowedRequest(req, origins, container) {
  const loopback = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
  const hostOrigins = [`http://${req.headers.host}`, `https://${req.headers.host}`];
  const hostAllowed = hostOrigins.some(origin => origins.has(origin));
  const originAllowed = !req.headers.origin || origins.has(req.headers.origin);
  return (loopback || container) && hostAllowed && originAllowed && req.headers['sec-fetch-site'] !== 'cross-site';
}

const respond = (res, status, body = '', type = 'text/plain', headers = {}) => {
  res.writeHead(status, { ...HEADERS, 'content-type': type, ...headers });
  res.end(body);
};

export function createMaintainerServer({ key, origins = new Set(), container = false, snapshot, roomLink = () => null, assets = new Map() }) {
  const expected = digest(`Bearer ${key}`);
  let sessions;
  const authenticatedKey = req => req.headersDistinct.authorization?.length === 1
    && timingSafeEqual(digest(req.headers.authorization ?? ''), expected);
  const sessionRequest = (req, res) => {
    if (!origins.has(req.headers.origin)) { respond(res, 403); return; }
    const secure = origins.has(`https://${req.headers.host}`);
    if (req.method === 'DELETE') {
      respond(res, 204, '', 'text/plain', { 'set-cookie': sessions.revoke(req.headers.cookie, secure) });
    } else if (req.method !== 'POST') {
      respond(res, 405);
    } else if (!authenticatedKey(req)) {
      respond(res, 401);
    } else {
      respond(res, 204, '', 'text/plain', { 'set-cookie': sessions.issue(req.headers.cookie, secure) });
    }
  };
  const joinRoom = (req, res, handle) => {
    if (!origins.has(req.headers.origin)) { respond(res, 403); return; }
    if (req.method !== 'POST') { respond(res, 405); return; }
    if (!authenticatedKey(req) && !sessions.valid(req.headers.cookie)) { respond(res, 401); return; }
    const url = roomLink(handle);
    respond(res, url ? 200 : 404, url ? JSON.stringify({ url }) : '', 'application/json');
  };
  let cached;
  let expiresAt = 0;
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    if (!allowedRequest(req, origins, container)) { respond(res, 403); return; }
    if (req.url === '/api/session') { sessionRequest(req, res); return; }
    const join = /^\/api\/rooms\/([A-Za-z0-9_-]{32})\/join$/.exec(req.url);
    if (join) { joinRoom(req, res, join[1]); return; }
    if (req.method !== 'GET') { respond(res, 405); return; }
    if (req.url !== '/api/status') {
      const asset = assets.get(req.url);
      respond(res, asset ? 200 : 404, asset?.body, asset?.type);
      return;
    }
    if (!authenticatedKey(req) && !sessions.valid(req.headers.cookie)) {
      respond(res, 401); return;
    }
    try {
      if (Date.now() >= expiresAt) {
        cached = JSON.stringify(snapshot());
        expiresAt = Date.now() + MAINTAINER_REFRESH_MS;
      }
      respond(res, 200, cached, 'application/json');
    } catch {
      respond(res, 503);
    }
  });
  server.headersTimeout = HEADER_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.timeout = SOCKET_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  server.on('listening', () => {
    const { port } = server.address();
    sessions = createMaintainerSessions(`${key}:${port}`);
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  });
  return server;
}

export async function startMaintainer(env, snapshot, roomAccess) {
  const config = maintainerConfig(env);
  if (!config) return null;
  const root = new URL('../../dist-maintainer/', import.meta.url);
  const assets = new Map(ASSETS.map(([path, file, type]) => [path, { body: readFileSync(new URL(file, root)), type }]));
  const server = createMaintainerServer({ ...config, snapshot, assets, roomLink: createMaintainerRoomLinks(roomAccess) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.container ? '0.0.0.0' : '127.0.0.1', resolve);
  });
  return server;
}
