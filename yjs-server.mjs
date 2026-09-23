// Yjs WebSocket relay with LevelDB persistence.
// Single source of truth for collaborative state.

import http from 'http';
import fs from 'fs';
import { createRequire } from 'module';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { geometryErrorForPatch } from './src/board-geometry.js';
import { planVoteFinalization } from './src/vote-finalization.js';

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
const decoding = require('lib0/decoding');

const ROOM_LOG_KEY = randomBytes(32);
const roomLogId = (docName) => createHmac('sha256', ROOM_LOG_KEY)
  .update(String(docName))
  .digest('hex')
  .slice(0, 12);

const envInt = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

const envBool = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`${name} must be one of: 1, 0, true, false, yes, no`);
};

const PORT = envInt('YJS_PORT', 1234, { min: 0, max: 65535 });
const HOST = process.env.YJS_HOST || '127.0.0.1';
if (!isIP(HOST)) throw new Error('YJS_HOST must be an IPv4 or IPv6 address');
const DB_DIR = process.env.YJS_DB_DIR || './yjs-db';
const ALLOW_LEGACY_ROOMS = envBool('YJS_ALLOW_LEGACY_ROOMS');
const ALLOW_LEGACY_URL_TOKENS = envBool('YJS_ALLOW_LEGACY_URL_TOKENS');
const ALLOW_INSECURE_HTTP = envBool('YJS_ALLOW_INSECURE_HTTP');
// Only enable this when the relay is reachable exclusively through a trusted
// reverse proxy. Otherwise a direct client can forge CF-Connecting-IP/XFF.
const TRUST_PROXY = envBool('YJS_TRUST_PROXY');

const BOARD_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const ROOM_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_HANDLE_RE = /^[A-Za-z0-9_-]{32}$/;
const TOKENIZED_ROOM_RE = /^board-[A-Za-z0-9_-]{3,32}-[A-Za-z0-9_-]{8,64}$/;
const LEGACY_ROOM_RE = /^board-[A-Za-z0-9_-]{3,32}$/;
const canonicalDocName = (code, token) => `yjs/board-${code}-${token}`;

// Accept the two paths WebsocketProvider uses in this repo:
//   dev  /board-<code>-<token>
//   prod /yjs/board-<code>-<token>
// Canonical persistence names retain the historic `yjs/` prefix. Arbitrary
// paths and tokenless rooms are rejected before a Y.Doc/LevelDB key exists.
const tokenDocNameFromRequest = (req) => {
  const target = req.url || '';
  if (!target.startsWith('/') || target.startsWith('//') || target.length > 256
      || target.includes('?') || target.includes('#')) return null;
  const rawRoom = target.startsWith('/yjs/') ? target.slice('/yjs/'.length) : target.slice(1);
  if (TOKENIZED_ROOM_RE.test(rawRoom)) return `yjs/${rawRoom}`;
  if (ALLOW_LEGACY_ROOMS && LEGACY_ROOM_RE.test(rawRoom)) return `yjs/${rawRoom}`;
  return null;
};

const roomTargetFromRequest = (req) => {
  const target = req.url || '';
  if (!target.startsWith('/') || target.startsWith('//') || target.length > 256
      || target.includes('#')) return null;
  const queryAt = target.indexOf('?');
  const path = queryAt < 0 ? target : target.slice(0, queryAt);
  const query = queryAt < 0 ? '' : target.slice(queryAt + 1);
  const match = path.match(/^\/(?:yjs\/)?rooms\/([A-Za-z0-9_-]{32})$/);
  if (!match) return null;
  if (query === '') return { handle: match[1], awarenessClientId: null };
  const awarenessMatch = query.match(/^awarenessId=(0|[1-9]\d{0,9})$/);
  if (!awarenessMatch) return null;
  const awarenessClientId = Number(awarenessMatch[1]);
  if (!Number.isSafeInteger(awarenessClientId) || awarenessClientId > 0xffffffff) return null;
  return { handle: match[1], awarenessClientId };
};

const normalizeIp = (value) => {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.startsWith('::ffff:') && isIP(candidate.slice(7)) === 4) candidate = candidate.slice(7);
  return isIP(candidate) ? candidate : null;
};

const clientIpFromRequest = (req) => {
  const socketIp = normalizeIp(req.socket?.remoteAddress) || 'unknown';
  if (!TRUST_PROXY) return socketIp;
  const cfIp = normalizeIp(Array.isArray(req.headers['cf-connecting-ip'])
    ? req.headers['cf-connecting-ip'][0]
    : req.headers['cf-connecting-ip']);
  if (cfIp) return cfIp;
  const forwarded = Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for'];
  return normalizeIp(typeof forwarded === 'string' ? forwarded.split(',')[0] : '') || socketIp;
};

const directorySizeSync = (root) => {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { total += fs.statSync(path).size; } catch { /* raced with compaction */ }
      }
    }
  }
  return total;
};

const loadSessionSigningKey = () => {
  const fromEnv = process.env.YJS_SESSION_SECRET;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'utf8');
    if (key.byteLength < 32) throw new Error('YJS_SESSION_SECRET must contain at least 32 bytes');
    return key;
  }
  fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  const keyPath = join(DB_DIR, '.room-session-key');
  const readKey = () => {
    const encoded = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error('invalid persisted room session key');
    const key = Buffer.from(encoded, 'base64url');
    if (key.byteLength !== 32) throw new Error('invalid persisted room session key');
    return key;
  };
  try {
    const key = readKey();
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort on mounted filesystems */ }
    return key;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const encoded = randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(keyPath, `${encoded}\n`, { flag: 'wx', mode: 0o600 });
    return Buffer.from(encoded, 'base64url');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return readKey();
  }
};

const SESSION_SIGNING_KEY = loadSessionSigningKey();

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
const awarenessProtocol = require('y-protocols/awareness');
const origReadSyncMessage = syncProtocol.readSyncMessage;
syncProtocol.readSyncMessage = (decoder, encoder, doc, origin) =>
  origReadSyncMessage(decoder, encoder, doc, origin, () => {
    console.warn('[yjs] invalid sync message', { docName: roomLogId(doc.name) });
    try { origin?.close?.(1008, 'invalid sync message'); } catch { /* already closing */ }
  });

// Comma-separated exact Origin allowlist. Empty is fail-closed unless the
// explicit dev-only YJS_ALLOW_INSECURE_HTTP flag is enabled, in which case
// only localhost/127.0.0.1 HTTP origins are accepted.
const ALLOWED_ORIGINS = (process.env.YJS_ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const origin of ALLOWED_ORIGINS) {
  let parsed;
  try { parsed = new URL(origin); }
  catch { throw new Error('YJS_ALLOWED_ORIGINS must contain exact URL origins'); }
  const localHttp = parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== origin
      || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash
      || (parsed.protocol !== 'https:' && !(ALLOW_INSECURE_HTTP && localHttp))) {
    throw new Error('YJS_ALLOWED_ORIGINS must contain exact HTTPS origins (or localhost HTTP in dev mode)');
  }
}

// Per-connection token-bucket limits. Sustained 60 msg/s and 200 KB/s with
// a short burst, then the WS is closed with code 1008 (Policy Violation).
// Stops a malicious or runaway client from saturating yjs / LevelDB.
const RL_MAX_MSGS = envInt('YJS_WS_BURST_MESSAGES', 120);
const RL_REFILL_MSGS_PER_SEC = envInt('YJS_WS_MESSAGES_PER_SECOND', 60);
const RL_MAX_BYTES = envInt('YJS_MAX_WS_MESSAGE_BYTES', 2_000_000, { min: 64 * 1024, max: 8 * 1024 * 1024 });
const RL_REFILL_BYTES_PER_SEC = envInt('YJS_WS_BYTES_PER_SECOND', 200_000);
const GLOBAL_RL_MAX_MSGS = envInt('YJS_GLOBAL_WS_BURST_MESSAGES', 1_000);
const GLOBAL_RL_REFILL_MSGS_PER_SEC = envInt('YJS_GLOBAL_WS_MESSAGES_PER_SECOND', 500);
const GLOBAL_RL_MAX_BYTES = envInt('YJS_GLOBAL_WS_BURST_BYTES', 20 * 1024 * 1024);
const GLOBAL_RL_REFILL_BYTES_PER_SEC = envInt('YJS_GLOBAL_WS_BYTES_PER_SECOND', 5 * 1024 * 1024);
const ROOM_RL_MAX_MSGS = envInt('YJS_ROOM_WS_BURST_MESSAGES', 300);
const ROOM_RL_REFILL_MSGS_PER_SEC = envInt('YJS_ROOM_WS_MESSAGES_PER_SECOND', 150);
const ROOM_RL_MAX_BYTES = envInt('YJS_ROOM_WS_BURST_BYTES', 8 * 1024 * 1024);
const ROOM_RL_REFILL_BYTES_PER_SEC = envInt('YJS_ROOM_WS_BYTES_PER_SECOND', 1024 * 1024);

const MAX_CONNECTIONS = envInt('YJS_MAX_CONNECTIONS', 512);
const MAX_CONNECTIONS_PER_IP = envInt('YJS_MAX_CONNECTIONS_PER_IP', 32);
const MAX_CONNECTIONS_PER_ROOM = envInt('YJS_MAX_CONNECTIONS_PER_ROOM', 64);
const MAX_ACTIVE_ROOMS = envInt('YJS_MAX_ACTIVE_ROOMS', 128);
const MAX_DOCUMENT_BYTES = envInt('YJS_MAX_DOCUMENT_BYTES', 32 * 1024 * 1024, {
  min: 64 * 1024,
  max: 64 * 1024 * 1024,
});
// A decoded Y.Doc can occupy several times its wire size on the JS heap.
// Bound all active rooms together instead of allowing MAX_ACTIVE_ROOMS
// individually-full documents to compete inside one container.
const MAX_ACTIVE_DOCUMENT_BYTES = envInt(
  'YJS_MAX_ACTIVE_DOCUMENT_BYTES',
  96 * 1024 * 1024,
  { min: MAX_DOCUMENT_BYTES, max: 512 * 1024 * 1024 },
);
const MAX_UPDATE_BYTES = envInt('YJS_MAX_UPDATE_BYTES', RL_MAX_BYTES, { min: 64 * 1024, max: RL_MAX_BYTES });
const MAX_PENDING_STORE_OPS = envInt('YJS_MAX_PENDING_STORE_OPS', 512);
const MAX_PENDING_STORE_BYTES = envInt('YJS_MAX_PENDING_STORE_BYTES', 32 * 1024 * 1024);
const MAX_DB_BYTES = envInt('YJS_MAX_DB_BYTES', 2 * 1024 * 1024 * 1024);
// A permitted full-document sync must fit this queue; otherwise the relay
// would send it and immediately classify that same recipient as slow. Global
// egress buckets still cap aggregate queued bytes across connections.
const MAX_WS_BUFFERED_BYTES = envInt(
  'YJS_MAX_WS_BUFFERED_BYTES',
  MAX_DOCUMENT_BYTES + 8 * 1024 * 1024,
  { min: MAX_DOCUMENT_BYTES, max: 72 * 1024 * 1024 },
);
const ROOM_COMPACT_AFTER_BYTES = envInt('YJS_ROOM_COMPACT_AFTER_BYTES', 8 * 1024 * 1024, {
  min: 64 * 1024,
  max: MAX_DB_BYTES,
});
const ROOM_COMPACT_AFTER_UPDATES = envInt('YJS_ROOM_COMPACT_AFTER_UPDATES', 128, { min: 2 });
const ROOM_MAX_UNCOMPACTED_UPDATES = envInt('YJS_ROOM_MAX_UNCOMPACTED_UPDATES', 4096, {
  min: ROOM_COMPACT_AFTER_UPDATES,
  max: 100_000,
});
const ROOM_COMPACTION_MIN_INTERVAL_MS = envInt(
  'YJS_ROOM_COMPACTION_MIN_INTERVAL_MS',
  60_000,
  { min: 1_000, max: 60 * 60 * 1000 },
);
const DOCUMENT_REMEASURE_MIN_INTERVAL_MS = envInt(
  'YJS_DOCUMENT_REMEASURE_MIN_INTERVAL_MS',
  60_000,
  { min: 1_000, max: 60 * 60 * 1000 },
);
const ROOM_MAX_UNCOMPACTED_BYTES = envInt('YJS_ROOM_MAX_UNCOMPACTED_BYTES', 24 * 1024 * 1024, {
  min: ROOM_COMPACT_AFTER_BYTES,
  max: MAX_DB_BYTES,
});
const MAX_STATE_VECTOR_BYTES = envInt('YJS_MAX_STATE_VECTOR_BYTES', 256 * 1024, {
  min: 1024,
  max: RL_MAX_BYTES,
});
const MAX_AWARENESS_MESSAGE_BYTES = envInt('YJS_MAX_AWARENESS_MESSAGE_BYTES', 128 * 1024, {
  min: 1024,
  max: RL_MAX_BYTES,
});
const MAX_AWARENESS_STATE_BYTES = envInt('YJS_MAX_AWARENESS_STATE_BYTES', 64 * 1024, {
  min: 256,
  max: MAX_AWARENESS_MESSAGE_BYTES,
});
const MAX_AWARENESS_IDS_PER_CONNECTION = envInt('YJS_MAX_AWARENESS_IDS_PER_CONNECTION', 1, {
  max: 4,
});
const MAX_AWARENESS_CLIENTS_PER_ROOM = envInt(
  'YJS_MAX_AWARENESS_CLIENTS_PER_ROOM',
  MAX_CONNECTIONS_PER_ROOM,
  { min: 1, max: MAX_CONNECTIONS_PER_ROOM },
);
// The server sends every active awareness state to a newly-connected client.
// Standard y-websocket clients echo that snapshot, so every server-produced
// snapshot must also fit the inbound awareness envelope. Reserve conservative
// framing space for the count, client IDs, clocks, and length prefixes.
const AWARENESS_FRAME_OVERHEAD_BYTES = 32 + MAX_AWARENESS_CLIENTS_PER_ROOM * 20;
const MAX_AWARENESS_ROOM_PAYLOAD_BYTES = MAX_AWARENESS_MESSAGE_BYTES
  - AWARENESS_FRAME_OVERHEAD_BYTES;
