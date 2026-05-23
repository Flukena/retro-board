// Yjs WebSocket relay with LevelDB persistence.
// Single source of truth for collaborative state.

import http from 'http';
import { createRequire } from 'module';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as Y from 'yjs';
import { LeveldbPersistence } from 'y-leveldb';

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
const require = createRequire(import.meta.url);
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

const ldb = new LeveldbPersistence(DB_DIR);
setPersistence({
  bindState: async (docName, ydoc) => {
    const persisted = await ldb.getYDoc(docName);
    const update = Y.encodeStateAsUpdate(persisted);
    Y.applyUpdate(ydoc, update);
    ydoc.on('update', (u) => {
      ldb.storeUpdate(docName, u).catch((err) =>
        console.error('[yjs] storeUpdate failed', { docName, err: err.message }));
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

const server = http.createServer((req, res) => {
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
      console.warn('[yjs] rate-limit close', { origin: req.headers.origin, size });
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
