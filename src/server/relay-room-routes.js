import { acceptCredentialOrigin, isExactAllowedOrigin, setCredentialCors, sendCredentialPreflight } from './relay-http.js';

const UPLOAD_PATH = /^\/rooms\/([A-Za-z0-9_-]{32})\/upload$/;
const ROOM_IMAGE_PATH = /^\/rooms\/([A-Za-z0-9_-]{32})\/images\/([a-f0-9-]+\.(?:png|jpe?g|webp|gif))$/;
const LEGACY_IMAGE_PREFIX = '/images/';
const PREFLIGHT_METHODS = 'POST, OPTIONS';
const API_PREFLIGHT_PATHS = new Set(['/api/rooms', '/api/room-session']);

const reply = (res, status) => {
  res.writeHead(status);
  res.end();
};

const credentialOptions = (ctx) => ({ allowedOrigins: ctx.allowedOrigins, allowInsecureHttp: ctx.allowInsecureHttp });

const handleUploadPreflight = (req, res, handle, ctx) => {
  if (!acceptCredentialOrigin(req, res, ctx.allowedOrigins, ctx.allowInsecureHttp)) return;
  if (!ctx.rooms.has(handle)) { reply(res, 404); return; }
  // Origin was already accepted above; the shared helper re-checks it and writes the 204.
  sendCredentialPreflight(req, res, { ...credentialOptions(ctx), methods: PREFLIGHT_METHODS });
};

const handleUploadPost = (req, res, handle, ctx) => {
  if (!acceptCredentialOrigin(req, res, ctx.allowedOrigins, ctx.allowInsecureHttp)) return;
  res.setHeader('cache-control', 'no-store');
  if (ctx.unavailable) { reply(res, 503); return; }
  if (!ctx.rooms.has(handle)) { reply(res, 404); return; }
  const session = ctx.authenticate(req, handle);
  if (!session) { reply(res, 401); return; }
  void ctx.uploads.handleUpload(req, res, ctx.clientIp, session.docName, handle);
};

const handleRoomImageGet = (req, res, [, handle, imageName], ctx) => {
  if (!ctx.rooms.has(handle)) { reply(res, 404); return; }
  if (isExactAllowedOrigin(req.headers.origin, ctx.allowedOrigins, ctx.allowInsecureHttp)) setCredentialCors(req.headers.origin, res);
  if (!ctx.authenticate(req, handle)) { reply(res, 401); return; }
  if (req.headers.origin && !acceptCredentialOrigin(req, res, ctx.allowedOrigins, ctx.allowInsecureHttp)) return;
  ctx.uploads.handleGetRoomImage(handle, imageName, ctx.clientIp, res);
};

/**
 * Serves room upload, room image and legacy image routes.
 * Returns true when the request matched a route this module owns.
 */
export const handleRoomRoute = (req, res, routePath, ctx) => {
  const uploadMatch = ctx.hasQueryOrFragment ? null : routePath.match(UPLOAD_PATH);
  const imageMatch = ctx.hasQueryOrFragment ? null : routePath.match(ROOM_IMAGE_PATH);
  if (req.method === 'OPTIONS' && !ctx.hasQueryOrFragment && API_PREFLIGHT_PATHS.has(routePath)) {
    sendCredentialPreflight(req, res, { ...credentialOptions(ctx), methods: PREFLIGHT_METHODS });
    return true;
  }
  if (req.method === 'OPTIONS' && uploadMatch) { handleUploadPreflight(req, res, uploadMatch[1], ctx); return true; }
  if (req.method === 'POST' && uploadMatch) { handleUploadPost(req, res, uploadMatch[1], ctx); return true; }
  if (req.method === 'GET' && imageMatch) { handleRoomImageGet(req, res, imageMatch, ctx); return true; }
  if (req.method === 'GET' && routePath.startsWith(LEGACY_IMAGE_PREFIX)) {
    ctx.uploads.handleGetLegacyImage(routePath.slice(LEGACY_IMAGE_PREFIX.length), ctx.clientIp, res);
    return true;
  }
  return false;
};