if (MAX_AWARENESS_ROOM_PAYLOAD_BYTES < MAX_AWARENESS_STATE_BYTES) {
  throw new Error(
    'YJS_MAX_AWARENESS_MESSAGE_BYTES is too small for the configured awareness state/client limits',
  );
}
const MAX_AWARENESS_ROOM_BYTES = envInt('YJS_MAX_AWARENESS_ROOM_BYTES', Math.min(
  120 * 1024,
  MAX_AWARENESS_ROOM_PAYLOAD_BYTES,
), {
  min: MAX_AWARENESS_STATE_BYTES,
  max: Math.min(32 * 1024 * 1024, MAX_AWARENESS_ROOM_PAYLOAD_BYTES),
});
const SYNC_RESPONSE_MIN_CHARGE_BYTES = envInt('YJS_SYNC_RESPONSE_MIN_CHARGE_BYTES', 64 * 1024, {
  min: 1024,
  max: MAX_DOCUMENT_BYTES,
});
const SYNC_RESPONSE_CONNECTION_BURST_BYTES = envInt(
  'YJS_SYNC_RESPONSE_CONNECTION_BURST_BYTES',
  Math.max(2 * MAX_DOCUMENT_BYTES, 8 * 1024 * 1024),
  { min: MAX_DOCUMENT_BYTES, max: 256 * 1024 * 1024 },
);
const SYNC_RESPONSE_ROOM_BURST_BYTES = envInt(
  'YJS_SYNC_RESPONSE_ROOM_BURST_BYTES',
  Math.max(2 * MAX_DOCUMENT_BYTES, 32 * 1024 * 1024),
  { min: MAX_DOCUMENT_BYTES, max: 512 * 1024 * 1024 },
);
const SYNC_RESPONSE_GLOBAL_BURST_BYTES = envInt(
  'YJS_SYNC_RESPONSE_GLOBAL_BURST_BYTES',
  Math.max(2 * MAX_DOCUMENT_BYTES, 64 * 1024 * 1024),
  { min: MAX_DOCUMENT_BYTES, max: 1024 * 1024 * 1024 },
);
const SYNC_RESPONSE_CONNECTION_BYTES_PER_SECOND = envInt(
  'YJS_SYNC_RESPONSE_CONNECTION_BYTES_PER_SECOND',
  1024 * 1024,
);
const SYNC_RESPONSE_ROOM_BYTES_PER_SECOND = envInt(
  'YJS_SYNC_RESPONSE_ROOM_BYTES_PER_SECOND',
  2 * 1024 * 1024,
);
const SYNC_RESPONSE_GLOBAL_BYTES_PER_SECOND = envInt(
  'YJS_SYNC_RESPONSE_GLOBAL_BYTES_PER_SECOND',
  8 * 1024 * 1024,
);
const SYNC_RESPONSE_CONNECTION_BURST_MESSAGES = envInt(
  'YJS_SYNC_RESPONSE_CONNECTION_BURST_MESSAGES', 2, { max: 32 },
);
const SYNC_RESPONSES_PER_CONNECTION_PER_MINUTE = envInt(
  'YJS_SYNC_RESPONSES_PER_CONNECTION_PER_MINUTE', 6, { max: 600 },
);
const WS_EGRESS_CONNECTION_BURST_BYTES = envInt(
  'YJS_WS_EGRESS_CONNECTION_BURST_BYTES',
  Math.max(MAX_DOCUMENT_BYTES + MAX_AWARENESS_ROOM_BYTES, 16 * 1024 * 1024),
  { min: MAX_DOCUMENT_BYTES, max: 256 * 1024 * 1024 },
);
const WS_EGRESS_ROOM_BURST_BYTES = envInt(
  'YJS_WS_EGRESS_ROOM_BURST_BYTES',
  Math.max(2 * MAX_DOCUMENT_BYTES, 32 * 1024 * 1024),
  { min: MAX_DOCUMENT_BYTES, max: 512 * 1024 * 1024 },
);
const WS_EGRESS_GLOBAL_BURST_BYTES = envInt(
  'YJS_WS_EGRESS_GLOBAL_BURST_BYTES',
  Math.max(2 * MAX_DOCUMENT_BYTES, 64 * 1024 * 1024),
  { min: MAX_DOCUMENT_BYTES, max: 1024 * 1024 * 1024 },
);
const WS_EGRESS_CONNECTION_BYTES_PER_SECOND = envInt(
  'YJS_WS_EGRESS_CONNECTION_BYTES_PER_SECOND',
  2 * 1024 * 1024,
);
const WS_EGRESS_ROOM_BYTES_PER_SECOND = envInt(
  'YJS_WS_EGRESS_ROOM_BYTES_PER_SECOND',
  8 * 1024 * 1024,
);
const WS_EGRESS_GLOBAL_BYTES_PER_SECOND = envInt(
  'YJS_WS_EGRESS_GLOBAL_BYTES_PER_SECOND',
  32 * 1024 * 1024,
);
const WS_EGRESS_CONNECTION_BURST_MESSAGES = envInt('YJS_WS_EGRESS_CONNECTION_BURST_MESSAGES', 256);
const WS_EGRESS_CONNECTION_MESSAGES_PER_SECOND = envInt('YJS_WS_EGRESS_CONNECTION_MESSAGES_PER_SECOND', 128);
const WS_EGRESS_ROOM_BURST_MESSAGES = envInt('YJS_WS_EGRESS_ROOM_BURST_MESSAGES', 1024);
const WS_EGRESS_ROOM_MESSAGES_PER_SECOND = envInt('YJS_WS_EGRESS_ROOM_MESSAGES_PER_SECOND', 512);
const WS_EGRESS_GLOBAL_BURST_MESSAGES = envInt('YJS_WS_EGRESS_GLOBAL_BURST_MESSAGES', 4096);
const WS_EGRESS_GLOBAL_MESSAGES_PER_SECOND = envInt('YJS_WS_EGRESS_GLOBAL_MESSAGES_PER_SECOND', 2048);
const MAX_REGISTERED_ROOMS = envInt('YJS_MAX_REGISTERED_ROOMS', 10_000);
const ROOM_SESSION_TTL_MS = envInt('YJS_ROOM_SESSION_TTL_SECONDS', 8 * 60 * 60, { min: 60, max: 7 * 24 * 60 * 60 }) * 1000;
const MAX_API_BODY_BYTES = envInt('YJS_MAX_API_BODY_BYTES', 1024, { min: 64, max: 16 * 1024 });
const MAX_COOKIE_HEADER_BYTES = envInt('YJS_MAX_COOKIE_HEADER_BYTES', 4096, { min: 256, max: 16 * 1024 });
const MAX_HEADER_BYTES = envInt('YJS_MAX_HEADER_BYTES', 8192, { min: 1024, max: 64 * 1024 });
const ROOM_CREATE_BURST = envInt('YJS_ROOM_CREATE_BURST', 3);
const ROOM_CREATES_PER_HOUR = envInt('YJS_ROOM_CREATES_PER_HOUR', 6);
const GLOBAL_ROOM_CREATE_BURST = envInt('YJS_GLOBAL_ROOM_CREATE_BURST', 30);
const GLOBAL_ROOM_CREATES_PER_MINUTE = envInt('YJS_GLOBAL_ROOM_CREATES_PER_MINUTE', 30);
const SESSION_EXCHANGE_BURST = envInt('YJS_SESSION_EXCHANGE_BURST', 30);
const SESSION_EXCHANGES_PER_MINUTE = envInt('YJS_SESSION_EXCHANGES_PER_MINUTE', 60);
const GLOBAL_SESSION_EXCHANGE_BURST = envInt('YJS_GLOBAL_SESSION_EXCHANGE_BURST', 300);
const GLOBAL_SESSION_EXCHANGES_PER_MINUTE = envInt('YJS_GLOBAL_SESSION_EXCHANGES_PER_MINUTE', 600);
const SESSION_FAILURE_BURST = envInt('YJS_SESSION_FAILURE_BURST', 10);
const SESSION_FAILURES_PER_HOUR = envInt('YJS_SESSION_FAILURES_PER_HOUR', 60);
const WS_UPGRADE_IP_BURST = envInt('YJS_WS_UPGRADE_IP_BURST', 40);
const WS_UPGRADES_PER_IP_PER_MINUTE = envInt('YJS_WS_UPGRADES_PER_IP_PER_MINUTE', 60);
const WS_UPGRADE_ROOM_BURST = envInt('YJS_WS_UPGRADE_ROOM_BURST', 20);
const WS_UPGRADES_PER_ROOM_PER_MINUTE = envInt('YJS_WS_UPGRADES_PER_ROOM_PER_MINUTE', 30);
const GLOBAL_WS_UPGRADE_BURST = envInt('YJS_GLOBAL_WS_UPGRADE_BURST', 200);
const GLOBAL_WS_UPGRADES_PER_MINUTE = envInt('YJS_GLOBAL_WS_UPGRADES_PER_MINUTE', 300);
// Opening a cold room decodes its full persisted CRDT, so it receives a much
// tighter budget than a warm peer joining an already-resident room.
const COLD_ROOM_OPEN_IP_BURST = envInt('YJS_COLD_ROOM_OPEN_IP_BURST', 4);
const COLD_ROOM_OPENS_PER_IP_PER_MINUTE = envInt('YJS_COLD_ROOM_OPENS_PER_IP_PER_MINUTE', 6);
const COLD_ROOM_OPEN_ROOM_BURST = envInt('YJS_COLD_ROOM_OPEN_ROOM_BURST', 2);
const COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE = envInt('YJS_COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE', 4);
const GLOBAL_COLD_ROOM_OPEN_BURST = envInt('YJS_GLOBAL_COLD_ROOM_OPEN_BURST', 16);
const GLOBAL_COLD_ROOM_OPENS_PER_MINUTE = envInt('YJS_GLOBAL_COLD_ROOM_OPENS_PER_MINUTE', 30);

const MAX_HTTP_REQUESTS = envInt('YJS_MAX_HTTP_REQUESTS', 128);
const MAX_HTTP_REQUESTS_PER_IP = envInt('YJS_MAX_HTTP_REQUESTS_PER_IP', 16);
const REQUEST_TIMEOUT_MS = envInt('YJS_REQUEST_TIMEOUT_MS', 30_000, { min: 1_000 });
const HEADERS_TIMEOUT_MS = envInt('YJS_HEADERS_TIMEOUT_MS', 10_000, { min: 1_000, max: REQUEST_TIMEOUT_MS });
const KEEP_ALIVE_TIMEOUT_MS = envInt('YJS_KEEP_ALIVE_TIMEOUT_MS', 5_000, { min: 1_000 });
const UPGRADE_TIMEOUT_MS = envInt('YJS_UPGRADE_TIMEOUT_MS', 10_000, { min: 1_000 });
const SHUTDOWN_TIMEOUT_MS = 20_000;
const HTTP_SHUTDOWN_GRACE_MS = envInt('YJS_HTTP_SHUTDOWN_GRACE_MS', 5_000, {
  min: 100,
  max: 15_000,
});

// Image uploads: bytes never touch the Yjs WS sync channel (which is what
// the token bucket above protects) — items reference an uploaded file by
// URL instead of embedding it, so a large image can't blow past RL_MAX_BYTES
// on every sync the way an embedded base64 data URL used to.
const UPLOADS_DIR = process.env.YJS_UPLOADS_DIR || './uploads';
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const MAX_UPLOAD_BYTES = envInt('YJS_MAX_UPLOAD_BYTES', 5 * 1024 * 1024, { min: 1024, max: 20 * 1024 * 1024 });
const MAX_ACTIVE_UPLOADS = envInt('YJS_MAX_ACTIVE_UPLOADS', 8);
const MAX_ACTIVE_UPLOADS_PER_IP = envInt('YJS_MAX_ACTIVE_UPLOADS_PER_IP', 2);
const MAX_UPLOAD_STORAGE_BYTES = envInt('YJS_MAX_UPLOAD_STORAGE_BYTES', 512 * 1024 * 1024, { min: MAX_UPLOAD_BYTES });
const MAX_UPLOAD_FILES = envInt('YJS_MAX_UPLOAD_FILES', 10_000);
const MAX_ROOM_UPLOAD_BYTES = envInt('YJS_MAX_ROOM_UPLOAD_BYTES', 64 * 1024 * 1024, { min: MAX_UPLOAD_BYTES, max: MAX_UPLOAD_STORAGE_BYTES });
const MAX_ROOM_UPLOAD_FILES = envInt('YJS_MAX_ROOM_UPLOAD_FILES', 1_000, { max: MAX_UPLOAD_FILES });
const UPLOAD_RETENTION_DAYS = envInt('YJS_UPLOAD_RETENTION_DAYS', 0, { min: 0, max: 3650 });
const IMAGE_READ_BURST = envInt('YJS_IMAGE_READ_BURST', 64);
const IMAGE_READS_PER_SECOND = envInt('YJS_IMAGE_READS_PER_SECOND', 16);
const IMAGE_READ_BURST_BYTES = envInt('YJS_IMAGE_READ_BURST_BYTES', 256 * 1024 * 1024);
const IMAGE_READ_BYTES_PER_SECOND = envInt('YJS_IMAGE_READ_BYTES_PER_SECOND', 32 * 1024 * 1024);
const ROOM_IMAGE_READ_BURST = envInt('YJS_ROOM_IMAGE_READ_BURST', 128);
const ROOM_IMAGE_READS_PER_SECOND = envInt('YJS_ROOM_IMAGE_READS_PER_SECOND', 32);
const ROOM_IMAGE_READ_BURST_BYTES = envInt('YJS_ROOM_IMAGE_READ_BURST_BYTES', 512 * 1024 * 1024);
const ROOM_IMAGE_READ_BYTES_PER_SECOND = envInt('YJS_ROOM_IMAGE_READ_BYTES_PER_SECOND', 64 * 1024 * 1024);
const GLOBAL_IMAGE_READ_BURST = envInt('YJS_GLOBAL_IMAGE_READ_BURST', 512);
const GLOBAL_IMAGE_READS_PER_SECOND = envInt('YJS_GLOBAL_IMAGE_READS_PER_SECOND', 128);
const GLOBAL_IMAGE_READ_BURST_BYTES = envInt('YJS_GLOBAL_IMAGE_READ_BURST_BYTES', 1024 * 1024 * 1024);
const GLOBAL_IMAGE_READ_BYTES_PER_SECOND = envInt('YJS_GLOBAL_IMAGE_READ_BYTES_PER_SECOND', 128 * 1024 * 1024);
const BUCKET_TTL_MS = envInt('YJS_BUCKET_TTL_MS', 10 * 60 * 1000, { min: 10_000 });
const MAX_BUCKETS = envInt('YJS_MAX_RATE_LIMIT_BUCKETS', 10_000);
// SVG is intentionally excluded — same-origin user-uploaded SVG can embed
// <script>, a stored-XSS vector this stack has no sanitizer for.
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const EXT_CONTENT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const IMAGE_ID_RE = /^[a-f0-9-]+\.(png|jpe?g|webp|gif)$/;
const LEGACY_IMAGE_FILENAME_RE = IMAGE_ID_RE;
const ROOM_IMAGE_FILENAME_RE = /^[A-Za-z0-9_-]{32}\.[a-f0-9-]+\.(png|jpe?g|webp|gif)$/;
const isStoredImageFilename = (name) => (
  LEGACY_IMAGE_FILENAME_RE.test(name) || ROOM_IMAGE_FILENAME_RE.test(name)
);

// Cheap magic-byte sniff — Content-Type is client-supplied and spoofable, so
// this guards against a mislabeled/malicious body before it's written to disk.
const matchesMagicBytes = (buf, mime) => {
  if (mime === 'image/png') return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/gif') return buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6));
  if (mime === 'image/webp') return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
};

// Separate per-IP token bucket for the upload route — the WS bucket above
// only covers traffic already inside a WS connection, not a plain HTTP POST.
const uploadBuckets = new Map();
const UPLOAD_RL_MAX = envInt('YJS_UPLOAD_BURST', 10);
const UPLOAD_RL_REFILL_PER_SEC = envInt('YJS_UPLOADS_PER_SECOND', 1);
const takeUploadToken = (ip) => {
  const now = Date.now();
  let b = uploadBuckets.get(ip);
  if (!b) {
    if (uploadBuckets.size >= MAX_BUCKETS) {
      let oldestKey;
      let oldest = Infinity;
      for (const [key, value] of uploadBuckets) {
        if (value.lastSeen < oldest) { oldest = value.lastSeen; oldestKey = key; }
      }
      if (oldestKey !== undefined) uploadBuckets.delete(oldestKey);
    }
    b = { tokens: UPLOAD_RL_MAX, last: now, lastSeen: now };
    uploadBuckets.set(ip, b);
  }
  b.tokens = Math.min(UPLOAD_RL_MAX, b.tokens + (now - b.last) * UPLOAD_RL_REFILL_PER_SEC / 1000);
  b.last = now;
  b.lastSeen = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
};

const isExactAllowedOrigin = (origin) => {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  return ALLOW_INSECURE_HTTP
    && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(origin);
};

const setCredentialCors = (origin, res) => {
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('vary', 'Origin');
};

