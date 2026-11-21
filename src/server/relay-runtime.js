import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { roomLogId } from './relay-log-id.js';

export function createRelayRuntime() {
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
  const require = createRequire(new URL('../../package.json', import.meta.url));
  const Y = require('yjs');
  const { LeveldbPersistence } = require('y-leveldb');



  const loadUtils = async () => {
    // y-websocket v1 ships server utils at bin/utils.js but doesn't expose them
    // in its package "exports" map, so we import the file directly.
    const utilsPath = fileURLToPath(new URL('../../node_modules/y-websocket/bin/utils.js', import.meta.url));
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

    return { setupWSConnection, setPersistence, docs, getYDoc, awarenessProtocol };
  };

  return { Y, LeveldbPersistence, loadUtils };
}

export function logRelayBanner({ server, PORT, HOST, DB_DIR, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP, ALLOW_LEGACY_ROOMS, ALLOW_LEGACY_URL_TOKENS, TRUST_PROXY, accounting, MAX_DB_BYTES, markStorageFailure }) {
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
  if (accounting.dbUsageBytes > MAX_DB_BYTES) markStorageFailure(new Error('configured database quota exceeded'));
}
