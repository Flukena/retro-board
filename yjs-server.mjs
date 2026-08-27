// Yjs WebSocket relay with LevelDB persistence.
// Single source of truth for collaborative state.

import http from 'http';
import fs from 'fs';
import { createRequire } from 'module';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

// yjs, y-leveldb, and y-websocket must all resolve to the SAME yjs module
// instance. y-websocket's bin/utils.js (below) is CJS and does
// `require('yjs')`, which its package.json "exports" map sends to
// dist/yjs.cjs. If we instead `import * as Y from 'yjs'` here, the "exports"
// map sends that to dist/yjs.mjs — a separate module with separate Item/GC/
// etc. classes. Structs created by one instance fail `instanceof` checks in
// the other's merge/sync code, silently corrupting a doc's struct store; it
// surfaces later as "Cannot read properties of undefined (reading 'splice')"
// once enough concurrent edits force a merge over the tainted region.
// Routing everything through this one `require` keeps it a single instance.
const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const ROOM_LOG_KEY = randomBytes(32);
const roomLogId = (docName) => createHmac('sha256', ROOM_LOG_KEY)
  .update(String(docName))
  .digest('hex')
  .slice(0, 12);

const rawDocNameFromRequest = (req) => (req.url || '/').slice(1).split('?')[0];
const docNameFromRequest = (req) => {
  const raw = rawDocNameFromRequest(req);
  if (raw === 'yjs') return 'yjs/';
  return raw.startsWith('yjs/') ? raw : `yjs/${raw}`;
};

// y-websocket v1 ships server utils at bin/utils.js but doesn't expose them
// in its package "exports" map, so we import the file directly.
const here = dirname(fileURLToPath(import.meta.url));
const utilsPath = resolve(here, 'node_modules/y-websocket/bin/utils.js');
const { setupWSConnection, setPersistence, docs, getYDoc } = await import(utilsPath);

// y-websocket calls syncProtocol.readSyncMessage without the optional
// errorHandler, so corrupt-state errors fall through to a console.error that
// doesn't include the doc name — we never know which room broke. y-websocket
// uses CJS `require('y-protocols/sync')`, which resolves to dist/sync.cjs and
// is cached, so mutating exports on the cached module reaches that call site.
const syncProtocol = require('y-protocols/sync');
const origReadSyncMessage = syncProtocol.readSyncMessage;
syncProtocol.readSyncMessage = (decoder, encoder, doc, origin) =>
  origReadSyncMessage(decoder, encoder, doc, origin, (err) =>
    console.error('[yjs] sync error', { docName: roomLogId(doc.name), msg: err.message }));

const PORT = Number(process.env.YJS_PORT || 1234);
const DB_DIR = process.env.YJS_DB_DIR || './yjs-db';

// Comma-separated allowlist of Origin headers permitted to open a WS.
// Empty (the default) disables the check, matching dev behaviour where
// localhost:5173 / 15173 talk to localhost:1234. In production set this to
// the public origin(s), e.g. `https://retro.example.com,http://localhost:4173`.
const ALLOWED_ORIGINS = (process.env.YJS_ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Per-connection token-bucket limits. Sustained 60 msg/s and 200 KB/s with
// a short burst, then the WS is closed with code 1008 (Policy Violation).
// Stops a malicious or runaway client from saturating yjs / LevelDB.
const RL_MAX_MSGS = 120;
const RL_REFILL_MSGS_PER_SEC = 60;
const RL_MAX_BYTES = 2_000_000;
const RL_REFILL_BYTES_PER_SEC = 200_000;

// Image uploads: bytes never touch the Yjs WS sync channel (which is what
// the token bucket above protects) — items reference an uploaded file by
// URL instead of embedding it, so a large image can't blow past RL_MAX_BYTES
// on every sync the way an embedded base64 data URL used to.
const UPLOADS_DIR = process.env.YJS_UPLOADS_DIR || './uploads';
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// SVG is intentionally excluded — same-origin user-uploaded SVG can embed
// <script>, a stored-XSS vector this stack has no sanitizer for.
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const EXT_CONTENT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const IMAGE_FILENAME_RE = /^[a-f0-9-]+\.(png|jpe?g|webp|gif)$/;

// Cheap magic-byte sniff — Content-Type is client-supplied and spoofable, so
// this guards against a mislabeled/malicious body before it's written to disk.
const matchesMagicBytes = (buf, mime) => {
  if (mime === 'image/png') return buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === 'image/jpeg') return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/gif') return buf.length >= 4 && buf.toString('ascii', 0, 3) === 'GIF';
  if (mime === 'image/webp') return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
};