const scanUploadUsage = () => {
  let bytes = 0;
  let files = 0;
  let complete = true;
  const roomsByHandle = new Map();
  let entries = [];
  try { entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true }); }
  catch (err) {
    console.error('[yjs] upload usage scan failed', { err: err.message });
    return { bytes: MAX_UPLOAD_STORAGE_BYTES, files: MAX_UPLOAD_FILES, roomsByHandle, complete: false };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const size = fs.statSync(join(UPLOADS_DIR, entry.name)).size;
      bytes += size;
      if (!isStoredImageFilename(entry.name)) continue;
      files += 1;
      if (ROOM_IMAGE_FILENAME_RE.test(entry.name)) {
        const handle = entry.name.slice(0, 32);
        const room = roomsByHandle.get(handle) || { bytes: 0, files: 0 };
        room.bytes += size;
        room.files += 1;
        roomsByHandle.set(handle, room);
      }
    } catch (err) {
      complete = false;
      console.error('[yjs] upload file stat failed', { fileId: roomLogId(entry.name), err: err.message });
    }
  }
  if (!complete) {
    return { bytes: MAX_UPLOAD_STORAGE_BYTES, files: MAX_UPLOAD_FILES, roomsByHandle, complete: false };
  }
  return { bytes, files, roomsByHandle, complete: true };
};

const initialUploadUsage = scanUploadUsage();
let { bytes: uploadUsageBytes, files: uploadFileCount } = initialUploadUsage;
let uploadReservedBytes = 0;
let activeUploads = 0;
const activeUploadsByIp = new Map();

const releaseUpload = (ip, reservedBytes, docName) => {
  activeUploads = Math.max(0, activeUploads - 1);
  uploadReservedBytes = Math.max(0, uploadReservedBytes - reservedBytes);
  const next = (activeUploadsByIp.get(ip) || 1) - 1;
  if (next > 0) activeUploadsByIp.set(ip, next);
  else activeUploadsByIp.delete(ip);
  const room = roomUploadUsage.get(docName);
  if (room) {
    room.active = Math.max(0, room.active - 1);
    room.reservedBytes = Math.max(0, room.reservedBytes - reservedBytes);
  }
};

const uploadError = (code, message) => Object.assign(new Error(message), { code });

const handleUpload = async (req, res, clientIp, docName, roomHandle) => {
  const origin = req.headers.origin || '';
  if (!isExactAllowedOrigin(origin)) { res.writeHead(403); res.end(); return; }
  // The client and yjs-server run on different ports in dev, so this is a
  // cross-origin POST with a non-safelisted Content-Type — the browser
  // preflights it and also requires this header on the actual response.
  setCredentialCors(origin, res);
  if (!takeUploadToken(clientIp)) { res.writeHead(429); res.end(); return; }
  const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
  const ext = MIME_EXT[contentType];
  if (!ext) { res.writeHead(415, { 'content-type': 'text/plain' }); res.end('unsupported media type'); return; }
  const rawLength = req.headers['content-length'];
  if (rawLength != null && !/^\d+$/.test(String(rawLength))) { res.writeHead(400); res.end(); return; }
  const declaredLength = rawLength == null ? null : Number(rawLength);
  if (declaredLength != null && declaredLength > MAX_UPLOAD_BYTES) { res.writeHead(413); res.end(); return; }

  if (activeUploads >= MAX_ACTIVE_UPLOADS
      || (activeUploadsByIp.get(clientIp) || 0) >= MAX_ACTIVE_UPLOADS_PER_IP) {
    res.writeHead(429, { 'retry-after': '2' });
    res.end();
    return;
  }
  const reservedBytes = declaredLength ?? MAX_UPLOAD_BYTES;
  const room = roomUploadUsage.get(docName);
  if (!room) { res.writeHead(404); res.end(); return; }
  if (uploadFileCount + activeUploads >= MAX_UPLOAD_FILES
      || uploadUsageBytes + uploadReservedBytes + reservedBytes > MAX_UPLOAD_STORAGE_BYTES) {
    res.writeHead(507, { 'content-type': 'text/plain' });
    res.end('upload capacity reached');
    return;
  }
  if (room.files + room.active >= MAX_ROOM_UPLOAD_FILES
      || room.bytes + room.reservedBytes + reservedBytes > MAX_ROOM_UPLOAD_BYTES) {
    res.writeHead(507, { 'content-type': 'text/plain' });
    res.end('room upload capacity reached');
    return;
  }

  activeUploads += 1;
  activeUploadsByIp.set(clientIp, (activeUploadsByIp.get(clientIp) || 0) + 1);
  uploadReservedBytes += reservedBytes;
  room.active += 1;
  room.reservedBytes += reservedBytes;

  const id = randomUUID();
  const imageId = `${id}.${ext}`;
  const filename = `${roomHandle}.${imageId}`;
  const tempPath = join(UPLOADS_DIR, `.upload-${id}.tmp`);
  const finalPath = join(UPLOADS_DIR, filename);
  let total = 0;
  let prefix = Buffer.alloc(0);
  let published = false;
  let accounted = false;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        callback(uploadError('UPLOAD_TOO_LARGE', 'upload too large'));
        return;
      }
      if (prefix.length < 12) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
      }
      callback(null, chunk);
    },
  });

  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    req.destroy(uploadError('UPLOAD_TIMEOUT', 'upload timeout'));
  }, REQUEST_TIMEOUT_MS);
  deadline.unref();

  try {
    await pipeline(
      req,
      meter,
      fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
    );
    if (!matchesMagicBytes(prefix, contentType)) throw uploadError('INVALID_IMAGE', 'invalid image data');
    // Reservation prevents concurrent uploads from racing this check. The
    // rename stays within UPLOADS_DIR, so publication is atomic.
    await fs.promises.rename(tempPath, finalPath);
    published = true;
    uploadUsageBytes += total;
    uploadFileCount += 1;
    room.bytes += total;
    room.files += 1;
    accounted = true;
    try {
      await checkedSetMeta(docName, ROOM_UPLOAD_USAGE_META, { bytes: room.bytes, files: room.files });
    } catch (err) {
      markStorageFailure(err);
      throw uploadError('UPLOAD_META', 'upload accounting failed');
    }
    console.log('[yjs] upload stored', { fileId: roomLogId(filename), bytes: total });
    res.writeHead(200, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify({ url: `/rooms/${roomHandle}/images/${imageId}` }));
  } catch (err) {
    if (published && err.code === 'UPLOAD_META') {
      let removed = false;
      try {
        await fs.promises.unlink(finalPath);
        removed = true;
      } catch (cleanupErr) {
        if (cleanupErr.code === 'ENOENT') removed = true;
        else console.error('[yjs] upload publish rollback failed', {
          fileId: roomLogId(filename),
          err: cleanupErr.message,
        });
      }
      // Keep accounting conservative if the published file could not be
      // removed; startup reconciliation will preserve the same usage. Only a
      // confirmed removal is safe to subtract from the in-memory totals.
      if (removed && accounted) {
        uploadUsageBytes = Math.max(0, uploadUsageBytes - total);
        uploadFileCount = Math.max(0, uploadFileCount - 1);
        room.bytes = Math.max(0, room.bytes - total);
        room.files = Math.max(0, room.files - 1);
        accounted = false;
      }
    }
    try { await fs.promises.unlink(tempPath); } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') console.warn('[yjs] upload temp cleanup failed', { err: cleanupErr.message });
    }
    if (res.destroyed || req.destroyed && timedOut) return;
    if (err.code === 'UPLOAD_TOO_LARGE') res.writeHead(413);
    else if (err.code === 'INVALID_IMAGE') res.writeHead(422, { 'content-type': 'text/plain' });
    else if (err.code === 'UPLOAD_TIMEOUT' || timedOut) res.writeHead(408);
    else {
      console.error('[yjs] upload write failed', { err: err.message });
      res.writeHead(500);
    }
    res.end(err.code === 'INVALID_IMAGE' ? 'invalid image data' : undefined);
  } finally {
    clearTimeout(deadline);
    releaseUpload(clientIp, reservedBytes, docName);
  }
};

const streamImage = (filename, req, res, cacheControl, roomKey) => {
  const path = join(UPLOADS_DIR, filename);
  fs.stat(path, (err, stat) => {
    if (res.destroyed || res.writableEnded) return;
    if (err || !stat.isFile()) { res.writeHead(404); res.end(); return; }
    if (!takeImageReadBudget(clientIpFromRequest(req), roomKey, stat.size)) {
      res.writeHead(429, { 'retry-after': '2', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const ext = filename.split('.').pop();
    res.writeHead(200, {
      'content-type': EXT_CONTENT_TYPE[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
    });
    const stream = fs.createReadStream(path);
    const abortStream = () => stream.destroy();
    res.once('close', abortStream);
    void pipeline(stream, res)
      .catch(() => { if (!res.destroyed) res.destroy(); })
      .finally(() => res.off('close', abortStream));
  });
};

const handleGetLegacyImage = (filename, req, res) => {
  if (!LEGACY_IMAGE_FILENAME_RE.test(filename)) { res.writeHead(404); res.end(); return; }
  streamImage(filename, req, res, 'public, max-age=31536000, immutable', 'legacy');
};

const handleGetRoomImage = (roomHandle, imageId, req, res) => {
  if (!ROOM_HANDLE_RE.test(roomHandle) || !IMAGE_ID_RE.test(imageId)) {
    res.writeHead(404);
    res.end();
    return;
  }
  streamImage(`${roomHandle}.${imageId}`, req, res, 'private, no-store', roomHandle);
};

const ldb = new LeveldbPersistence(DB_DIR);
let dbUsageBytes = directorySizeSync(DB_DIR);
let pendingStoreOps = 0;
let pendingStoreBytes = 0;

// Marks the one update we apply from disk during hydration, so the listener
// below can skip writing it straight back.
const HYDRATION_ORIGIN = Symbol('hydration');

const storageOperationError = (message) => Object.assign(new Error(message), {
  code: 'STORAGE_FAILURE',
});

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
  if (!(doc instanceof Y.Doc)) throw storageOperationError(`getYDoc failed: ${roomLogId(docName)}`);
  return doc;
};

const checkedStoreUpdate = async (docName, update) => {
  const clock = await ldb.storeUpdate(docName, update);
  if (!Number.isInteger(clock)) throw storageOperationError(`storeUpdate failed: ${roomLogId(docName)}`);
  return clock;
};

const checkedClearDocument = async (docName) => {
  // Same contract as flushDocument: `undefined` on success, `null` on failure.
  const result = await ldb.clearDocument(docName);
  if (result === null) throw storageOperationError(`clearDocument failed: ${roomLogId(docName)}`);
};

const checkedFlushDocument = async (docName) => {
  // A successful flush resolves `undefined` — the callback y-leveldb passes to
  // _transact has no return statement — so only a strict `null` means failure.
  // `if (!result)` would treat every success as an error here.
  const result = await ldb.flushDocument(docName);
  if (result === null) throw storageOperationError(`flushDocument failed: ${roomLogId(docName)}`);
};

const checkedGetAllDocNames = async () => {
  const names = await ldb.getAllDocNames();
  if (!Array.isArray(names)) throw storageOperationError('getAllDocNames failed');
  return names;
};

const checkedGetMeta = async (docName, key) => {
  const value = await ldb.getMeta(docName, key);
  if (value === null) throw storageOperationError(`getMeta failed: ${roomLogId(docName)}`);
  return value;
};

const checkedSetMeta = async (docName, key, value) => {
  const result = await ldb.setMeta(docName, key, value);
  if (result === null) throw storageOperationError(`setMeta failed: ${roomLogId(docName)}`);
};

// One-shot wipe/retirement runs before room registration. If registration ran
// first, the old capability would remain in the in-memory maps and could mint
// a session that recreated the just-cleared document.
const WIPE = (process.env.YJS_WIPE_DOCS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const name of WIPE) {
  await checkedClearDocument(name);
  console.log('[yjs] wiped doc', roomLogId(name));
}

const ROOM_REGISTRATION_META = 'retro-room-registration-v1';
const ROOM_UPLOAD_USAGE_META = 'retro-room-upload-usage-v1';
const ROOM_HANDLE_META = 'retro-room-handle-v1';
const registeredDocs = new Set();
const registeredDocDigests = new Map();
const registeredRoomsByHandle = new Map();
const registeredRoomHandlesByDoc = new Map();
const roomUploadUsage = new Map();
const pendingRoomHandles = new Set();
let pendingRoomCreations = 0;
const existingDocNames = new Set(await checkedGetAllDocNames());

const newUniqueRoomHandle = () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const handle = randomBytes(24).toString('base64url');
    if (!registeredRoomsByHandle.has(handle) && !pendingRoomHandles.has(handle)) return handle;
  }
  throw Object.assign(new Error('room handle generation failed'), { code: 'SERVER_UNAVAILABLE' });
};

const roomHandleForDoc = (docName) => registeredRoomHandlesByDoc.get(docName) || null;

const docRegistrationDigest = (docName) => createHmac('sha256', SESSION_SIGNING_KEY)
  .update('room-registration\0')
  .update(docName)
  .digest();

const registerDocInMemory = (docName, handle) => {
  if (!ROOM_HANDLE_RE.test(handle)) throw new Error('invalid persisted room handle');
  const prior = registeredRoomsByHandle.get(handle);
  if (prior && prior !== docName) throw new Error('room handle collision');
  registeredDocs.add(docName);
  registeredDocDigests.set(docName, docRegistrationDigest(docName));
  registeredRoomsByHandle.set(handle, docName);
  registeredRoomHandlesByDoc.set(docName, handle);
  return handle;
};

const tokenizedExistingDocs = [...existingDocNames].filter((name) => (
  name.startsWith('yjs/') && TOKENIZED_ROOM_RE.test(name.slice('yjs/'.length))
));
for (const docName of tokenizedExistingDocs) {
  // A document is reachable only after room creation writes this final commit
  // marker. Older code adopted every token-shaped LevelDB key, which turned a
  // partial failed creation into a permanent room whose capability was never
  // delivered to a user. Leave incomplete documents quarantined instead.
  if ((await checkedGetMeta(docName, ROOM_REGISTRATION_META)) !== 1) {
    console.warn('[yjs] quarantined incomplete room', { docName: roomLogId(docName) });
    continue;
  }
  if (registeredDocs.size >= MAX_REGISTERED_ROOMS) {
    throw new Error('existing room count exceeds YJS_MAX_REGISTERED_ROOMS');
  }
  let roomHandle = await checkedGetMeta(docName, ROOM_HANDLE_META);
  if (!ROOM_HANDLE_RE.test(roomHandle || '')) {
    roomHandle = newUniqueRoomHandle();
    await checkedSetMeta(docName, ROOM_HANDLE_META, roomHandle);
  }
  registerDocInMemory(docName, roomHandle);
  const storedUsage = await checkedGetMeta(docName, ROOM_UPLOAD_USAGE_META);
  const persistedBytes = Number.isSafeInteger(storedUsage?.bytes) && storedUsage.bytes >= 0 ? storedUsage.bytes : 0;
  const persistedFiles = Number.isSafeInteger(storedUsage?.files) && storedUsage.files >= 0 ? storedUsage.files : 0;
  const actualUsage = initialUploadUsage.roomsByHandle.get(roomHandle) || { bytes: 0, files: 0 };
  const bytes = initialUploadUsage.complete ? actualUsage.bytes : persistedBytes;
  const files = initialUploadUsage.complete ? actualUsage.files : persistedFiles;
  if (initialUploadUsage.complete && (bytes !== persistedBytes || files !== persistedFiles)) {
    await checkedSetMeta(docName, ROOM_UPLOAD_USAGE_META, { bytes, files });
    console.warn('[yjs] reconciled room upload usage', {
      docName: roomLogId(docName),
      bytes,
      files,
    });
  }
  roomUploadUsage.set(docName, { bytes, files, reservedBytes: 0, active: 0 });
}
dbUsageBytes = directorySizeSync(DB_DIR);

// Flipped by the first storage failure. Existing clients are closed as well as
// refusing new upgrades: otherwise they would continue seeing edits that can
// no longer be persisted and lose them at the next restart.
let storageFailure = null;
// Set by the signal handlers at the bottom of this file; checked in the
// upgrade path so a draining process stops taking on new rooms.
let shuttingDown = false;
const markStorageFailure = (err) => {
  if (!storageFailure) {
    console.error('[yjs] storage degraded', { err: err.message });
    setImmediate(() => {
      for (const doc of docs.values()) {
        for (const conn of doc.conns.keys()) {
          try { conn.close(1011, 'storage unavailable'); } catch { /* already closing */ }
        }
      }
    });
  }
  storageFailure = err;
};

const reconcileUploadUsage = async () => {
  const scanned = scanUploadUsage();
  uploadUsageBytes = scanned.bytes;
  uploadFileCount = scanned.files;
  if (!scanned.complete) return;
  for (const [roomHandle, docName] of registeredRoomsByHandle) {
    const room = roomUploadUsage.get(docName);
    if (!room) continue;
    const actual = scanned.roomsByHandle.get(roomHandle) || { bytes: 0, files: 0 };
    if (room.bytes === actual.bytes && room.files === actual.files) continue;
    room.bytes = actual.bytes;
    room.files = actual.files;
    await checkedSetMeta(docName, ROOM_UPLOAD_USAGE_META, actual);
    console.warn('[yjs] reconciled room upload usage', {
      docName: roomLogId(docName),
      bytes: actual.bytes,
      files: actual.files,
    });
  }
};

if (dbUsageBytes > MAX_DB_BYTES) {
  markStorageFailure(new Error('configured database quota exceeded'));
}

// `upperBytes` is a conservative in-memory document bound. It starts at the
// exact hydrated size and grows by each accepted update until a separately
// throttled measurement refreshes it. This avoids synchronously encoding a
// near-limit document on every tiny edit or every persistence compaction.
const roomUsage = new WeakMap();
const destroyedDocs = new WeakSet();
const capacityRejectedDocs = new WeakSet();
let activeDocumentBytes = 0;

const projectedActiveDocumentBytes = (ydoc, nextUpperBytes) => {
  const previous = roomUsage.get(ydoc);
  return Math.max(0, activeDocumentBytes - (previous?.upperBytes || 0) + nextUpperBytes);
};

const commitRoomUsage = (ydoc, nextUsage) => {
  activeDocumentBytes = projectedActiveDocumentBytes(ydoc, nextUsage.upperBytes);
  roomUsage.set(ydoc, nextUsage);
};

const tryCommitRoomUsage = (ydoc, nextUsage) => {
  if (projectedActiveDocumentBytes(ydoc, nextUsage.upperBytes) > MAX_ACTIVE_DOCUMENT_BYTES) {
    return false;
  }
  commitRoomUsage(ydoc, nextUsage);
  return true;
};

const releaseRoomUsage = (ydoc) => {
  const previous = roomUsage.get(ydoc);
  if (!previous) return;
  activeDocumentBytes = Math.max(0, activeDocumentBytes - previous.upperBytes);
  roomUsage.delete(ydoc);
};
// A small current Y.Doc can still have a very large LevelDB update log (for
// example repeated insert/delete cycles). Track that write amplification
// independently and compact while peers remain connected instead of waiting
// for the last socket to leave.
const roomPersistenceChurn = new Map();
const persistenceChurnFor = (docName) => {
  let state = roomPersistenceChurn.get(docName);
  if (!state) {
    state = {
      uncompactedBytes: 0,
      uncompactedUpdates: 0,
      compactionPromise: null,
      compactionTimer: null,
      compactionTimerDueAt: 0,
      // Permit one prompt compaction after process start, then enforce the
      // cooldown. Cold-open budgets bound how often an attacker can reset
      // this state by cycling rooms, while legitimate first edits stay fluid.
      lastCompactedAt: 0,
      remeasureRequested: false,
    };
    roomPersistenceChurn.set(docName, state);
  }
  return state;
};
const blockedRooms = new Map();
const ROOM_BLOCK_TTL_MS = 10 * 60 * 1000;
const MAX_BLOCKED_ROOM_ENTRIES = MAX_ACTIVE_ROOMS * 4;

const blockRoom = (docName, ydoc, reason) => {
  const now = Date.now();
  blockedRooms.delete(docName);
  blockedRooms.set(docName, now + ROOM_BLOCK_TTL_MS);
  while (blockedRooms.size > MAX_BLOCKED_ROOM_ENTRIES) {
    blockedRooms.delete(blockedRooms.keys().next().value);
  }
  console.warn('[yjs] room policy close', { docName: roomLogId(docName), reason });
  if (ydoc) {
    for (const conn of ydoc.conns.keys()) {
      try { conn.close(1009, 'room resource limit'); } catch { /* already closing */ }
    }
  }
};

const isRoomBlocked = (docName) => {
  const expiresAt = blockedRooms.get(docName);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    blockedRooms.delete(docName);
    return false;
  }
  return true;
};

