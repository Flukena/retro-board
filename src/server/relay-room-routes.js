import { acceptCredentialOrigin, isExactAllowedOrigin, setCredentialCors, sendCredentialPreflight } from './relay-http.js';
import { E2E_BLOB_PREFLIGHT_HEADERS } from './e2e-blobs.js';
import { ROOM_SESSION_RENEWAL_SUFFIX } from '../domain/room-lock-contract.js';

const UPLOAD_PATH = /^\/rooms\/([A-Za-z0-9_-]{32})\/upload$/;
const ROOM_IMAGE_PATH = /^\/rooms\/([A-Za-z0-9_-]{32})\/images\/([a-f0-9-]+\.(?:png|jpe?g|webp|gif))$/;
const E2E_BLOBS_PATH = /^\/rooms\/([A-Za-z0-9_-]{32})\/e2e-blobs$/;
const E2E_BLOB_PATH = /^\/rooms\/([A-Za-z0-9_-]{32})\/e2e-blobs\/([0-9a-f-]{36})$/;
const LEGACY_IMAGE_PREFIX = '/images/';
const PREFLIGHT_METHODS = 'POST, OPTIONS';
const API_PREFLIGHT_PATHS = new Set(['/api/rooms', '/api/room-session']);
const LOCK_PREFLIGHT_PATH = /^\/api\/rooms\/[A-Za-z0-9_-]{32}\/lock\/(?:password|rotate\/(?:begin|commit|abort))$/;
const RENEWAL_PREFLIGHT_PATH = new RegExp(`^/rooms/[A-Za-z0-9_-]{32}${ROOM_SESSION_RENEWAL_SUFFIX}$`);

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
  // Locked rooms never accept plaintext image bytes; their images go to /e2e-blobs as ciphertext.
  if (ctx.lockFor(session.docName)) { reply(res, 403); return; }
  void ctx.uploads.handleUpload(req, res, ctx.clientIp, session.docName, handle);
};

const handleRoomImageGet = (req, res, [, handle, imageName], ctx) => {
  if (!ctx.rooms.has(handle)) { reply(res, 404); return; }
  if (isExactAllowedOrigin(req.headers.origin, ctx.allowedOrigins, ctx.allowInsecureHttp)) setCredentialCors(req.headers.origin, res);
  if (!ctx.authenticate(req, handle)) { reply(res, 401); return; }
  if (req.headers.origin && !acceptCredentialOrigin(req, res, ctx.allowedOrigins, ctx.allowInsecureHttp)) return;
  ctx.uploads.handleGetRoomImage(handle, imageName, ctx.clientIp, res);
};

// The session of a request to an encrypted-blob route, or null after answering it (404 for a normal room).
const blobSession = (req, res, handle, ctx) => {
  const docName = ctx.rooms.get(handle);
  if (!docName) { reply(res, 404); return null; }
  const lock = ctx.lockFor(docName);
  if (lock?.corrupt) { reply(res, 503); return null; }
  const session = ctx.authenticate(req, handle);
  if (!session) { reply(res, 401); return null; }
  if (!lock) { reply(res, 404); return null; }
  return session;
};

const handleBlobPreflight = (req, res, handle, ctx) => {
  if (!acceptCredentialOrigin(req, res, ctx.allowedOrigins, ctx.allowInsecureHttp)) return;
  if (!ctx.rooms.has(handle)) { reply(res, 404); return; }
  sendCredentialPreflight(req, res, { ...credentialOptions(ctx), methods: PREFLIGHT_METHODS, headers: E2E_BLOB_PREFLIGHT_HEADERS });
};

const handleBlobPost = (req, res, handle, ctx) => {
  if (!acceptCredentialOrigin(req, res, ctx.allowedOrigins, ctx.allowInsecureHttp)) return;
  res.setHeader('cache-control', 'no-store');
  if (ctx.unavailable) { reply(res, 503); return; }
  const session = blobSession(req, res, handle, ctx);
  if (session) void ctx.e2eBlobs.handleUpload(req, res, ctx.clientIp, session.docName, handle);
};

const handleBlobGet = (req, res, [, handle, blobId], ctx) => {
  if (isExactAllowedOrigin(req.headers.origin, ctx.allowedOrigins, ctx.allowInsecureHttp)) setCredentialCors(req.headers.origin, res);
  if (!blobSession(req, res, handle, ctx)) return;
  if (req.headers.origin && !acceptCredentialOrigin(req, res, ctx.allowedOrigins, ctx.allowInsecureHttp)) return;
  ctx.e2eBlobs.handleGet(ctx.clientIp, res, handle, blobId);
};

const ROUTES = [
  { method: 'OPTIONS', pattern: UPLOAD_PATH, run: (req, res, match, ctx) => handleUploadPreflight(req, res, match[1], ctx) },
  { method: 'POST', pattern: UPLOAD_PATH, run: (req, res, match, ctx) => handleUploadPost(req, res, match[1], ctx) },
  { method: 'OPTIONS', pattern: E2E_BLOBS_PATH, run: (req, res, match, ctx) => handleBlobPreflight(req, res, match[1], ctx) },
  { method: 'POST', pattern: E2E_BLOBS_PATH, run: (req, res, match, ctx) => handleBlobPost(req, res, match[1], ctx) },
  { method: 'GET', pattern: E2E_BLOB_PATH, run: handleBlobGet },
  { method: 'GET', pattern: ROOM_IMAGE_PATH, run: handleRoomImageGet },
];

const isApiPreflight = (routePath) => API_PREFLIGHT_PATHS.has(routePath) || LOCK_PREFLIGHT_PATH.test(routePath)
  || RENEWAL_PREFLIGHT_PATH.test(routePath);

/**
 * Serves room upload, encrypted blob, room image and legacy image routes.
 * Returns true when the request matched a route this module owns.
 */
export const handleRoomRoute = (req, res, routePath, ctx) => {
  if (!ctx.hasQueryOrFragment) {
    if (req.method === 'OPTIONS' && isApiPreflight(routePath)) {
      sendCredentialPreflight(req, res, { ...credentialOptions(ctx), methods: PREFLIGHT_METHODS });
      return true;
    }
    const route = ROUTES.find(({ method, pattern }) => method === req.method && pattern.test(routePath));
    if (route) {
      route.run(req, res, route.pattern.exec(routePath), ctx);
      return true;
    }
  }
  if (req.method === 'GET' && routePath.startsWith(LEGACY_IMAGE_PREFIX)) {
    ctx.uploads.handleGetLegacyImage(routePath.slice(LEGACY_IMAGE_PREFIX.length), ctx.clientIp, res);
    return true;
  }
  return false;
};