// Separate per-IP token bucket for the upload route — the WS bucket above
// only covers traffic already inside a WS connection, not a plain HTTP POST.
const uploadBuckets = new Map();
const UPLOAD_RL_MAX = 10;
const UPLOAD_RL_REFILL_PER_SEC = 1;
const takeUploadToken = (ip) => {
  const now = Date.now();
  let b = uploadBuckets.get(ip);
  if (!b) { b = { tokens: UPLOAD_RL_MAX, last: now }; uploadBuckets.set(ip, b); }
  b.tokens = Math.min(UPLOAD_RL_MAX, b.tokens + (now - b.last) * UPLOAD_RL_REFILL_PER_SEC / 1000);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
};

const isAllowedOrigin = (origin) => !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin || '');

const handleUpload = (req, res) => {
  const origin = req.headers.origin || '';
  if (!isAllowedOrigin(origin)) { res.writeHead(403); res.end(); return; }
  // The client and yjs-server run on different ports in dev, so this is a
  // cross-origin POST with a non-safelisted Content-Type — the browser
  // preflights it and also requires this header on the actual response.
  res.setHeader('access-control-allow-origin', origin || '*');
  if (!takeUploadToken(req.socket.remoteAddress || 'unknown')) { res.writeHead(429); res.end(); return; }
  const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
  const ext = MIME_EXT[contentType];
  if (!ext) { res.writeHead(415, { 'content-type': 'text/plain' }); res.end('unsupported media type'); return; }
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD_BYTES) { res.writeHead(413); res.end(); return; }
  const chunks = [];
  let total = 0;
  let rejected = false;
  req.on('data', (chunk) => {
    if (rejected) return;
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) {
      rejected = true;
      res.writeHead(413);
      res.end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => { rejected = true; });
  req.on('end', () => {
    if (rejected) return;
    const buf = Buffer.concat(chunks);
    if (!matchesMagicBytes(buf, contentType)) {
      res.writeHead(422, { 'content-type': 'text/plain' });
      res.end('invalid image data');
      return;
    }
    const filename = `${randomUUID()}.${ext}`;
    fs.writeFile(join(UPLOADS_DIR, filename), buf, (err) => {
      if (err) {
        console.error('[yjs] upload write failed', { err: err.message });
        res.writeHead(500);
        res.end();
        return;
      }
      console.log('[yjs] upload stored', { filename, bytes: buf.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: `/images/${filename}` }));
    });
  });
};