const armRoomCompactionTimer = (docName, churn, dueAt) => {
  if (churn.compactionTimer && churn.compactionTimerDueAt <= dueAt) return;
  if (churn.compactionTimer) clearTimeout(churn.compactionTimer);
  churn.compactionTimerDueAt = dueAt;
  churn.compactionTimer = setTimeout(() => {
    churn.compactionTimer = null;
    churn.compactionTimerDueAt = 0;
    scheduleRoomCompaction(docName);
  }, Math.max(1, dueAt - Date.now()));
  churn.compactionTimer.unref();
};

const scheduleRoomCompaction = (docName, { remeasure = false } = {}) => {
  const churn = persistenceChurnFor(docName);
  if (remeasure) churn.remeasureRequested = true;
  if (churn.compactionPromise || shuttingDown || storageFailure) return churn.compactionPromise;
  let activeDoc = docs.get(docName);
  if (!activeDoc) churn.remeasureRequested = false;

  const hasPersistenceWork = churn.uncompactedBytes > 0 || churn.uncompactedUpdates > 0;
  if (!hasPersistenceWork && !churn.remeasureRequested) return null;

  const now = Date.now();
  const compactionDueAt = churn.lastCompactedAt + ROOM_COMPACTION_MIN_INTERVAL_MS;
  const canCompact = hasPersistenceWork && now >= compactionDueAt;
  const usage = activeDoc ? roomUsage.get(activeDoc) : null;
  const remeasureDueAt = (usage?.lastMeasuredAt || now) + DOCUMENT_REMEASURE_MIN_INTERVAL_MS;
  const canRemeasure = Boolean(churn.remeasureRequested && activeDoc && now >= remeasureDueAt);

  if (!canCompact && !canRemeasure) {
    const nextDueAt = Math.min(
      hasPersistenceWork ? compactionDueAt : Number.POSITIVE_INFINITY,
      churn.remeasureRequested && activeDoc ? remeasureDueAt : Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(nextDueAt)) armRoomCompactionTimer(docName, churn, nextDueAt);
    return null;
  }

  if (churn.compactionTimer) clearTimeout(churn.compactionTimer);
  churn.compactionTimer = null;
  churn.compactionTimerDueAt = 0;
  const coveredBytes = canCompact ? churn.uncompactedBytes : 0;
  const coveredUpdates = canCompact ? churn.uncompactedUpdates : 0;

  // checkedFlushDocument enters y-leveldb's single serialized transaction
  // queue at this exact point. Later storeUpdate calls are queued behind it,
  // so subtracting only this captured generation cannot hide concurrent edits.
  // Exact in-memory measurement is independent and can run without a flush;
  // both expensive operations have their own per-room cooldown.
  const compaction = (canCompact ? checkedFlushDocument(docName) : Promise.resolve())
    .then(() => {
      if (canCompact) {
        churn.uncompactedBytes = Math.max(0, churn.uncompactedBytes - coveredBytes);
        churn.uncompactedUpdates = Math.max(0, churn.uncompactedUpdates - coveredUpdates);
        churn.lastCompactedAt = Date.now();
        dbUsageBytes = directorySizeSync(DB_DIR);
      }
      activeDoc = docs.get(docName);
      const currentUsage = activeDoc ? roomUsage.get(activeDoc) : null;
      const measurementNow = Date.now();
      if (churn.remeasureRequested && activeDoc && currentUsage
          && measurementNow - currentUsage.lastMeasuredAt >= DOCUMENT_REMEASURE_MIN_INTERVAL_MS) {
        try {
          const exactBytes = Y.encodeStateAsUpdate(activeDoc).byteLength;
          commitRoomUsage(activeDoc, {
            upperBytes: exactBytes,
            exactBytes,
            lastMeasuredAt: measurementNow,
          });
          churn.remeasureRequested = false;
          if (exactBytes > MAX_DOCUMENT_BYTES) {
            blockRoom(docName, activeDoc, 'document too large');
          } else if (activeDocumentBytes > MAX_ACTIVE_DOCUMENT_BYTES) {
            blockRoom(docName, activeDoc, 'active document capacity exceeded');
          }
          console.log('[yjs] document remeasured', {
            docName: roomLogId(docName),
            bytes: exactBytes,
          });
        } catch (err) {
          churn.remeasureRequested = false;
          blockRoom(docName, activeDoc, 'document size check failed');
          console.error('[yjs] document size check failed', {
            docName: roomLogId(docName),
            err: err.message,
          });
        }
      }
      if (!activeDoc) churn.remeasureRequested = false;
      if (canCompact) {
        console.log('[yjs] room compacted', {
          docName: roomLogId(docName),
          bytes: coveredBytes,
          updates: coveredUpdates,
        });
      }
    })
    .catch((err) => {
      markStorageFailure(err);
      console.error('[yjs] room compaction failed', { docName: roomLogId(docName), err: err.message });
    })
    .finally(() => {
      churn.compactionPromise = null;
      if (churn.uncompactedBytes >= ROOM_COMPACT_AFTER_BYTES
          || churn.uncompactedUpdates >= ROOM_COMPACT_AFTER_UPDATES
          || churn.remeasureRequested) {
        scheduleRoomCompaction(docName);
      }
    });
  churn.compactionPromise = compaction;
  return compaction;
};

const queueStoreUpdate = (docName, update, ydoc) => {
  const estimatedBytes = update.byteLength + 256;
  const churn = persistenceChurnFor(docName);
  if (churn.uncompactedBytes + estimatedBytes > ROOM_MAX_UNCOMPACTED_BYTES
      || churn.uncompactedUpdates + 1 > ROOM_MAX_UNCOMPACTED_UPDATES) {
    scheduleRoomCompaction(docName, { remeasure: true });
    blockRoom(docName, ydoc, 'room persistence backlog');
    return;
  }
  if (pendingStoreOps >= MAX_PENDING_STORE_OPS
      || pendingStoreBytes + estimatedBytes > MAX_PENDING_STORE_BYTES) {
    blockRoom(docName, ydoc, 'persistence backlog');
    return;
  }
  if (dbUsageBytes + pendingStoreBytes + estimatedBytes > MAX_DB_BYTES) {
    markStorageFailure(new Error('configured database quota exceeded'));
    return;
  }
  pendingStoreOps += 1;
  pendingStoreBytes += estimatedBytes;
  churn.uncompactedBytes += estimatedBytes;
  churn.uncompactedUpdates += 1;
  checkedStoreUpdate(docName, update)
    .then(() => {
      dbUsageBytes += estimatedBytes;
      if (update.byteLength > 100_000) {
        console.log('[yjs] storeUpdate ok', { docName: roomLogId(docName), bytes: update.byteLength });
      }
    })
    .catch((err) => {
      markStorageFailure(err);
      console.error('[yjs] storeUpdate failed', { docName: roomLogId(docName), err: err.message });
    })
    .finally(() => {
      pendingStoreOps = Math.max(0, pendingStoreOps - 1);
      pendingStoreBytes = Math.max(0, pendingStoreBytes - estimatedBytes);
    });
  if (churn.uncompactedBytes >= ROOM_COMPACT_AFTER_BYTES
      || churn.uncompactedUpdates >= ROOM_COMPACT_AFTER_UPDATES) {
    scheduleRoomCompaction(docName, { remeasure: true });
  }
};

// The relay is the durable fallback for deadlines. Connected clients also
// finalize promptly for immediate UI feedback; this pass covers a room whose
// creator is gone and a room reopened after everyone was offline.
const finalizeExpiredVotes = (docName, ydoc, atTime = Date.now()) => {
  if (storageFailure || shuttingDown || isRoomBlocked(docName)) return;
  const yItems = ydoc.getMap('items');
  const items = [];
  yItems.forEach((yItem, id) => {
    if (!(yItem instanceof Y.Map)) return;
    const item = { id };
    yItem.forEach((value, key) => { item[key] = value instanceof Y.Text ? value.toString() : value; });
    items.push(item);
  });
  const expired = items.filter((item) => (
    item.type === 'zone' && Number.isFinite(item.voteTimer?.endsAt)
    && item.voteTimer.endsAt <= atTime
  ));
  if (!expired.length) return;
  const votesByItem = new Map();
  ydoc.getMap('kv').forEach((value, key) => {
    if (!value) return;
    const match = /^s\|\|vote:([^:]+):([^:]+)$/.exec(key);
    if (!match) return;
    let voters = votesByItem.get(match[1]);
    if (!voters) { voters = new Set(); votesByItem.set(match[1], voters); }
    voters.add(match[2]);
  });
  for (const zone of expired) {
    const plan = planVoteFinalization(items, votesByItem, zone.id, atTime);
    if (!plan || plan.entries.some((entry) => {
      const current = items.find((item) => item.id === entry.id);
      return !current || geometryErrorForPatch(current, entry.patch);
    })) {
      console.warn('[yjs] vote finalization skipped invalid geometry', { docName: roomLogId(docName) });
      continue;
    }
    ydoc.transact(() => {
      const liveTimer = yItems.get(zone.id)?.get('voteTimer');
      if (!liveTimer?.endsAt || liveTimer.endsAt > atTime) return;
      plan.entries.forEach(({ id, patch }) => {
        const yItem = yItems.get(id);
        if (!(yItem instanceof Y.Map)) return;
        Object.entries(patch).forEach(([key, value]) => yItem.set(key, value));
      });
    }, 'timer-expiry');
  }
};

const voteExpiryTimers = new WeakMap();
const armVoteExpiry = (docName, ydoc, deferExpired = false) => {
  const existing = voteExpiryTimers.get(ydoc);
  if (existing) clearTimeout(existing);
  voteExpiryTimers.delete(ydoc);
  if (destroyedDocs.has(ydoc) || storageFailure || shuttingDown) return;
  let earliest = Infinity;
  ydoc.getMap('items').forEach((yItem) => {
    if (!(yItem instanceof Y.Map) || yItem.get('type') !== 'zone') return;
    const deadline = yItem.get('voteTimer')?.endsAt;
    if (Number.isFinite(deadline)) earliest = Math.min(earliest, deadline);
  });
  if (!Number.isFinite(earliest)) return;
  // A malformed unfinalizable room must not create a zero-delay retry loop.
  const waitMs = earliest <= Date.now()
    ? (deferExpired ? 60_000 : 1)
    : Math.max(1, Math.min(earliest - Date.now(), 2_147_483_647));
  const timer = setTimeout(() => {
    voteExpiryTimers.delete(ydoc);
    try { finalizeExpiredVotes(docName, ydoc); }
    catch (err) {
      console.error('[yjs] vote finalization failed', { docName: roomLogId(docName), err: err.message });
    }
    armVoteExpiry(docName, ydoc, true);
  }, waitMs);
  timer.unref();
  voteExpiryTimers.set(ydoc, timer);
};

// Hydration promise per room. y-websocket calls bindState without awaiting it
// and starts answering the sync protocol immediately, so a client connecting
// to a cold room is told "synced" against an empty doc while the LevelDB read
// is still in flight — it then sees a blank board and can write over real
// state. The upgrade handler awaits this before letting the socket through.
const roomReady = new WeakMap();

