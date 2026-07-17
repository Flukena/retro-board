// Yjs WebSocket relay with LevelDB persistence.
// Single source of truth for collaborative state.

import http from 'http';
import fs from 'fs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
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

// y-websocket v1 ships server utils at bin/utils.js but doesn't expose them
// in its package "exports" map, so we import the file directly.
const here = dirname(fileURLToPath(import.meta.url));
const utilsPath = resolve(here, 'node_modules/y-websocket/bin/utils.js');
const { setupWSConnection, setPersistence } = await import(utilsPath);

// y-websocket calls syncProtocol.readSyncMessage without the optional
// errorHandler, so corrupt-state errors fall through to a console.error that
// doesn't include the doc name — we never know which room broke. y-websocket
// uses CJS `require('y-protocols/sync')`, which resolves to dist/sync.cjs and
// is cached, so mutating exports on the cached module reaches that call site.
const syncProtocol = require('y-protocols/sync');
const origReadSyncMessage = syncProtocol.readSyncMessage;
syncProtocol.readSyncMessage = (decoder, encoder, doc, origin) =>
  origReadSyncMessage(decoder, encoder, doc, origin, (err) =>
    console.error('[yjs] sync error', { docName: doc.name, msg: err.message }));

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

const handleUpload = (req, res, searchParams) => {
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
  const docName = searchParams.get('doc') || '';
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
      console.log('[yjs] upload stored', { filename, bytes: buf.length, docName });
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
setPersistence({
  bindState: async (docName, ydoc) => {
    const persisted = await ldb.getYDoc(docName);
    const update = Y.encodeStateAsUpdate(persisted);
    Y.applyUpdate(ydoc, update);
    ydoc.on('update', (u) => {
      ldb.storeUpdate(docName, u)
        // Only large updates are logged on success (routine edits are frequent
        // and would drown this out) — this exists to answer one question: does
        // an oversized diff (like the one behind the qckT236c rate-limit loop)
        // actually land in LevelDB, or silently fail to persist?
        .then(() => { if (u.byteLength > 100_000) console.log('[yjs] storeUpdate ok', { docName, bytes: u.byteLength }); })
        .catch((err) => console.error('[yjs] storeUpdate failed', { docName, err: err.message }));
    });
  },
  // y-websocket invokes writeState in closeConn when the last client of a
  // room disconnects. flushDocument consolidates the LevelDB update log into
  // a single state entry, keeping on-disk size and reload cost bounded.
  writeState: async (docName) => { await ldb.flushDocument(docName); },
  provider: ldb,
});

// One-shot wipe: set YJS_WIPE_DOCS=room1,room2 to clear corrupt docs from
// LevelDB at boot, then remove the env var on the next deploy.
const WIPE = (process.env.YJS_WIPE_DOCS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const name of WIPE) {
  await ldb.clearDocument(name);
  console.log('[yjs] wiped doc', name);
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
    const ydoc = await ldb.getYDoc(name);
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
    for (const u of pendingUpdates) await ldb.storeUpdate(name, u);
    await ldb.flushDocument(name);
    const after = Y.encodeStateAsUpdate(ydoc).byteLength;
    console.log('[yjs] migrated doc', name, { rewritten, beforeBytes: before, afterBytes: after });
  } catch (err) {
    console.error('[yjs] migration failed', { docName: name, err: err.message });
  }
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  // Cloudflare Tunnel forwards the /yjs prefix through unstripped in prod
  // (see docName parsing below); routes here need to answer at both /upload
  // and /yjs/upload so dev (bare path) and prod (tunnel prefix) both work.
  const routePath = pathname.replace(/^\/yjs(?=\/|$)/, '') || '/';
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
  if (req.method === 'POST' && routePath === '/upload') { handleUpload(req, res, searchParams); return; }
  if (req.method === 'GET' && routePath.startsWith('/images/')) { handleGetImage(routePath.slice('/images/'.length), res); return; }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('yjs-ws ok');
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (conn, req) => {
  // y-websocket derives the doc name from the URL path (first segment after
  // the leading slash), so we parse it the same way for logging/correlation.
  const docName = (req.url || '/').slice(1).split('?')[0] || '<root>';
  console.log('[yjs] conn open', { docName, origin: req.headers.origin });
  // Token-bucket rate limit. Refill smoothly; over-budget closes the WS.
  const bucket = {
    msgs: RL_MAX_MSGS,
    bytes: RL_MAX_BYTES,
    last: Date.now(),
  };
  let limited = false;
  conn.on('message', (data) => {
    if (limited) return;
    const now = Date.now();
    const dt = now - bucket.last;
    bucket.msgs = Math.min(RL_MAX_MSGS, bucket.msgs + dt * RL_REFILL_MSGS_PER_SEC / 1000);
    bucket.bytes = Math.min(RL_MAX_BYTES, bucket.bytes + dt * RL_REFILL_BYTES_PER_SEC / 1000);
    bucket.last = now;
    const size = data?.byteLength ?? data?.length ?? 0;
    if (bucket.msgs < 1 || bucket.bytes < size) {
      limited = true;
      console.warn('[yjs] rate-limit close', { docName, origin: req.headers.origin, size });
      try { conn.close(1008, 'rate-limit'); } catch { /* already closing */ }
      return;
    }
    bucket.msgs -= 1;
    bucket.bytes -= size;
  });
  setupWSConnection(conn, req, { gc: true });
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
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[yjs] listening on ws://0.0.0.0:${PORT}  (db: ${DB_DIR})`);
  if (ALLOWED_ORIGINS.length) {
    console.log(`[yjs] origin allowlist: ${ALLOWED_ORIGINS.join(', ')}`);
  } else {
    console.log('[yjs] no origin check (set YJS_ALLOWED_ORIGINS in prod)');
  }
});