const handleGetImage = (filename, res) => {
  if (!IMAGE_FILENAME_RE.test(filename)) { res.writeHead(404); res.end(); return; }
  fs.readFile(join(UPLOADS_DIR, filename), (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const ext = filename.split('.').pop();
    res.writeHead(200, {
      'content-type': EXT_CONTENT_TYPE[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  });
};

const ldb = new LeveldbPersistence(DB_DIR);

// Marks the one update we apply from disk during hydration, so the listener
// below can skip writing it straight back.
const HYDRATION_ORIGIN = Symbol('hydration');

// y-leveldb's _transact swallows every error: it catches, console.warn's the
// error, and resolves `null`. Its promises therefore NEVER reject, so a
// `.catch()` on any of these calls is dead code and a `.then()` runs even when
// the write failed. Each call has to be checked against its own success
// contract instead (verified in node_modules/y-leveldb/src/y-leveldb.js):
//   getYDoc       -> Y.Doc         | null on failure
//   storeUpdate   -> integer clock | null on failure
//   flushDocument -> undefined     | null on failure
const checkedGetYDoc = async (docName) => {
  const doc = await ldb.getYDoc(docName);
  if (!(doc instanceof Y.Doc)) throw new Error(`getYDoc failed: ${roomLogId(docName)}`);
  return doc;
};

const checkedStoreUpdate = async (docName, update) => {
  const clock = await ldb.storeUpdate(docName, update);
  if (!Number.isInteger(clock)) throw new Error(`storeUpdate failed: ${roomLogId(docName)}`);
  return clock;
};

const checkedClearDocument = async (docName) => {
  // Same contract as flushDocument: `undefined` on success, `null` on failure.
  const result = await ldb.clearDocument(docName);
  if (result === null) throw new Error(`clearDocument failed: ${roomLogId(docName)}`);
};

const checkedFlushDocument = async (docName) => {
  // A successful flush resolves `undefined` — the callback y-leveldb passes to
  // _transact has no return statement — so only a strict `null` means failure.
  // `if (!result)` would treat every success as an error here.
  const result = await ldb.flushDocument(docName);
  if (result === null) throw new Error(`flushDocument failed: ${roomLogId(docName)}`);
};

// Flipped by the first storage failure. The relay keeps serving connected
// clients from memory, but readiness reports unhealthy so an orchestrator
// stops sending it new traffic instead of silently accepting unpersisted work.
let storageFailure = null;
// Set by the signal handlers at the bottom of this file; checked in the
// upgrade path so a draining process stops taking on new rooms.
let shuttingDown = false;
const markStorageFailure = (err) => {
  if (!storageFailure) console.error('[yjs] storage degraded', { err: err.message });
  storageFailure = err;
};

// Hydration promise per room. y-websocket calls bindState without awaiting it
// and starts answering the sync protocol immediately, so a client connecting
// to a cold room is told "synced" against an empty doc while the LevelDB read
// is still in flight — it then sees a blank board and can write over real
// state. The upgrade handler awaits this before letting the socket through.
const roomReady = new WeakMap();

setPersistence({
  bindState: (docName, ydoc) => {
    // The listener must be registered BEFORE the first await. y-websocket
    // calls bindState without awaiting it, so the room already accepts and
    // broadcasts client updates while the LevelDB read is in flight. Any
    // update applied during that gap was never handed to storeUpdate — it
    // reaches every peer, then vanishes on the next server restart.
    ydoc.on('update', (u, origin) => {
      if (origin === HYDRATION_ORIGIN) return;
      checkedStoreUpdate(docName, u)
        // Only large updates are logged on success (routine edits are frequent
        // and would drown this out) — this exists to answer one question: does
        // an oversized diff (like the one behind the qckT236c rate-limit loop)
        // actually land in LevelDB, or silently fail to persist?
        .then(() => { if (u.byteLength > 100_000) console.log('[yjs] storeUpdate ok', { docName: roomLogId(docName), bytes: u.byteLength }); })
        .catch((err) => { markStorageFailure(err); console.error('[yjs] storeUpdate failed', { docName: roomLogId(docName), err: err.message }); });
    });
    // y-websocket calls bindState as a floating promise (bin/utils.js:149) with
    // no .catch(), so anything thrown here becomes an unhandled rejection and
    // kills the process. Contain it: record the failure, leave the room empty,
    // and let the readiness check refuse further traffic.
    const ready = (async () => {
      try {
        const persisted = await checkedGetYDoc(docName);
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), HYDRATION_ORIGIN);
      } catch (err) {
        markStorageFailure(err);
        console.error('[yjs] hydrate failed', { docName: roomLogId(docName), err: err.message });
      }
    })();
    // Runs before the IIFE's first await yields, so the entry is in place by
    // the time y-websocket's getYDoc returns this doc to the upgrade handler.
    roomReady.set(ydoc, ready);
    return ready;
  },
  // y-websocket invokes writeState in closeConn when the last client of a
  // room disconnects. flushDocument consolidates the LevelDB update log into
  // a single state entry, keeping on-disk size and reload cost bounded.
  // Rethrowing here would also be fatal: the caller does
  // `writeState(...).then(() => doc.destroy())` with no .catch()
  // (bin/utils.js:205), so the rejection would go unhandled.
  writeState: async (docName) => {
    try { await checkedFlushDocument(docName); }
    catch (err) {
      markStorageFailure(err);
      console.error('[yjs] flushDocument failed', { docName: roomLogId(docName), err: err.message });
    }
  },
  provider: ldb,
});

// One-shot wipe: set YJS_WIPE_DOCS=room1,room2 to clear corrupt docs from
// LevelDB at boot, then remove the env var on the next deploy.
const WIPE = (process.env.YJS_WIPE_DOCS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const name of WIPE) {
  // Top-level await: a failure here rejects module evaluation and exits
  // non-zero, which is what we want for a one-shot boot-time maintenance op —
  // far better than logging "wiped" for a document that is still corrupt.
  await checkedClearDocument(name);
  console.log('[yjs] wiped doc', roomLogId(name));
}

// One-shot migration: rewrite legacy base64-embedded image `src` fields
// (from before image uploads existed) to server-hosted files, same env-var-
// triggered pattern as YJS_WIPE_DOCS above. Runs through this process's own
// already-open `ldb` — a second LeveldbPersistence against the same DB_DIR
// while this server holds it open conflicts (`Iterator is not open`).
// Idempotent: migrated items no longer have a `data:` src, so re-running is
// a no-op. Irreversible CRDT surgery — back up the yjs_data volume first.
const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;
const MIGRATE = (process.env.YJS_MIGRATE_DOCS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const name of MIGRATE) {
  try {
    const ydoc = await checkedGetYDoc(name);
    const before = Y.encodeStateAsUpdate(ydoc).byteLength;
    const pendingUpdates = [];
    ydoc.on('update', (u) => pendingUpdates.push(u));
    let rewritten = 0;
    ydoc.transact(() => {
      ydoc.getMap('items').forEach((yItem) => {
        if (!(yItem instanceof Y.Map) || yItem.get('type') !== 'image') return;
        const src = yItem.get('src');
        const m = typeof src === 'string' && src.match(DATA_URL_RE);
        if (!m) return;
        const ext = MIME_EXT[m[1]];
        if (!ext) return;
        const filename = `${randomUUID()}.${ext}`;
        fs.writeFileSync(join(UPLOADS_DIR, filename), Buffer.from(m[2], 'base64'));
        yItem.set('src', `/images/${filename}`);
        rewritten += 1;
      });
    }, 'migration');
    for (const u of pendingUpdates) await checkedStoreUpdate(name, u);
    await checkedFlushDocument(name);
    const after = Y.encodeStateAsUpdate(ydoc).byteLength;
    console.log('[yjs] migrated doc', roomLogId(name), { rewritten, beforeBytes: before, afterBytes: after });
  } catch (err) {
    console.error('[yjs] migration failed', { docName: roomLogId(name), err: err.message });
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  // Cloudflare Tunnel forwards the /yjs prefix through unstripped in prod
  // (see docName parsing below); routes here need to answer at both /upload
  // and /yjs/upload so dev (bare path) and prod (tunnel prefix) both work.
  const routePath = pathname.replace(/^\/yjs(?=\/|$)/, '') || '/';
  // Readiness is separate from liveness: the process can be perfectly alive
  // while LevelDB is unwritable, and the catch-all below answers 200 either
  // way. An orchestrator polling this stops routing new traffic here instead
  // of accepting work the relay can no longer persist.
  if (req.method === 'GET' && routePath === '/readyz') {
    const ok = !storageFailure;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' });
    res.end(ok ? 'ready' : `storage degraded: ${storageFailure.message}`);
    return;
  }
  if (req.method === 'OPTIONS' && routePath === '/upload') {
    // Cross-origin POST with a non-safelisted Content-Type triggers a CORS
    // preflight (always true in dev, where the app and yjs-server are on
    // different ports) — without this, the browser blocks the real POST.
    const origin = req.headers.origin || '';
    if (!isAllowedOrigin(origin)) { res.writeHead(403); res.end(); return; }
    res.writeHead(204, {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }
  if (req.method === 'POST' && routePath === '/upload') { handleUpload(req, res); return; }
  if (req.method === 'GET' && routePath.startsWith('/images/')) { handleGetImage(routePath.slice('/images/'.length), res); return; }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('yjs-ws ok');
});

// maxPayload caps a single frame before `ws` assembles it, so an oversized
// frame is refused (close 1009) without ever reaching a 'message' listener.
// The token bucket alone cannot do this: its `return` only exits its own
// callback, and EventEmitter still delivers the frame to y-websocket's
// listener, which parses and applies it. RL_MAX_BYTES is the right ceiling —
// the bucket holds at most that many bytes, so a larger frame could never
// have been admitted anyway.
const wss = new WebSocketServer({ noServer: true, maxPayload: RL_MAX_BYTES });
wss.on('connection', (conn, req) => {
  const docName = docNameFromRequest(req);
  const logDocName = rawDocNameFromRequest(req) ? docName : '<root>';
  console.log('[yjs] conn open', { docName: roomLogId(logDocName), origin: req.headers.origin });
  // Token-bucket rate limit. Refill smoothly; over-budget closes the WS.
  const bucket = {
    msgs: RL_MAX_MSGS,
    bytes: RL_MAX_BYTES,
    last: Date.now(),
  };
  let limited = false;
  const takeTokens = (size) => {
    const now = Date.now();
    const dt = now - bucket.last;
    bucket.msgs = Math.min(RL_MAX_MSGS, bucket.msgs + dt * RL_REFILL_MSGS_PER_SEC / 1000);
    bucket.bytes = Math.min(RL_MAX_BYTES, bucket.bytes + dt * RL_REFILL_BYTES_PER_SEC / 1000);
    bucket.last = now;
    if (bucket.msgs < 1 || bucket.bytes < size) return false;
    bucket.msgs -= 1;
    bucket.bytes -= size;
    return true;
  };
  const before = new Set(conn.listeners('message'));
  setupWSConnection(conn, req, { docName, gc: true });
  const parsers = conn.listeners('message').filter((listener) => !before.has(listener));
  if (parsers.length !== 1) {
    console.error('[yjs] unexpected message-listener count', { docName: roomLogId(docName), count: parsers.length });
    conn.close(1011, 'server setup error');
    return;
  }
  const [parseYjsMessage] = parsers;
  conn.off('message', parseYjsMessage);
  conn.on('message', (data) => {
    if (limited) return;
    const size = data?.byteLength ?? data?.length ?? 0;
    if (!takeTokens(size)) {
      limited = true;
      console.warn('[yjs] rate-limit close', { docName: roomLogId(docName), origin: req.headers.origin, size });
      try { conn.close(1008, 'rate-limit'); } catch { /* already closing */ }
      return;
    }
    parseYjsMessage(data);
  });
});

server.on('upgrade', (req, socket, head) => {
  // Origin allowlist — set YJS_ALLOWED_ORIGINS in prod to lock the relay to
  // the public site. Browsers always send Origin on WS handshakes; non-browser
  // clients can spoof it but at least defeats opportunistic CSRF-style abuse
  // from a malicious site running a ws() in the user's tab.
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
    console.warn('[yjs] reject origin', origin);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  // Reject known-doomed upgrades before getYDoc can allocate and hydrate a
  // room that will never receive a connection.
  if (shuttingDown || storageFailure) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  // Use the same canonical name passed to setupWSConnection, so hydration and
  // the client attachment cannot diverge between bare and /yjs-prefixed paths.
  // getYDoc creates the room (running bindState) if this is the first client;
  // awaiting its hydration keeps the sync protocol from answering with an
  // empty doc. Rooms already in memory resolve immediately.
  const docName = docNameFromRequest(req);
  const hadDoc = docs.has(docName);
  const doc = getYDoc(docName, true);
  const createdForUpgrade = !hadDoc && docs.get(docName) === doc;
  // `handleUpgrade` returns normally when it rejects a malformed handshake,
  // without invoking its callback. Retire a room created for such an upgrade
  // when the raw socket closes; a successful upgrade removes this listener
  // before normal WebSocket connection lifecycle handling takes over.
  const cleanupUnattachedUpgrade = () => {
    if (createdForUpgrade && docs.get(docName) === doc && doc.conns.size === 0) {
      docs.delete(docName);
      roomReady.delete(doc);
      doc.destroy();
    }
  };
  if (createdForUpgrade) socket.once('close', cleanupUnattachedUpgrade);
  Promise.resolve(roomReady.get(doc))
    .then(() => {
      if (shuttingDown) throw new Error('shutting down');
      if (storageFailure) throw storageFailure;
      wss.handleUpgrade(req, socket, head, (ws) => {
        socket.off('close', cleanupUnattachedUpgrade);
        wss.emit('connection', ws, req);
      });
    })
    .catch((err) => {
      socket.off('close', cleanupUnattachedUpgrade);
      // A rejected first upgrade has no closeConn call to retire its room.
      // Match both identity and zero connections so an existing/replaced room,
      // or one another upgrade successfully attached to, is never destroyed.
      if (createdForUpgrade && docs.get(docName) === doc && doc.conns.size === 0) {
        docs.delete(docName);
        roomReady.delete(doc);
        doc.destroy();
      }
      console.error('[yjs] upgrade failed', { docName: roomLogId(docName), err: err.message });
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
});

// Graceful drain. Without this, `docker stop` kills the process while
// storeUpdate calls are still in flight and before y-websocket has had a
// chance to run writeState for the open rooms, so the last edits before a
// deploy are lost even though every client saw them.
const SHUTDOWN_TIMEOUT_MS = 20_000;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[yjs] draining', { signal, rooms: docs.size });
  // Force exit if a stuck LevelDB call would otherwise hold us past the
  // orchestrator's grace period and earn a SIGKILL mid-write.
  const hardStop = setTimeout(() => {
    console.error('[yjs] drain timed out — exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  hardStop.unref();
  try {
    server.close();
    // Snapshot before closing sockets: y-websocket deletes each room from
    // `docs` as its last connection goes away.
    const roomNames = [...docs.keys()];
    for (const conn of wss.clients) {
      try { conn.close(1001, 'server shutting down'); } catch { /* already closing */ }
    }
    // Redundant with y-websocket's own writeState, but that runs as a floating
    // promise we cannot await. flushDocument is idempotent consolidation.
    for (const name of roomNames) {
      try { await checkedFlushDocument(name); }
      catch (err) { console.error('[yjs] drain flush failed', { docName: roomLogId(name), err: err.message }); }
    }
    await ldb.destroy();
    console.log('[yjs] drained', { rooms: roomNames.length });
  } catch (err) {
    console.error('[yjs] drain failed', { err: err.message });
  }
  process.exit(0);
};
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[yjs] listening on ws://0.0.0.0:${PORT}  (db: ${DB_DIR})`);
  if (ALLOWED_ORIGINS.length) {
    console.log(`[yjs] origin allowlist: ${ALLOWED_ORIGINS.join(', ')}`);
  } else {
    console.log('[yjs] no origin check (set YJS_ALLOWED_ORIGINS in prod)');
  }
});