setPersistence({
  bindState: (docName, ydoc) => {
    // Aggregate accounting follows the Y.Doc lifetime. This covers normal
    // last-peer teardown as well as a failed first-upgrade cleanup exactly
    // once, without depending on each caller to mirror the bookkeeping.
    ydoc.on('destroy', () => {
      const timer = voteExpiryTimers.get(ydoc);
      if (timer) clearTimeout(timer);
      voteExpiryTimers.delete(ydoc);
      destroyedDocs.add(ydoc);
      releaseRoomUsage(ydoc);
    });
    ydoc.getMap('items').observeDeep((events) => {
      const itemMap = ydoc.getMap('items');
      if (events.some((event) => event.keysChanged?.has('voteTimer')
          || (event.target === itemMap && [...event.keysChanged].some((id) => (
            itemMap.get(id) instanceof Y.Map && itemMap.get(id).get('voteTimer')
          ))))) {
        armVoteExpiry(docName, ydoc);
      }
    });
    // The listener must be registered BEFORE the first await. y-websocket
    // calls bindState without awaiting it, so the room already accepts and
    // broadcasts client updates while the LevelDB read is in flight. Any
    // update applied during that gap was never handed to storeUpdate — it
    // reaches every peer, then vanishes on the next server restart.
    ydoc.on('update', (u, origin) => {
      if (origin === HYDRATION_ORIGIN) return;
      if (u.byteLength > MAX_UPDATE_BYTES) {
        blockRoom(docName, ydoc, 'update too large');
        return;
      }
      const usage = roomUsage.get(ydoc) || {
        upperBytes: 0,
        exactBytes: 0,
        lastMeasuredAt: Date.now(),
      };
      const nextUsage = {
        ...usage,
        upperBytes: usage.upperBytes + u.byteLength,
      };
      if (nextUsage.upperBytes > MAX_DOCUMENT_BYTES) {
        // Network updates are conservatively admitted before y-websocket
        // applies them. Reaching this branch means a non-network origin or an
        // unexpected encoding expansion escaped that guard; never turn it
        // into an attacker-controlled full-document encode loop.
        commitRoomUsage(ydoc, nextUsage);
        blockRoom(docName, ydoc, 'document conservative limit');
        return;
      }
      if (!tryCommitRoomUsage(ydoc, nextUsage)) {
        // A non-network update is already resident by this point. Account for
        // the temporary excess, then evict; network updates are rejected by
        // the protocol preflight before they can reach this branch.
        commitRoomUsage(ydoc, nextUsage);
        blockRoom(docName, ydoc, 'active document capacity exceeded');
        return;
      }
      queueStoreUpdate(docName, u, ydoc);
    });
    // y-websocket calls bindState as a floating promise (bin/utils.js:149) with
    // no .catch(), so anything thrown here becomes an unhandled rejection and
    // kills the process. Contain it: record the failure, leave the room empty,
    // and let the readiness check refuse further traffic.
    const ready = (async () => {
      try {
        const persisted = await checkedGetYDoc(docName);
        let persistedUpdate;
        try {
          persistedUpdate = Y.encodeStateAsUpdate(persisted);
        } finally {
          persisted.destroy();
        }
        if (persistedUpdate.byteLength > MAX_DOCUMENT_BYTES) {
          blockRoom(docName, ydoc, 'persisted document too large');
          return;
        }
        if (destroyedDocs.has(ydoc)) return;
        const hydratedUsage = {
          upperBytes: persistedUpdate.byteLength,
          exactBytes: persistedUpdate.byteLength,
          lastMeasuredAt: Date.now(),
        };
        if (!tryCommitRoomUsage(ydoc, hydratedUsage)) {
          // Aggregate pressure is transient. Reject this cold-room admission
          // without poisoning the room for the blocked-room TTL or declaring
          // the persistence layer globally unhealthy.
          capacityRejectedDocs.add(ydoc);
          console.warn('[yjs] active document capacity reached', {
            docName: roomLogId(docName),
          });
          return;
        }
        Y.applyUpdate(ydoc, persistedUpdate, HYDRATION_ORIGIN);
        try { finalizeExpiredVotes(docName, ydoc); }
        catch (err) {
          console.error('[yjs] vote finalization failed', { docName: roomLogId(docName), err: err.message });
        }
        armVoteExpiry(docName, ydoc);
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
  // room disconnects. Updates are already stored individually; consolidation
  // is thresholded and rate-limited separately so disconnect cannot force a
  // full-document merge.
  // Rethrowing here would also be fatal: the caller does
  // `writeState(...).then(() => doc.destroy())` with no .catch()
  // (bin/utils.js:205), so the rejection would go unhandled.
  writeState: async (docName) => {
    try {
      const churn = persistenceChurnFor(docName);
      // Every update is already durable through storeUpdate. Do not force a
      // full-room merge merely because the last peer disconnected: repeated
      // connect/disconnect would otherwise be an unbounded CPU amplifier.
      // If a threshold-triggered merge is already running, wait before the
      // library destroys its Y.Doc so our completion path cannot race it.
      if (churn.compactionPromise) await churn.compactionPromise;
    }
    catch (err) {
      markStorageFailure(err);
      console.error('[yjs] flushDocument failed', { docName: roomLogId(docName), err: err.message });
    }
  },
  provider: ldb,
});

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
  const createdPaths = [];
  let updatePersisted = false;
  try {
    const roomHandle = roomHandleForDoc(name);
    const room = roomUploadUsage.get(name);
    if (!roomHandle || !room) throw new Error('migration target is not a registered tokenized room');
    const ydoc = await checkedGetYDoc(name);
    const before = Y.encodeStateAsUpdate(ydoc).byteLength;
    const pendingUpdates = [];
    ydoc.on('update', (u) => pendingUpdates.push(u));
    let rewritten = 0;
    let rewrittenBytes = 0;
    ydoc.transact(() => {
      ydoc.getMap('items').forEach((yItem) => {
        if (!(yItem instanceof Y.Map) || yItem.get('type') !== 'image') return;
        const src = yItem.get('src');
        const m = typeof src === 'string' && src.match(DATA_URL_RE);
        if (!m) return;
        const ext = MIME_EXT[m[1]];
        if (!ext) return;
        const bytes = Buffer.from(m[2], 'base64');
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_UPLOAD_BYTES
            || !matchesMagicBytes(bytes.subarray(0, 12), m[1])
            || uploadUsageBytes + rewrittenBytes + bytes.byteLength > MAX_UPLOAD_STORAGE_BYTES
            || room.bytes + rewrittenBytes + bytes.byteLength > MAX_ROOM_UPLOAD_BYTES
            || uploadFileCount + rewritten >= MAX_UPLOAD_FILES
            || room.files + rewritten >= MAX_ROOM_UPLOAD_FILES) return;
        const imageId = `${randomUUID()}.${ext}`;
        const filename = `${roomHandle}.${imageId}`;
        const path = join(UPLOADS_DIR, filename);
        fs.writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
        createdPaths.push(path);
        yItem.set('src', `/rooms/${roomHandle}/images/${imageId}`);
        rewritten += 1;
        rewrittenBytes += bytes.byteLength;
      });
    }, 'migration');
    for (const u of pendingUpdates) {
      await checkedStoreUpdate(name, u);
      updatePersisted = true;
    }
    if (rewritten) {
      room.bytes += rewrittenBytes;
      room.files += rewritten;
      await checkedSetMeta(name, ROOM_UPLOAD_USAGE_META, { bytes: room.bytes, files: room.files });
    }
    await checkedFlushDocument(name);
    uploadUsageBytes += rewrittenBytes;
    uploadFileCount += rewritten;
    const after = Y.encodeStateAsUpdate(ydoc).byteLength;
    console.log('[yjs] migrated doc', roomLogId(name), { rewritten, beforeBytes: before, afterBytes: after });
  } catch (err) {
    // Before the CRDT update is durable these files are unreachable and safe
    // to roll back. Once the update is stored they must remain so a retry can
    // reconcile metadata without breaking already-persisted image URLs.
    if (!updatePersisted) {
      for (const path of createdPaths) {
        try { fs.unlinkSync(path); }
        catch (cleanupErr) {
          if (cleanupErr.code !== 'ENOENT') {
            console.error('[yjs] migration rollback failed', { docName: roomLogId(name), err: cleanupErr.message });
          }
        }
      }
    }
    console.error('[yjs] migration failed', { docName: roomLogId(name), err: err.message });
    throw err;
  }
}

const BOARD_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const randomBoardCode = () => {
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += BOARD_CODE_ALPHABET[byte % BOARD_CODE_ALPHABET.length];
  return code;
};
const randomRoomToken = () => randomBytes(24).toString('base64url');

const createRegisteredRoom = async () => {
  if (shuttingDown || storageFailure) throw Object.assign(new Error('service unavailable'), { code: 'SERVER_UNAVAILABLE' });
  if (registeredDocs.size + pendingRoomCreations >= MAX_REGISTERED_ROOMS) {
    throw Object.assign(new Error('room capacity reached'), { code: 'ROOM_CAPACITY' });
  }
  if (dbUsageBytes + pendingStoreBytes >= MAX_DB_BYTES) throw Object.assign(new Error('database capacity reached'), { code: 'ROOM_CAPACITY' });
  pendingRoomCreations += 1;
  let storeReserved = false;
  let estimatedBytes = 0;
  let roomHandle = null;
  let docName = null;
  try {
    let code;
    let token;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      code = randomBoardCode();
      token = randomRoomToken();
      docName = canonicalDocName(code, token);
      if (!existingDocNames.has(docName) && !registeredDocs.has(docName)) break;
      docName = null;
    }
    if (!docName) throw new Error('room id generation failed');
    roomHandle = newUniqueRoomHandle();
    pendingRoomHandles.add(roomHandle);

    const seed = new Y.Doc();
    seed.getMap('meta').set('__roomRegistered', 1);
    const update = Y.encodeStateAsUpdate(seed);
    seed.destroy();
    estimatedBytes = update.byteLength + 256;
    if (pendingStoreOps >= MAX_PENDING_STORE_OPS
        || pendingStoreBytes + estimatedBytes > MAX_PENDING_STORE_BYTES
        || dbUsageBytes + pendingStoreBytes + estimatedBytes > MAX_DB_BYTES) {
      throw Object.assign(new Error('database capacity reached'), { code: 'ROOM_CAPACITY' });
    }
    pendingStoreOps += 1;
    pendingStoreBytes += estimatedBytes;
    storeReserved = true;
    await checkedStoreUpdate(docName, update);
    await checkedSetMeta(docName, ROOM_HANDLE_META, roomHandle);
    await checkedSetMeta(docName, ROOM_UPLOAD_USAGE_META, { bytes: 0, files: 0 });
    await checkedFlushDocument(docName);
    dbUsageBytes = directorySizeSync(DB_DIR);
    if (dbUsageBytes > MAX_DB_BYTES) {
      const err = Object.assign(new Error('database capacity reached'), { code: 'ROOM_CAPACITY' });
      markStorageFailure(err);
      throw err;
    }
    // Commit marker comes last. Startup ignores token-shaped documents that do
    // not have it, so a failed multi-step creation can never become reachable.
    await checkedSetMeta(docName, ROOM_REGISTRATION_META, 1);
    existingDocNames.add(docName);
    registerDocInMemory(docName, roomHandle);
    roomUploadUsage.set(docName, { bytes: 0, files: 0, reservedBytes: 0, active: 0 });
    return { code, token };
  } catch (err) {
    if (docName && !registeredDocs.has(docName)) {
      try {
        await checkedClearDocument(docName);
        existingDocNames.delete(docName);
        dbUsageBytes = directorySizeSync(DB_DIR);
      } catch (cleanupErr) {
        markStorageFailure(cleanupErr);
        console.error('[yjs] incomplete room rollback failed', {
          docName: roomLogId(docName),
          err: cleanupErr.message,
        });
      }
    }
    throw err;
  } finally {
    pendingRoomCreations = Math.max(0, pendingRoomCreations - 1);
    if (roomHandle) pendingRoomHandles.delete(roomHandle);
    if (storeReserved) {
      pendingStoreOps = Math.max(0, pendingStoreOps - 1);
      pendingStoreBytes = Math.max(0, pendingStoreBytes - estimatedBytes);
    }
  }
};

const fixedDigestEqual = (left, right) => (
  Buffer.isBuffer(left)
  && Buffer.isBuffer(right)
  && left.byteLength === right.byteLength
  && timingSafeEqual(left, right)
);
const DUMMY_REGISTRATION_DIGEST = randomBytes(32);

const registeredDocForCapability = (code, token) => {
  if (!BOARD_CODE_RE.test(code) || !ROOM_TOKEN_RE.test(token)) return null;
  const docName = canonicalDocName(code, token);
  const expected = registeredDocDigests.get(docName) || DUMMY_REGISTRATION_DIGEST;
  const candidate = docRegistrationDigest(docName);
  return fixedDigestEqual(candidate, expected) && registeredDocs.has(docName) ? docName : null;
};

const ROOM_COOKIE_NAME = 'rb_room_session';
const sessionSignature = (handle, expiresAt, docName) => createHmac('sha256', SESSION_SIGNING_KEY)
  .update('room-session-v1\0')
  .update(handle)
  .update('\0')
  .update(String(expiresAt))
  .update('\0')
  .update(docName)
  .digest();

const createSessionCookie = (handle, expiresAt, docName, path) => {
  const signature = sessionSignature(handle, expiresAt, docName).toString('base64url');
  const value = `v1.${handle}.${expiresAt}.${signature}`;
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  return `${ROOM_COOKIE_NAME}=${value}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${ALLOW_INSECURE_HTTP ? '' : '; Secure'}`;
};

const cookieValueFromRequest = (req) => {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > MAX_COOKIE_HEADER_BYTES) return null;
  let found = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== ROOM_COOKIE_NAME) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found;
};

const authenticatedDocFromRequest = (req, requestedHandle) => {
  if (!ROOM_HANDLE_RE.test(requestedHandle)) return null;
  const docName = registeredRoomsByHandle.get(requestedHandle);
  const value = cookieValueFromRequest(req);
  if (!docName || !value || value.length > 160) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, cookieHandle, rawExpiry, rawSignature] = parts;
  if (!ROOM_HANDLE_RE.test(cookieHandle)
      || !/^\d{13}$/.test(rawExpiry)
      || !/^[A-Za-z0-9_-]{43}$/.test(rawSignature)) return null;
  const expiresAt = Number(rawExpiry);
  const now = Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + ROOM_SESSION_TTL_MS) return null;
  const handleMatches = fixedDigestEqual(Buffer.from(cookieHandle), Buffer.from(requestedHandle));
  const suppliedSignature = Buffer.from(rawSignature, 'base64url');
  // Node's decoder accepts non-canonical final base64url characters whose
  // unused padding bits differ but decode to the same bytes. Reject those
  // alternate spellings so changing any cookie character is always tampering.
  if (suppliedSignature.toString('base64url') !== rawSignature) return null;
  const expectedSignature = sessionSignature(requestedHandle, expiresAt, docName);
  return handleMatches && fixedDigestEqual(suppliedSignature, expectedSignature)
    ? { docName, expiresAt }
    : null;
};

const readJsonBody = async (req, { allowEmpty = false } = {}) => {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw Object.assign(new Error('unsupported content type'), { code: 'BAD_JSON' });
  const rawLength = req.headers['content-length'];
  if (rawLength != null && (!/^\d+$/.test(String(rawLength)) || Number(rawLength) > MAX_API_BODY_BYTES)) {
    throw Object.assign(new Error('invalid body length'), { code: 'BODY_TOO_LARGE' });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > MAX_API_BODY_BYTES) throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (total === 0 && allowEmpty) return {};
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid json'), { code: 'BAD_JSON' }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('invalid json'), { code: 'BAD_JSON' });
  return value;
};

