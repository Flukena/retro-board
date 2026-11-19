import { coalesceAwarenessSends } from './relay-awareness-fanout.js';
import { closeOnSessionExpiry } from './relay-ws-traffic.js';
import { registerPublicQuotaClient, notifyPublicQuota } from './public-action-limit.js';
import { PUBLIC_ACTION_LIMIT_REASON } from './public-wall-config.js';
import { roomLogId } from './relay-log-id.js';

export function createWsConnectionHandler({ config, accounting, docs, Y, PUBLIC_WALL, roomFence, wsTraffic, rejectionCounters, setupWSConnection, releaseAwarenessForConnection, inspectMessage, commitAwarenessPlan }) {
  const { MAX_AWARENESS_MESSAGE_BYTES, MAX_PENDING_STORE_OPS, MAX_PENDING_STORE_BYTES } = config;
  const rejectIngress = (conn, req, docName, size) => {
    rejectionCounters.observeBacklog(accounting.pendingStoreOps, accounting.pendingStoreBytes, MAX_PENDING_STORE_OPS, MAX_PENDING_STORE_BYTES);
    console.warn('[yjs] rate-limit close', { docName: roomLogId(docName), origin: req.headers.origin, size });
    try { conn.close(1008, 'rate-limit'); } catch { /* already closing */ }
  };

  const rejectProtocol = (conn, docName, size, err) => {
    if (err.closeReason === PUBLIC_ACTION_LIMIT_REASON) rejectionCounters.increment(PUBLIC_ACTION_LIMIT_REASON, 1008);
    else console.warn('[yjs] protocol-policy close', {
      docName: roomLogId(docName),
      reason: err.message,
      size,
    });
    try { conn.close(err.closeCode || 1008, err.closeReason || 'protocol policy'); } catch { /* already closing */ }
  };

  const handleConnection = (conn, req) => {
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
    closeOnSessionExpiry(conn, expiresAt);
    // Ingress closes the WS when over budget; egress mediates conn.send, which y-websocket
    // funnels sync replies, awareness snapshots and broadcasts through.
    let limited = false;
    const meter = wsTraffic.attach(conn, docName);

    if (PUBLIC_WALL) coalesceAwarenessSends(conn, doc, MAX_AWARENESS_MESSAGE_BYTES);
    if (PUBLIC_WALL && context.supportsQuota) registerPublicQuotaClient(Y, doc, clientIp, conn);

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
      if (limited || roomFence.isFenced(docName)) return;
      const size = data?.byteLength ?? data?.length ?? 0;
      if (!meter.admitIngress(size)
          || accounting.pendingStoreOps >= MAX_PENDING_STORE_OPS
          || accounting.pendingStoreBytes >= MAX_PENDING_STORE_BYTES) {
        limited = true;
        rejectIngress(conn, req, docName, size);
        return;
      }
      let inspection;
      let awarenessPlan = null;
      try {
        ({ inspection, awarenessPlan } = inspectMessage(data, { doc, docName, conn, context, meter, clientIp }));
        if (awarenessPlan?.dropFrame) return;
      } catch (err) {
        limited = true;
        rejectProtocol(conn, docName, size, err);
        return;
      }
      parseYjsMessage(data);
      if (PUBLIC_WALL && inspection.kind === 'sync-update') notifyPublicQuota(doc, clientIp, conn);
      if (awarenessPlan) commitAwarenessPlan(context, awarenessPlan);
      wsTraffic.closeSlowConsumers(doc.conns.keys());
    });
  };

  return { handleConnection };
}
