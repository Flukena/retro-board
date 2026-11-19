import { MAX_HTTP_TARGET_CHARACTERS, RETRY_AFTER_SHORT_SECONDS } from './relay-config.js';
import { PUBLIC_RELAY_PREFIX } from './public-wall-config.js';
import { isRelayReady } from './relay-lifecycle.js';
import { handleRoomRoute } from './relay-room-routes.js';

export function createHttpDispatch({ settings, accounting, traffic, sessions, rooms, routes, assets, rejectionCounters, lateBindings }) {
  const { PUBLIC_WALL, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP, ROOM_SESSION_TTL_MS } = settings;
  const { clientIpFromRequest, reserveHttpRequest, wsTraffic } = traffic;
  const { takeSessionExchangeToken, createSessionCookie, authenticatedDocFromRequest } = sessions;
  const { publicWall, docs, registeredRoomsByHandle } = rooms;
  const { roomSessionRoutes, authRoutes } = routes;
  const { uploads, lockForDoc } = assets;

  const targetFromRequest = (req, res) => {
    let pathname;
    let hasQueryOrFragment = false;
    try {
      if (!req.url || req.url.length > MAX_HTTP_TARGET_CHARACTERS) throw new Error('invalid request target');
      const parsed = new URL(req.url, 'http://localhost');
      ({ pathname } = parsed);
      hasQueryOrFragment = Boolean(parsed.search || parsed.hash);
    } catch {
      res.writeHead(400);
      res.end();
      return null;
    }
    // Cloudflare Tunnel forwards the /yjs prefix through unstripped in prod;
    // capability, session and room-upload routes answer in bare and prefixed
    // forms so dev and production use the same server.
    const prefix = PUBLIC_WALL ? PUBLIC_RELAY_PREFIX : '/yjs';
    const prefixed = pathname === prefix || pathname.startsWith(`${prefix}/`);
    const routePath = (prefixed ? pathname.slice(prefix.length) : pathname) || '/';
    return { routePath, prefixed, hasQueryOrFragment };
  };

  const handlePublic = (req, res, clientIp, { routePath, prefixed, hasQueryOrFragment }) => {
    if (publicWall && publicWall.handleRequest(req, res, routePath, prefixed, {
      allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: ALLOW_INSECURE_HTTP, uploads, clientIp, hasQueryOrFragment,
      unavailable: hasQueryOrFragment || accounting.shuttingDown || Boolean(accounting.storageFailure),
      doc: docs.get(publicWall.docName), writerCount: wsTraffic.connectionsByRoom.get(publicWall.docName) || 0,
      takeSessionExchangeToken: () => takeSessionExchangeToken(clientIp),
      sessionTtlMs: ROOM_SESSION_TTL_MS, createSessionCookie, sessionAuthenticated: Boolean(authenticatedDocFromRequest(req, publicWall.roomHandle)),
    })) return true;
    return false;
  };

  const handleReady = (req, res, routePath) => {
    if (req.method === 'GET' && routePath === '/readyz') {
      const ok = isRelayReady(accounting.storageFailure, accounting.shuttingDown);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' });
      res.end(ok ? 'ready' : 'not ready');
      return true;
    }
    return false;
  };

  const handlePrivate = (req, res, clientIp, { routePath, prefixed, hasQueryOrFragment }) => {
    if (roomSessionRoutes.handle(req, res, routePath, { clientIp, prefixed, hasQueryOrFragment })) return true;
    if (lateBindings.roomLockRoutes.handle(req, res, routePath, { clientIp, hasQueryOrFragment })) return true;
    if (authRoutes.handle(req, res, routePath, { prefixed, clientIp, unavailable: () => accounting.shuttingDown || Boolean(accounting.storageFailure) })) return true;
    if (handleRoomRoute(req, res, routePath, {
      hasQueryOrFragment, allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: ALLOW_INSECURE_HTTP,
      unavailable: accounting.shuttingDown || Boolean(accounting.storageFailure), rooms: registeredRoomsByHandle,
      authenticate: authenticatedDocFromRequest, uploads, clientIp, lockFor: lockForDoc, e2eBlobs: lateBindings.e2eBlobs,
    })) return true;
    return false;
  };

  const dispatch = (req, res) => {
    rejectionCounters.observeResponse(res);
    const clientIp = clientIpFromRequest(req);
    const reservation = reserveHttpRequest(clientIp);
    if (reservation.status) {
      res.writeHead(reservation.status, { 'retry-after': RETRY_AFTER_SHORT_SECONDS });
      res.end();
      return;
    }
    res.once('finish', reservation.release);
    res.once('close', reservation.release);
    const target = targetFromRequest(req, res);
    if (!target) return;
    if (handlePublic(req, res, clientIp, target)) return;
    const { routePath } = target;
    if (handleReady(req, res, routePath)) return;
    if (handlePrivate(req, res, clientIp, target)) return;
    if (req.method === 'GET' && routePath === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('yjs-ws ok');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };

  return { dispatch };
}