const rateBuckets = {
  roomCreate: new Map(),
  roomCreateGlobal: new Map(),
  sessionExchange: new Map(),
  sessionExchangeGlobal: new Map(),
  sessionFailure: new Map(),
  wsUpgradeIp: new Map(),
  wsUpgradeRoom: new Map(),
  wsUpgradeGlobal: new Map(),
  coldRoomOpenIp: new Map(),
  coldRoomOpenRoom: new Map(),
  coldRoomOpenGlobal: new Map(),
};
const getRateBucket = (map, key, burst, perHour) => {
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket) {
    if (map.size >= MAX_BUCKETS) {
      let oldestKey;
      let oldest = Infinity;
      for (const [candidate, value] of map) {
        if (value.lastSeen < oldest) { oldest = value.lastSeen; oldestKey = candidate; }
      }
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
    bucket = { tokens: burst, last: now, lastSeen: now };
    map.set(key, bucket);
  }
  bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.last) * perHour / 3_600_000);
  bucket.last = now;
  bucket.lastSeen = now;
  return bucket;
};
const takeCreateToken = (ip) => {
  const ipBucket = getRateBucket(rateBuckets.roomCreate, ip, ROOM_CREATE_BURST, ROOM_CREATES_PER_HOUR);
  const globalBucket = getRateBucket(
    rateBuckets.roomCreateGlobal,
    'global',
    GLOBAL_ROOM_CREATE_BURST,
    GLOBAL_ROOM_CREATES_PER_MINUTE * 60,
  );
  if (ipBucket.tokens < 1 || globalBucket.tokens < 1) return false;
  ipBucket.tokens -= 1;
  globalBucket.tokens -= 1;
  return true;
};
const takeSessionExchangeToken = (ip) => {
  const ipBucket = getRateBucket(
    rateBuckets.sessionExchange,
    ip,
    SESSION_EXCHANGE_BURST,
    SESSION_EXCHANGES_PER_MINUTE * 60,
  );
  const globalBucket = getRateBucket(
    rateBuckets.sessionExchangeGlobal,
    'global',
    GLOBAL_SESSION_EXCHANGE_BURST,
    GLOBAL_SESSION_EXCHANGES_PER_MINUTE * 60,
  );
  if (ipBucket.tokens < 1 || globalBucket.tokens < 1) return false;
  ipBucket.tokens -= 1;
  globalBucket.tokens -= 1;
  return true;
};
const failureAttemptAvailable = (ip) => (
  getRateBucket(rateBuckets.sessionFailure, ip, SESSION_FAILURE_BURST, SESSION_FAILURES_PER_HOUR).tokens >= 1
);
const recordSessionFailure = (ip) => {
  const bucket = getRateBucket(rateBuckets.sessionFailure, ip, SESSION_FAILURE_BURST, SESSION_FAILURES_PER_HOUR);
  bucket.tokens = Math.max(0, bucket.tokens - 1);
};

const takeWsUpgradeToken = (ip, docName, coldRoom) => {
  const reservations = [
    getRateBucket(
      rateBuckets.wsUpgradeIp,
      ip,
      WS_UPGRADE_IP_BURST,
      WS_UPGRADES_PER_IP_PER_MINUTE * 60,
    ),
    getRateBucket(
      rateBuckets.wsUpgradeRoom,
      docName,
      WS_UPGRADE_ROOM_BURST,
      WS_UPGRADES_PER_ROOM_PER_MINUTE * 60,
    ),
    getRateBucket(
      rateBuckets.wsUpgradeGlobal,
      'global',
      GLOBAL_WS_UPGRADE_BURST,
      GLOBAL_WS_UPGRADES_PER_MINUTE * 60,
    ),
  ];
  if (coldRoom) {
    reservations.push(
      getRateBucket(
        rateBuckets.coldRoomOpenIp,
        ip,
        COLD_ROOM_OPEN_IP_BURST,
        COLD_ROOM_OPENS_PER_IP_PER_MINUTE * 60,
      ),
      getRateBucket(
        rateBuckets.coldRoomOpenRoom,
        docName,
        COLD_ROOM_OPEN_ROOM_BURST,
        COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE * 60,
      ),
      getRateBucket(
        rateBuckets.coldRoomOpenGlobal,
        'global',
        GLOBAL_COLD_ROOM_OPEN_BURST,
        GLOBAL_COLD_ROOM_OPENS_PER_MINUTE * 60,
      ),
    );
  }
  if (reservations.some((bucket) => bucket.tokens < 1)) return false;
  for (const bucket of reservations) bucket.tokens -= 1;
  return true;
};

const sendJson = (res, status, value, extraHeaders = {}) => {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
};

const sendIfWritable = (res, status, headers = {}) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, headers);
  res.end();
};

const handleCreateRoom = async (req, res, clientIp) => {
  const origin = req.headers.origin || '';
  if (!isExactAllowedOrigin(origin)) { res.writeHead(403); res.end(); return; }
  setCredentialCors(origin, res);
  res.setHeader('cache-control', 'no-store');
  if (shuttingDown || storageFailure) { res.writeHead(503); res.end(); return; }
  if (!takeCreateToken(clientIp)) { res.writeHead(429, { 'retry-after': '60' }); res.end(); return; }
  let body;
  try {
    body = await readJsonBody(req, { allowEmpty: true });
  } catch (err) {
    sendIfWritable(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400);
    return;
  }
  if (Object.keys(body).length !== 0) { res.writeHead(400); res.end(); return; }
  try {
    const room = await createRegisteredRoom();
    sendJson(res, 201, room);
  } catch (err) {
    if (err.code === 'STORAGE_FAILURE') markStorageFailure(err);
    else if (!['ROOM_CAPACITY', 'SERVER_UNAVAILABLE'].includes(err.code)) {
      console.error('[yjs] room creation failed', { code: err.code || 'UNKNOWN', err: err.message });
    }
    sendIfWritable(res, err.code === 'ROOM_CAPACITY' ? 507 : 503);
  }
};

const handleRoomSession = async (req, res, clientIp, prefixed) => {
  const origin = req.headers.origin || '';
  if (!isExactAllowedOrigin(origin)) { res.writeHead(403); res.end(); return; }
  setCredentialCors(origin, res);
  res.setHeader('cache-control', 'no-store');
  if (shuttingDown || storageFailure) { res.writeHead(503); res.end(); return; }
  let body;
  try { body = await readJsonBody(req); }
  catch (err) {
    if (!failureAttemptAvailable(clientIp)) sendIfWritable(res, 429, { 'retry-after': '60' });
    else {
      recordSessionFailure(clientIp);
      sendIfWritable(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400);
    }
    return;
  }
  const keys = Object.keys(body).sort();
  const wellFormed = keys.length === 2
    && keys[0] === 'code'
    && keys[1] === 'token'
    && typeof body.code === 'string'
    && typeof body.token === 'string';
  const docName = wellFormed ? registeredDocForCapability(body.code, body.token) : null;
  if (!docName) {
    if (!failureAttemptAvailable(clientIp)) sendIfWritable(res, 429, { 'retry-after': '60' });
    else {
      recordSessionFailure(clientIp);
      sendIfWritable(res, 404);
    }
    return;
  }
  if (!takeSessionExchangeToken(clientIp)) {
    sendIfWritable(res, 429, { 'retry-after': '2' });
    return;
  }
  const roomHandle = roomHandleForDoc(docName);
  const expiresAt = Date.now() + ROOM_SESSION_TTL_MS;
  const cookiePath = `${prefixed ? '/yjs' : ''}/rooms/${roomHandle}`;
  sendJson(res, 200, { roomHandle, expiresAt }, {
    'set-cookie': createSessionCookie(roomHandle, expiresAt, docName, cookiePath),
  });
};

const createTrafficBucket = (messages, bytes) => ({
  messages,
  bytes,
  last: Date.now(),
  lastSeen: Date.now(),
});
const takeTrafficTokens = (bucket, size, limits) => {
  const now = Date.now();
  const elapsed = now - bucket.last;
  bucket.messages = Math.min(limits.maxMessages, bucket.messages + elapsed * limits.messagesPerSecond / 1000);
  bucket.bytes = Math.min(limits.maxBytes, bucket.bytes + elapsed * limits.bytesPerSecond / 1000);
  bucket.last = now;
  bucket.lastSeen = now;
  if (bucket.messages < 1 || bucket.bytes < size) return false;
  bucket.messages -= 1;
  bucket.bytes -= size;
  return true;
};
const takeTrafficBudget = (reservations) => {
  const now = Date.now();
  for (const { bucket, limits } of reservations) {
    const elapsed = now - bucket.last;
    bucket.messages = Math.min(
      limits.maxMessages,
      bucket.messages + elapsed * limits.messagesPerSecond / 1000,
    );
    bucket.bytes = Math.min(
      limits.maxBytes,
      bucket.bytes + elapsed * limits.bytesPerSecond / 1000,
    );
    bucket.last = now;
    bucket.lastSeen = now;
  }
  if (reservations.some(({ bucket, size }) => bucket.messages < 1 || bucket.bytes < size)) {
    return false;
  }
  for (const { bucket, size } of reservations) {
    bucket.messages -= 1;
    bucket.bytes -= size;
  }
  return true;
};

const globalTrafficLimits = {
  maxMessages: GLOBAL_RL_MAX_MSGS,
  messagesPerSecond: GLOBAL_RL_REFILL_MSGS_PER_SEC,
  maxBytes: GLOBAL_RL_MAX_BYTES,
  bytesPerSecond: GLOBAL_RL_REFILL_BYTES_PER_SEC,
};
const roomTrafficLimits = {
  maxMessages: ROOM_RL_MAX_MSGS,
  messagesPerSecond: ROOM_RL_REFILL_MSGS_PER_SEC,
  maxBytes: ROOM_RL_MAX_BYTES,
  bytesPerSecond: ROOM_RL_REFILL_BYTES_PER_SEC,
};
const globalTrafficBucket = createTrafficBucket(GLOBAL_RL_MAX_MSGS, GLOBAL_RL_MAX_BYTES);
const roomTrafficBuckets = new Map();

const imageReadIpLimits = {
  maxMessages: IMAGE_READ_BURST,
  messagesPerSecond: IMAGE_READS_PER_SECOND,
  maxBytes: IMAGE_READ_BURST_BYTES,
  bytesPerSecond: IMAGE_READ_BYTES_PER_SECOND,
};
const imageReadRoomLimits = {
  maxMessages: ROOM_IMAGE_READ_BURST,
  messagesPerSecond: ROOM_IMAGE_READS_PER_SECOND,
  maxBytes: ROOM_IMAGE_READ_BURST_BYTES,
  bytesPerSecond: ROOM_IMAGE_READ_BYTES_PER_SECOND,
};
const imageReadGlobalLimits = {
  maxMessages: GLOBAL_IMAGE_READ_BURST,
  messagesPerSecond: GLOBAL_IMAGE_READS_PER_SECOND,
  maxBytes: GLOBAL_IMAGE_READ_BURST_BYTES,
  bytesPerSecond: GLOBAL_IMAGE_READ_BYTES_PER_SECOND,
};
const imageReadIpBuckets = new Map();
const imageReadRoomBuckets = new Map();
const globalImageReadBucket = createTrafficBucket(
  imageReadGlobalLimits.maxMessages,
  imageReadGlobalLimits.maxBytes,
);
const trafficBucketFor = (map, key, limits) => {
  let bucket = map.get(key);
  if (bucket) return bucket;
  if (map.size >= MAX_BUCKETS) {
    let oldestKey;
    let oldest = Infinity;
    for (const [candidate, value] of map) {
      if (value.lastSeen < oldest) { oldest = value.lastSeen; oldestKey = candidate; }
    }
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  bucket = createTrafficBucket(limits.maxMessages, limits.maxBytes);
  map.set(key, bucket);
  return bucket;
};
const takeImageReadBudget = (clientIp, roomKey, bytes) => takeTrafficBudget([
  {
    bucket: trafficBucketFor(imageReadIpBuckets, clientIp, imageReadIpLimits),
    size: bytes,
    limits: imageReadIpLimits,
  },
  {
    bucket: trafficBucketFor(imageReadRoomBuckets, roomKey, imageReadRoomLimits),
    size: bytes,
    limits: imageReadRoomLimits,
  },
  { bucket: globalImageReadBucket, size: bytes, limits: imageReadGlobalLimits },
]);

const syncResponseConnectionLimits = {
  maxMessages: SYNC_RESPONSE_CONNECTION_BURST_MESSAGES,
  messagesPerSecond: SYNC_RESPONSES_PER_CONNECTION_PER_MINUTE / 60,
  maxBytes: SYNC_RESPONSE_CONNECTION_BURST_BYTES,
  bytesPerSecond: SYNC_RESPONSE_CONNECTION_BYTES_PER_SECOND,
};
const syncResponseRoomLimits = {
  maxMessages: 32,
  messagesPerSecond: 8,
  maxBytes: SYNC_RESPONSE_ROOM_BURST_BYTES,
  bytesPerSecond: SYNC_RESPONSE_ROOM_BYTES_PER_SECOND,
};
const syncResponseGlobalLimits = {
  maxMessages: 128,
  messagesPerSecond: 32,
  maxBytes: SYNC_RESPONSE_GLOBAL_BURST_BYTES,
  bytesPerSecond: SYNC_RESPONSE_GLOBAL_BYTES_PER_SECOND,
};
const globalSyncResponseBucket = createTrafficBucket(
  syncResponseGlobalLimits.maxMessages,
  syncResponseGlobalLimits.maxBytes,
);
const roomSyncResponseBuckets = new Map();

const egressConnectionLimits = {
  maxMessages: WS_EGRESS_CONNECTION_BURST_MESSAGES,
  messagesPerSecond: WS_EGRESS_CONNECTION_MESSAGES_PER_SECOND,
  maxBytes: WS_EGRESS_CONNECTION_BURST_BYTES,
  bytesPerSecond: WS_EGRESS_CONNECTION_BYTES_PER_SECOND,
};
const egressRoomLimits = {
  maxMessages: WS_EGRESS_ROOM_BURST_MESSAGES,
  messagesPerSecond: WS_EGRESS_ROOM_MESSAGES_PER_SECOND,
  maxBytes: WS_EGRESS_ROOM_BURST_BYTES,
  bytesPerSecond: WS_EGRESS_ROOM_BYTES_PER_SECOND,
};
const egressGlobalLimits = {
  maxMessages: WS_EGRESS_GLOBAL_BURST_MESSAGES,
  messagesPerSecond: WS_EGRESS_GLOBAL_MESSAGES_PER_SECOND,
  maxBytes: WS_EGRESS_GLOBAL_BURST_BYTES,
  bytesPerSecond: WS_EGRESS_GLOBAL_BYTES_PER_SECOND,
};
const globalEgressBucket = createTrafficBucket(
  egressGlobalLimits.maxMessages,
  egressGlobalLimits.maxBytes,
);
const roomEgressBuckets = new Map();
const MAX_WS_EGRESS_MESSAGE_BYTES = MAX_DOCUMENT_BYTES + MAX_AWARENESS_ROOM_BYTES + 64 * 1024;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

const protocolBytes = (data) => {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('non-binary WebSocket message');
};

// Fully validate the framing before y-websocket mutates either a Y.Doc or its
// Awareness maps. In particular, y-protocols otherwise applies awareness
// entries incrementally, so a truncated multi-entry frame can retain a valid
// prefix even though the rest of the frame is malformed.
const inspectProtocolMessage = (data) => {
  const bytes = protocolBytes(data);
  if (bytes.byteLength === 0) throw new Error('empty protocol message');
  const decoder = decoding.createDecoder(bytes);
  const messageType = decoding.readVarUint(decoder);
  if (messageType === MESSAGE_SYNC) {
    const syncType = decoding.readVarUint(decoder);
    if (syncType === SYNC_STEP_1) {
      const stateVector = decoding.readVarUint8Array(decoder);
      if (stateVector.byteLength > MAX_STATE_VECTOR_BYTES || decoding.hasContent(decoder)) {
        throw new Error('invalid sync state vector');
      }
      return { kind: 'sync-step-1' };
    }
    if (syncType === SYNC_STEP_2 || syncType === SYNC_UPDATE) {
      const update = decoding.readVarUint8Array(decoder);
      if (update.byteLength > MAX_UPDATE_BYTES || decoding.hasContent(decoder)) {
        throw new Error('invalid sync update');
      }
      return { kind: 'sync-update', updateBytes: update.byteLength };
    }
    throw new Error('unknown sync message');
  }
  if (messageType === MESSAGE_AWARENESS) {
    if (bytes.byteLength > MAX_AWARENESS_MESSAGE_BYTES) throw new Error('awareness frame too large');
    const update = decoding.readVarUint8Array(decoder);
    if (decoding.hasContent(decoder)) throw new Error('invalid awareness envelope');
    const inner = decoding.createDecoder(update);
    const count = decoding.readVarUint(inner);
    // A standard y-websocket client echoes the server's multi-client
    // awareness snapshot back over its socket. Bound the envelope by the
    // room-wide identity cap here; planAwarenessUpdate separately limits how
    // many previously-unowned identities this connection may actually claim.
    if (count < 1 || count > MAX_AWARENESS_CLIENTS_PER_ROOM) {
      throw new Error('invalid awareness entry count');
    }
    const seen = new Set();
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      const clientId = decoding.readVarUint(inner);
      const clock = decoding.readVarUint(inner);
      const encodedState = decoding.readVarUint8Array(inner);
      if (!Number.isSafeInteger(clientId) || clientId < 0 || clientId > 0xffffffff
          || !Number.isSafeInteger(clock) || clock < 0
          || encodedState.byteLength > MAX_AWARENESS_STATE_BYTES
          || seen.has(clientId)) {
        throw new Error('invalid awareness entry');
      }
      seen.add(clientId);
      const state = JSON.parse(strictUtf8Decoder.decode(encodedState));
      if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
        throw new Error('invalid awareness state');
      }
      entries.push({ clientId, clock, stateIsNull: state === null, stateBytes: encodedState.byteLength });
    }
    if (decoding.hasContent(inner)) throw new Error('invalid awareness payload');
    return { kind: 'awareness', entries };
  }
  throw new Error('unknown protocol message');
};

