import { acceptCredentialOrigin, sendIfWritable, sendJson, sendSerializedJson } from './relay-http.js';
import { CORS_PREFLIGHT_MAX_AGE_SECONDS, RETRY_AFTER_SHORT_SECONDS, MILLISECONDS_PER_SECOND } from './relay-config.js';
import { PUBLIC_WRITER_CAP, PUBLIC_RELAY_PREFIX, PUBLIC_SNAPSHOT_INTERVAL_MS, PUBLIC_SESSION_ROUTE, PUBLIC_SNAPSHOT_ROUTE, PUBLIC_ROOM_SESSION_SUFFIX } from '../domain/public-wall-contract.js';
import { PublicSnapshotCache } from './public-wall-snapshot.js';

const SNAPSHOT_CACHE_CONTROL = `public, max-age=${PUBLIC_SNAPSHOT_INTERVAL_MS / MILLISECONDS_PER_SECOND}`;
const DISABLED_API_ROUTES = new Set(['/api/rooms', '/api/room-session']);
const disabledPublicRoute = path => DISABLED_API_ROUTES.has(path)
  || path.startsWith('/images/') || /\/(?:upload|images)(?:\/|$)/.test(path);

function sendPostPreflight(res) {
  sendIfWritable(res, 204, { 'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type', 'access-control-max-age': String(CORS_PREFLIGHT_MAX_AGE_SECONDS) });
}

export async function provisionPublicWall(registry) {
  if (!registry.registeredDocs.size) await registry.createRoom();
  if (registry.registeredDocs.size !== 1) throw new Error('Public wall requires exactly one committed room');
  const [docName] = registry.registeredDocs;
  return { docName, roomHandle: registry.roomHandleForDoc(docName) };
}

/** Request ports are owned by this layer; the server supplies admission/session
 * operations per call, matching RelayMaintenance's peer-port convention. */
export class RelayPublicWall {
  #snapshot;
  #snapshotValue = null;
  #snapshotJson = null;
  constructor({ docName, roomHandle }) {
    this.docName = docName;
    this.roomHandle = roomHandle;
    this.#snapshot = new PublicSnapshotCache({ roomHandle });
  }

  handleRequest(req, res, path, prefixed, context) {
    if (this.#media(req, res, path, context)) return true;
    if (disabledPublicRoute(path)) {
      sendIfWritable(res, 404);
      return true;
    }
    const refresh = path === `/rooms/${this.roomHandle}${PUBLIC_ROOM_SESSION_SUFFIX}`;
    if (path === PUBLIC_SESSION_ROUTE || refresh) {
      this.#session(req, res, prefixed, context, refresh);
      return true;
    }
    if (path !== PUBLIC_SNAPSHOT_ROUTE) return false;
    if (req.method !== 'GET') sendIfWritable(res, 404);
    else if (context.unavailable || !context.doc) sendIfWritable(res, 503);
    else {
      const value = this.#snapshot.read(context.doc);
      if (value !== this.#snapshotValue) {
        this.#snapshotValue = value;
        this.#snapshotJson = JSON.stringify(value);
      }
      sendSerializedJson(res, 200, this.#snapshotJson, { 'cache-control': SNAPSHOT_CACHE_CONTROL });
    }
    return true;
  }

  #media(req, res, path, context) {
    const upload = path === `/rooms/${this.roomHandle}/upload`;
    const imagePrefix = `/rooms/${this.roomHandle}/images/`;
    if (!upload && !path.startsWith(imagePrefix)) return false;
    if (context.hasQueryOrFragment) sendIfWritable(res, 404);
    else if (upload) this.#upload(req, res, context);
    else this.#image(req, res, path.slice(imagePrefix.length), context);
    return true;
  }

  #upload(req, res, context) {
    res.setHeader('cache-control', 'no-store');
    if (!['POST', 'OPTIONS'].includes(req.method)) { sendIfWritable(res, 404); return; }
    if (!acceptCredentialOrigin(req, res, context.allowedOrigins, context.allowInsecureHttp)) return;
    if (req.method === 'OPTIONS') { sendPostPreflight(res); return; }
    if (context.unavailable) { sendIfWritable(res, 503); return; }
    if (!context.sessionAuthenticated) { sendIfWritable(res, 401); return; }
    void context.uploads.handleUpload(req, res, context.clientIp, this.docName, this.roomHandle);
  }

  #image(req, res, imageId, context) {
    if (req.method !== 'GET') { sendIfWritable(res, 404); return; }
    if (req.headers.origin !== undefined
      && !acceptCredentialOrigin(req, res, context.allowedOrigins, context.allowInsecureHttp)) return;
    if (context.unavailable) { sendIfWritable(res, 503); return; }
    context.uploads.handleGetRoomImage(this.roomHandle, imageId, context.clientIp, res);
  }

  #session(req, res, prefixed, context, refresh) {
    res.setHeader('cache-control', 'no-store');
    if (!['POST', 'OPTIONS'].includes(req.method)) { sendIfWritable(res, 404); return; }
    if (!acceptCredentialOrigin(req, res, context.allowedOrigins, context.allowInsecureHttp)) return;
    if (req.method === 'OPTIONS') {
      sendPostPreflight(res);
      return;
    }
    if (context.unavailable) { sendIfWritable(res, 503); return; }
    if (refresh && !context.sessionAuthenticated) { sendIfWritable(res, 401); return; }
    if (!context.takeSessionExchangeToken() || (!refresh && context.writerCount >= PUBLIC_WRITER_CAP)) {
      sendIfWritable(res, 429, { 'retry-after': RETRY_AFTER_SHORT_SECONDS });
      return;
    }
    const expiresAt = Date.now() + context.sessionTtlMs;
    const path = `${prefixed ? PUBLIC_RELAY_PREFIX : ''}/rooms/${this.roomHandle}`;
    sendJson(res, 200, { roomHandle: this.roomHandle, expiresAt }, {
      'set-cookie': context.createSessionCookie(this.roomHandle, expiresAt, this.docName, path),
    });
  }
}

const WEBSOCKET_OPEN_STATE = 1;
// y-websocket evicts persisted docs when conns becomes empty. A local snapshot
// subscriber keeps this one document resident without a socket or writer slot.
export function retainPublicDocument(doc) {
  const subscriber = {
    readyState: WEBSOCKET_OPEN_STATE,
    close() {},
    send(_message, acknowledge) { acknowledge?.(); },
  };
  doc.conns.set(subscriber, new Set());
  doc.once('destroy', () => doc.conns.delete(subscriber));
}