const awarenessPolicies = new WeakMap();
const awarenessPolicyFor = (doc) => {
  let policy = awarenessPolicies.get(doc);
  if (!policy) {
    policy = {
      owners: new Map(),
      bytesById: new Map(),
      totalBytes: 0,
    };
    awarenessPolicies.set(doc, policy);
  }
  return policy;
};

const planAwarenessUpdate = (doc, conn, context, entries) => {
  const policy = awarenessPolicyFor(doc);
  const proposedIds = new Set(context.awarenessClientIds);
  const proposedOwners = new Map(policy.owners);
  const proposedBytes = new Map(policy.bytesById);
  let totalBytes = policy.totalBytes;
  const mutations = [];

  // Standard y-websocket clients echo server snapshots, BroadcastChannel
  // relays, and removal announcements over their own socket. Never let such
  // a relay overwrite another connection's first-claimed identity. An
  // already-unowned null is likewise a harmless stale removal; feeding it to
  // y-protocols would retain useless metadata. Drop the whole mixed frame so
  // upstream parsing remains atomic and cannot take ownership as a side
  // effect.
  for (const entry of entries) {
    if (entry.clientId === doc.awareness.clientID) throw new Error('reserved awareness id');
    if (context.expectedAwarenessClientId !== null
        && entry.clientId !== context.expectedAwarenessClientId) {
      return { dropFrame: true };
    }
    const owner = proposedOwners.get(entry.clientId);
    if ((owner && owner !== conn) || (!owner && entry.stateIsNull)) {
      return { dropFrame: true };
    }
  }

  for (const entry of entries) {
    const owner = proposedOwners.get(entry.clientId);
    const currentMeta = doc.awareness.meta.get(entry.clientId);
    const currentClock = currentMeta === undefined ? 0 : currentMeta.clock;
    const willApply = currentClock < entry.clock
      || (currentClock === entry.clock
        && entry.stateIsNull
        && doc.awareness.states.has(entry.clientId));
    if (!willApply) continue;

    if (!owner) {
      if (proposedIds.size >= MAX_AWARENESS_IDS_PER_CONNECTION
          || proposedOwners.size >= MAX_AWARENESS_CLIENTS_PER_ROOM) {
        throw new Error('awareness identity limit');
      }
      proposedIds.add(entry.clientId);
      proposedOwners.set(entry.clientId, conn);
    }

    const previousBytes = proposedBytes.get(entry.clientId) || 0;
    const nextBytes = entry.stateIsNull ? 0 : entry.stateBytes;
    totalBytes += nextBytes - previousBytes;
    if (totalBytes > MAX_AWARENESS_ROOM_BYTES) throw new Error('awareness room size limit');
    if (nextBytes > 0) proposedBytes.set(entry.clientId, nextBytes);
    else proposedBytes.delete(entry.clientId);
    mutations.push({ ...entry, nextBytes });
  }

  return {
    dropFrame: false,
    policy,
    proposedIds,
    proposedOwners,
    proposedBytes,
    totalBytes,
    mutations,
  };
};

const commitAwarenessPlan = (context, plan) => {
  if (plan.mutations.length === 0) return;
  context.awarenessClientIds = plan.proposedIds;
  plan.policy.owners = plan.proposedOwners;
  plan.policy.bytesById = plan.proposedBytes;
  plan.policy.totalBytes = plan.totalBytes;
};

const releaseAwarenessForConnection = (doc, conn, context) => {
  const policy = awarenessPolicies.get(doc);
  if (!policy) return;
  const remainingStates = [];
  for (const clientId of context.awarenessClientIds) {
    if (policy.owners.get(clientId) === conn && doc.awareness.states.has(clientId)) {
      remainingStates.push(clientId);
    }
  }
  // y-websocket stops tracking an ID after a null update and classifies a
  // later non-null update as `updated`, not `added`. Its own close hook can
  // therefore miss a re-added state. Remove any authoritative leftovers while
  // metadata still exists so the removal can be encoded and broadcast safely.
  if (remainingStates.length > 0) {
    awarenessProtocol.removeAwarenessStates(doc.awareness, remainingStates, null);
  }
  for (const clientId of context.awarenessClientIds) {
    if (policy.owners.get(clientId) !== conn) continue;
    policy.owners.delete(clientId);
    policy.totalBytes = Math.max(0, policy.totalBytes - (policy.bytesById.get(clientId) || 0));
    policy.bytesById.delete(clientId);
    // y-protocols intentionally retains clocks in `meta`. Once the owning
    // socket has been removed there is no identity continuity to preserve,
    // and retaining every reconnect forever is an avoidable memory leak.
    doc.awareness.meta.delete(clientId);
  }
};

const takeSyncResponseBudget = (docName, connectionBucket, estimatedBytes) => {
  let roomBucket = roomSyncResponseBuckets.get(docName);
  if (!roomBucket) {
    roomBucket = createTrafficBucket(
      syncResponseRoomLimits.maxMessages,
      syncResponseRoomLimits.maxBytes,
    );
    roomSyncResponseBuckets.set(docName, roomBucket);
  }
  const charge = Math.max(SYNC_RESPONSE_MIN_CHARGE_BYTES, estimatedBytes);
  return takeTrafficBudget([
    { bucket: connectionBucket, size: charge, limits: syncResponseConnectionLimits },
    { bucket: roomBucket, size: charge, limits: syncResponseRoomLimits },
    { bucket: globalSyncResponseBucket, size: charge, limits: syncResponseGlobalLimits },
  ]);
};

let wsConnectionCount = 0;
const wsConnectionsByIp = new Map();
const wsConnectionsByRoom = new Map();

const reserveWsConnection = (ip, docName) => {
  if (wsConnectionCount >= MAX_CONNECTIONS) return { status: 503 };
  if ((wsConnectionsByIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) return { status: 429 };
  if ((wsConnectionsByRoom.get(docName) || 0) >= MAX_CONNECTIONS_PER_ROOM) return { status: 429 };
  wsConnectionCount += 1;
  wsConnectionsByIp.set(ip, (wsConnectionsByIp.get(ip) || 0) + 1);
  wsConnectionsByRoom.set(docName, (wsConnectionsByRoom.get(docName) || 0) + 1);
  let released = false;
  return {
    status: 0,
    release() {
      if (released) return;
      released = true;
      wsConnectionCount = Math.max(0, wsConnectionCount - 1);
      const ipCount = (wsConnectionsByIp.get(ip) || 1) - 1;
      if (ipCount > 0) wsConnectionsByIp.set(ip, ipCount);
      else wsConnectionsByIp.delete(ip);
      const roomCount = (wsConnectionsByRoom.get(docName) || 1) - 1;
      if (roomCount > 0) wsConnectionsByRoom.set(docName, roomCount);
      else {
        wsConnectionsByRoom.delete(docName);
        roomTrafficBuckets.delete(docName);
        roomSyncResponseBuckets.delete(docName);
        roomEgressBuckets.delete(docName);
      }
    },
  };
};

let httpRequestCount = 0;
const httpRequestsByIp = new Map();
const reserveHttpRequest = (ip) => {
  if (httpRequestCount >= MAX_HTTP_REQUESTS) return { status: 503 };
  if ((httpRequestsByIp.get(ip) || 0) >= MAX_HTTP_REQUESTS_PER_IP) return { status: 429 };
  httpRequestCount += 1;
  httpRequestsByIp.set(ip, (httpRequestsByIp.get(ip) || 0) + 1);
  let released = false;
  return {
    status: 0,
    release() {
      if (released) return;
      released = true;
      httpRequestCount = Math.max(0, httpRequestCount - 1);
      const next = (httpRequestsByIp.get(ip) || 1) - 1;
      if (next > 0) httpRequestsByIp.set(ip, next);
      else httpRequestsByIp.delete(ip);
    },
  };
};

const rejectUpgrade = (socket, status) => {
  const reason = status === 400 ? 'Bad Request'
    : status === 401 ? 'Unauthorized'
    : status === 403 ? 'Forbidden'
      : status === 404 ? 'Not Found'
      : status === 431 ? 'Request Header Fields Too Large'
      : status === 429 ? 'Too Many Requests'
        : 'Service Unavailable';
  try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
  catch { socket.destroy(); }
};

let maintenanceRunning = false;
const runMaintenance = async () => {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const now = Date.now();
    for (const [ip, bucket] of uploadBuckets) {
      if (now - bucket.lastSeen > BUCKET_TTL_MS) uploadBuckets.delete(ip);
    }
    for (const buckets of Object.values(rateBuckets)) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.lastSeen > BUCKET_TTL_MS) buckets.delete(key);
      }
    }
    for (const buckets of [imageReadIpBuckets, imageReadRoomBuckets]) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.lastSeen > BUCKET_TTL_MS) buckets.delete(key);
      }
    }
    for (const [docName, churn] of roomPersistenceChurn) {
      if (!churn.compactionPromise
          && (churn.uncompactedBytes >= ROOM_COMPACT_AFTER_BYTES
            || churn.uncompactedUpdates >= ROOM_COMPACT_AFTER_UPDATES)) {
        scheduleRoomCompaction(docName, { remeasure: true });
      }
    }
    for (const [docName, ydoc] of docs) finalizeExpiredVotes(docName, ydoc, now);
    for (const [name, expiresAt] of blockedRooms) {
      if (expiresAt <= now) blockedRooms.delete(name);
    }
    dbUsageBytes = directorySizeSync(DB_DIR);
    if (dbUsageBytes > MAX_DB_BYTES) markStorageFailure(new Error('configured database quota exceeded'));

    // Final image deletion is disabled by default. Operators may explicitly
    // configure retention after choosing a policy suitable for their boards.
    if (UPLOAD_RETENTION_DAYS > 0) {
      const cutoff = now - UPLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      let removed = 0;
      const entries = await fs.promises.readdir(UPLOADS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !isStoredImageFilename(entry.name)) continue;
        const path = join(UPLOADS_DIR, entry.name);
        const stat = await fs.promises.stat(path);
        if (stat.mtimeMs >= cutoff) continue;
        await fs.promises.unlink(path);
        removed += 1;
      }
      if (removed) console.log('[yjs] upload retention sweep', { removed });
    }

    // Interrupted uploads are never published. Reap only our private temp-file
    // namespace, and only after it is older than twice the request deadline.
    const tempCutoff = now - REQUEST_TIMEOUT_MS * 2;
    const tempEntries = await fs.promises.readdir(UPLOADS_DIR, { withFileTypes: true });
    for (const entry of tempEntries) {
      if (!entry.isFile() || !/^\.upload-[a-f0-9-]+\.tmp$/.test(entry.name)) continue;
      const path = join(UPLOADS_DIR, entry.name);
      const stat = await fs.promises.stat(path);
      if (stat.mtimeMs < tempCutoff) await fs.promises.unlink(path);
    }
    if (activeUploads === 0) await reconcileUploadUsage();
  } catch (err) {
    if (err?.code === 'STORAGE_FAILURE') markStorageFailure(err);
    console.error('[yjs] maintenance failed', { err: err.message });
  } finally {
    maintenanceRunning = false;
  }
};
const maintenanceTimer = setInterval(runMaintenance, 60_000);
maintenanceTimer.unref();

const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
  const clientIp = clientIpFromRequest(req);
  const reservation = reserveHttpRequest(clientIp);
  if (reservation.status) {
    res.writeHead(reservation.status, { 'retry-after': '2' });
    res.end();
    return;
  }
  res.once('finish', reservation.release);
  res.once('close', reservation.release);
  let pathname;
  let hasQueryOrFragment = false;
  try {
    if (!req.url || req.url.length > 2048) throw new Error('invalid request target');
    const parsed = new URL(req.url, 'http://localhost');
    ({ pathname } = parsed);
    hasQueryOrFragment = Boolean(parsed.search || parsed.hash);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  // Cloudflare Tunnel forwards the /yjs prefix through unstripped in prod;
  // capability, session and room-upload routes answer in bare and prefixed
  // forms so dev and production use the same server.
  const routePath = pathname.replace(/^\/yjs(?=\/|$)/, '') || '/';
  const prefixed = pathname === '/yjs' || pathname.startsWith('/yjs/');
  const uploadMatch = !hasQueryOrFragment
    ? routePath.match(/^\/rooms\/([A-Za-z0-9_-]{32})\/upload$/)
    : null;
  const roomImageMatch = !hasQueryOrFragment
    ? routePath.match(/^\/rooms\/([A-Za-z0-9_-]{32})\/images\/([a-f0-9-]+\.(?:png|jpe?g|webp|gif))$/)
    : null;
  // Readiness is separate from liveness: the process can be perfectly alive
  // while LevelDB is unwritable, and the catch-all below answers 200 either
  // way. An orchestrator polling this stops routing new traffic here instead
  // of accepting work the relay can no longer persist.
  if (req.method === 'GET' && routePath === '/readyz') {
    const ok = !storageFailure;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' });
    res.end(ok ? 'ready' : 'not ready');
    return;
  }
  if (req.method === 'OPTIONS'
      && !hasQueryOrFragment
      && (routePath === '/api/rooms' || routePath === '/api/room-session' || uploadMatch)) {
    const origin = req.headers.origin || '';
    if (!isExactAllowedOrigin(origin)) { res.writeHead(403); res.end(); return; }
    setCredentialCors(origin, res);
    if (uploadMatch && !registeredRoomsByHandle.has(uploadMatch[1])) { res.writeHead(404); res.end(); return; }
    res.writeHead(204, {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }
  if (req.method === 'POST' && !hasQueryOrFragment && routePath === '/api/rooms') {
    void handleCreateRoom(req, res, clientIp);
    return;
  }
  if (req.method === 'POST' && !hasQueryOrFragment && routePath === '/api/room-session') {
    void handleRoomSession(req, res, clientIp, prefixed);
    return;
  }
  if (req.method === 'POST' && uploadMatch) {
    const origin = req.headers.origin || '';
    if (!isExactAllowedOrigin(origin)) { res.writeHead(403); res.end(); return; }
    setCredentialCors(origin, res);
    res.setHeader('cache-control', 'no-store');
    if (shuttingDown || storageFailure) { res.writeHead(503); res.end(); return; }
    if (!registeredRoomsByHandle.has(uploadMatch[1])) { res.writeHead(404); res.end(); return; }
    const session = authenticatedDocFromRequest(req, uploadMatch[1]);
    if (!session) { res.writeHead(401); res.end(); return; }
    void handleUpload(req, res, clientIp, session.docName, uploadMatch[1]);
    return;
  }
  if (req.method === 'GET' && roomImageMatch) {
    if (!registeredRoomsByHandle.has(roomImageMatch[1])) { res.writeHead(404); res.end(); return; }
    const session = authenticatedDocFromRequest(req, roomImageMatch[1]);
    if (!session) { res.writeHead(401); res.end(); return; }
    handleGetRoomImage(roomImageMatch[1], roomImageMatch[2], req, res);
    return;
  }
  if (req.method === 'GET' && routePath.startsWith('/images/')) {
    handleGetLegacyImage(routePath.slice('/images/'.length), req, res);
    return;
  }
  if (req.method === 'GET' && routePath === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('yjs-ws ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
server.maxRequestsPerSocket = 100;
server.maxConnections = MAX_CONNECTIONS + MAX_HTTP_REQUESTS;
server.on('clientError', (err, socket) => {
  const status = err.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
  if (socket.writable) rejectUpgrade(socket, status);
  else socket.destroy();
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
  const context = req.wsSecurityContext;
  if (!context?.docName) {
    conn.close(1011, 'server setup error');
    return;
  }
  const { docName, clientIp, expiresAt } = context;
  const doc = docs.get(docName);
  if (!doc) {
    conn.close(1011, 'server setup error');
    return;
  }
  context.awarenessClientIds = new Set();
  console.log('[yjs] conn open', { docName: roomLogId(docName), client: roomLogId(`ip:${clientIp}`), origin: req.headers.origin });
  conn.on('error', (err) => {
    console.warn('[yjs] conn error', { docName: roomLogId(docName), err: err.message, code: err.code });
    try { conn.terminate(); } catch { /* already closed */ }
  });
  if (expiresAt) {
    const sessionTimer = setTimeout(() => {
      try { conn.close(1008, 'session expired'); } catch { /* already closed */ }
    }, Math.max(1, expiresAt - Date.now()));
    sessionTimer.unref();
    conn.once('close', () => clearTimeout(sessionTimer));
  }
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

  // y-websocket funnels sync replies, awareness snapshots, and broadcasts
  // through conn.send. Mediate that method before setup so one small inbound
  // request cannot enqueue unbounded full-document responses or multiply a
  // broadcast across peers without paying room/global egress budgets.
  const originalSend = conn.send.bind(conn);
  const connectionEgressBucket = createTrafficBucket(
    egressConnectionLimits.maxMessages,
    egressConnectionLimits.maxBytes,
  );
  const connectionSyncBucket = createTrafficBucket(
    syncResponseConnectionLimits.maxMessages,
    syncResponseConnectionLimits.maxBytes,
  );
  let egressLimited = false;
  conn.send = (data, ...args) => {
    const size = typeof data === 'string'
      ? Buffer.byteLength(data)
      : (data?.byteLength ?? data?.length ?? 0);
    let roomEgressBucket = roomEgressBuckets.get(docName);
    if (!roomEgressBucket) {
      roomEgressBucket = createTrafficBucket(
        egressRoomLimits.maxMessages,
        egressRoomLimits.maxBytes,
      );
      roomEgressBuckets.set(docName, roomEgressBucket);
    }
    const admitted = Number.isSafeInteger(size)
      && size >= 0
      && size <= MAX_WS_EGRESS_MESSAGE_BYTES
      && takeTrafficBudget([
        { bucket: connectionEgressBucket, size, limits: egressConnectionLimits },
        { bucket: roomEgressBucket, size, limits: egressRoomLimits },
        { bucket: globalEgressBucket, size, limits: egressGlobalLimits },
      ]);
    if (!admitted) {
      if (!egressLimited) {
        egressLimited = true;
        console.warn('[yjs] egress-limit close', { docName: roomLogId(docName), size });
        setImmediate(() => {
          try { conn.close(1008, 'egress rate-limit'); } catch { /* already closing */ }
        });
      }
      return undefined;
    }
    return originalSend(data, ...args);
  };

  const before = new Set(conn.listeners('message'));
  setupWSConnection(conn, req, { docName, gc: true });
  // setupWSConnection registers its close handler synchronously. Registering
  // after it guarantees states/controlled IDs are removed before we delete
  // y-protocols' otherwise-retained metadata and our byte accounting.
  conn.once('close', () => releaseAwarenessForConnection(doc, conn, context));
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
    let roomBucket = roomTrafficBuckets.get(docName);
    if (!roomBucket) {
      roomBucket = createTrafficBucket(ROOM_RL_MAX_MSGS, ROOM_RL_MAX_BYTES);
      roomTrafficBuckets.set(docName, roomBucket);
    }
    if (!takeTokens(size)
        || !takeTrafficTokens(globalTrafficBucket, size, globalTrafficLimits)
        || !takeTrafficTokens(roomBucket, size, roomTrafficLimits)
        || pendingStoreOps >= MAX_PENDING_STORE_OPS
        || pendingStoreBytes >= MAX_PENDING_STORE_BYTES) {
      limited = true;
      console.warn('[yjs] rate-limit close', { docName: roomLogId(docName), origin: req.headers.origin, size });
      try { conn.close(1008, 'rate-limit'); } catch { /* already closing */ }
      return;
    }
    let inspection;
    let awarenessPlan = null;
    try {
      inspection = inspectProtocolMessage(data);
      if (inspection.kind === 'sync-update') {
        const usage = roomUsage.get(doc) || {
          upperBytes: 0,
          exactBytes: 0,
          lastMeasuredAt: Date.now(),
        };
        const churn = persistenceChurnFor(docName);
        const estimatedStoreBytes = inspection.updateBytes + 256;
        if (pendingStoreOps >= MAX_PENDING_STORE_OPS
            || pendingStoreBytes + estimatedStoreBytes > MAX_PENDING_STORE_BYTES) {
          throw new Error('persistence backlog');
        }
        if (dbUsageBytes + pendingStoreBytes + estimatedStoreBytes > MAX_DB_BYTES) {
          markStorageFailure(new Error('configured database quota exceeded'));
          throw new Error('database capacity reached');
        }
        if (usage.upperBytes + inspection.updateBytes > MAX_DOCUMENT_BYTES) {
          scheduleRoomCompaction(docName, { remeasure: true });
          throw Object.assign(new Error('document conservative limit'), { closeCode: 1009 });
        }
        if (activeDocumentBytes + inspection.updateBytes > MAX_ACTIVE_DOCUMENT_BYTES) {
          scheduleRoomCompaction(docName, { remeasure: true });
          throw Object.assign(new Error('active document capacity reached'), { closeCode: 1009 });
        }
        if (churn.uncompactedUpdates + 1 > ROOM_MAX_UNCOMPACTED_UPDATES) {
          scheduleRoomCompaction(docName, { remeasure: true });
          throw new Error('room persistence compacting');
        }
        if (churn.uncompactedBytes + inspection.updateBytes + 256 > ROOM_MAX_UNCOMPACTED_BYTES) {
          scheduleRoomCompaction(docName, { remeasure: true });
          throw new Error('room persistence compacting');
        }
      } else if (inspection.kind === 'sync-step-1') {
        const usage = roomUsage.get(doc) || {
          upperBytes: 0,
          exactBytes: 0,
          lastMeasuredAt: Date.now(),
        };
        const estimatedBytes = Math.min(
          MAX_DOCUMENT_BYTES,
          Math.max(usage.upperBytes, usage.exactBytes),
        );
        if (!takeSyncResponseBudget(docName, connectionSyncBucket, estimatedBytes)) {
          throw new Error('sync response rate-limit');
        }
      } else if (inspection.kind === 'awareness') {
        awarenessPlan = planAwarenessUpdate(doc, conn, context, inspection.entries);
        if (awarenessPlan.dropFrame) return;
      }
    } catch (err) {
      limited = true;
      console.warn('[yjs] protocol-policy close', {
        docName: roomLogId(docName),
        reason: err.message,
        size,
      });
      try { conn.close(err.closeCode || 1008, 'protocol policy'); } catch { /* already closing */ }
      return;
    }
    parseYjsMessage(data);
    if (awarenessPlan) commitAwarenessPlan(context, awarenessPlan);
    for (const peer of doc.conns.keys()) {
      if (peer.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
        try { peer.close(1008, 'slow consumer'); } catch { /* already closing */ }
      }
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  // Origin allowlist — set YJS_ALLOWED_ORIGINS in prod to lock the relay to
  // the public site. Browsers always send Origin on WS handshakes; non-browser
  // clients can spoof it but at least defeats opportunistic CSRF-style abuse
  // from a malicious site running a ws() in the user's tab.
  const origin = req.headers.origin || '';
  if (!isExactAllowedOrigin(origin)) {
    rejectUpgrade(socket, 403);
    return;
  }
  const roomTarget = roomTargetFromRequest(req);
  const handle = roomTarget?.handle || null;
  const session = handle ? authenticatedDocFromRequest(req, handle) : null;
  let docName = session?.docName || null;
  let expiresAt = session?.expiresAt || null;
  if (handle && !registeredRoomsByHandle.has(handle)) {
    rejectUpgrade(socket, 404);
    return;
  }
  if (handle && !session) {
    rejectUpgrade(socket, 401);
    return;
  }
  if (!handle && !docName && ALLOW_LEGACY_URL_TOKENS) {
    const candidate = tokenDocNameFromRequest(req);
    if (candidate && (registeredDocs.has(candidate)
        || (ALLOW_LEGACY_ROOMS && existingDocNames.has(candidate)))) {
      docName = candidate;
      expiresAt = null;
    }
  }
  if (!docName) {
    rejectUpgrade(socket, 404);
    return;
  }
  // Reject known-doomed upgrades before getYDoc can allocate and hydrate a
  // room that will never receive a connection.
  if (shuttingDown || storageFailure || isRoomBlocked(docName)) {
    rejectUpgrade(socket, 503);
    return;
  }
  const coldRoom = !docs.has(docName);
  if (coldRoom && docs.size >= MAX_ACTIVE_ROOMS) {
    rejectUpgrade(socket, 503);
    return;
  }
  const clientIp = clientIpFromRequest(req);
  if (!takeWsUpgradeToken(clientIp, docName, coldRoom)) {
    rejectUpgrade(socket, 429);
    return;
  }
  const reservation = reserveWsConnection(clientIp, docName);
  if (reservation.status) {
    rejectUpgrade(socket, reservation.status);
    return;
  }
  socket.once('close', reservation.release);
  req.wsSecurityContext = {
    docName,
    clientIp,
    expiresAt,
    expectedAwarenessClientId: roomTarget?.awarenessClientId ?? null,
  };
  const upgradeTimer = setTimeout(() => {
    if (!socket.destroyed) socket.destroy();
  }, UPGRADE_TIMEOUT_MS);
  upgradeTimer.unref();
  // Use the same canonical name passed to setupWSConnection, so hydration and
  // the client attachment cannot diverge between bare and /yjs-prefixed paths.
  // getYDoc creates the room (running bindState) if this is the first client;
  // awaiting its hydration keeps the sync protocol from answering with an
  // empty doc. Rooms already in memory resolve immediately.
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
      if (socket.destroyed) throw new Error('socket closed');
      if (shuttingDown) throw new Error('shutting down');
      if (storageFailure) throw storageFailure;
      if (capacityRejectedDocs.has(doc)) throw new Error('active document capacity reached');
      if (isRoomBlocked(docName)) throw new Error('room unavailable');
      wss.handleUpgrade(req, socket, head, (ws) => {
        clearTimeout(upgradeTimer);
        socket.off('close', cleanupUnattachedUpgrade);
        wss.emit('connection', ws, req);
      });
    })
    .catch((err) => {
      clearTimeout(upgradeTimer);
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
      if (!socket.destroyed) rejectUpgrade(socket, 503);
    });
});

// Graceful drain. Without this, `docker stop` kills the process while
// storeUpdate calls are still in flight, so the last edits before a deploy
// can be lost even though every client saw them.
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(maintenanceTimer);
  console.log('[yjs] draining', { signal, rooms: docs.size });
  // Force exit if a stuck LevelDB call would otherwise hold us past the
  // orchestrator's grace period and earn a SIGKILL mid-write.
  const hardStop = setTimeout(() => {
    console.error('[yjs] drain timed out — exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  hardStop.unref();
  let drainFailed = false;
  try {
    // Stop admission immediately, but do not await this yet: Node's HTTP
    // close callback also waits for upgraded TCP sockets. Awaiting it before
    // closing WebSockets deadlocks every shutdown with an active room.
    const httpClosed = new Promise((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
    // An admitted slow body may legally outlive the global drain deadline
    // (`requestTimeout` is intentionally longer). Give normal requests a
    // bounded grace period, then abort remaining ordinary HTTP connections.
    // Upload publication is atomic, and the operation counters below keep us
    // from destroying storage while an aborted handler is unwinding.
    const forceHttpTimer = setTimeout(() => {
      server.closeAllConnections();
    }, HTTP_SHUTDOWN_GRACE_MS);
    forceHttpTimer.unref();
    // Snapshot before closing sockets: y-websocket deletes each room from
    // `docs` as its last connection goes away.
    const roomNames = [...docs.keys()];
    const socketClosures = [...wss.clients].map((conn) => new Promise((resolveSocket) => {
      if (conn.readyState === 3) { resolveSocket(); return; }
      let forceTimer;
      const done = () => {
        clearTimeout(forceTimer);
        resolveSocket();
      };
      conn.once('close', done);
      forceTimer = setTimeout(() => {
        try { conn.terminate(); } catch { /* already closed */ }
      }, 5_000);
      forceTimer.unref();
      try { conn.close(1001, 'server shutting down'); }
      catch {
        try { conn.terminate(); } catch { /* already closed */ }
      }
    }));
    // This now waits for ordinary HTTP work and the just-closed upgraded
    // sockets without allowing LevelDB to be destroyed underneath handlers.
    await Promise.all([httpClosed, ...socketClosures]);
    clearTimeout(forceHttpTimer);
    while (maintenanceRunning || pendingRoomCreations > 0 || activeUploads > 0 || pendingStoreOps > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    // Every accepted edit is durable through storeUpdate, which the counters
    // above have drained. Consolidation is optional and can process an entire
    // near-limit document, so never force it into the fixed shutdown window.
    // Only let work that was already admitted finish before closing LevelDB.
    const inFlightCompactions = [...roomPersistenceChurn.values()]
      .map((churn) => churn.compactionPromise)
      .filter(Boolean);
    await Promise.all(inFlightCompactions);
    if (storageFailure) drainFailed = true;
    await ldb.destroy();
    console.log('[yjs] drained', { rooms: roomNames.length });
  } catch (err) {
    drainFailed = true;
    console.error('[yjs] drain failed', { err: err.message });
  }
  process.exit(drainFailed ? 1 : 0);
};
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });

server.listen(PORT, HOST, () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : PORT;
  const displayHost = HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`[yjs] listening on ws://${displayHost}:${boundPort}  (db: ${DB_DIR})`);
  if (ALLOWED_ORIGINS.length) {
    console.log(`[yjs] origin allowlist: ${ALLOWED_ORIGINS.join(', ')}`);
  } else if (ALLOW_INSECURE_HTTP) {
    console.warn('[yjs] dev HTTP mode: accepting localhost origins only');
  } else {
    console.warn('[yjs] no allowed origins configured; APIs and WebSockets are fail-closed');
  }
  if (ALLOW_LEGACY_ROOMS) console.warn('[yjs] legacy tokenless rooms enabled');
  if (ALLOW_LEGACY_URL_TOKENS) console.warn('[yjs] legacy URL-token WebSockets enabled');
  if (TRUST_PROXY) console.warn('[yjs] trusted proxy headers enabled; block direct origin access');
});
