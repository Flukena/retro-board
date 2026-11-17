import { roomLogId } from './relay-log-id.js';

const STATUS = Object.freeze({ NOT_FOUND: 404, UNAVAILABLE: 503 });
const UPGRADE_FAILED_LOG = '[yjs] upgrade failed';
const roomDeleted = () => Object.assign(new Error('room deleted'), { status: STATUS.NOT_FOUND });

/**
 * Attaches an admitted normal-room upgrade once its Y.Doc has hydrated. y-websocket starts answering the sync protocol
 * before hydration ends, so a socket attached early would be told "synced" against an empty doc.
 * Ports: docs, getYDoc and roomReady (doc → hydration promise) from the relay; wss; fence (RoomFence); refusal(doc,
 * docName) → an Error that stops the attach, or null; reject(socket, status); timeoutMs; log.
 */
export function createPlainUpgrades({ docs, getYDoc, roomReady, wss, fence, refusal, reject, timeoutMs, log = console }) {
  // Only a doc created for this upgrade, still the room's doc and still unattached, is removed.
  const dropUnattached = (docName, doc, createdForUpgrade) => {
    if (createdForUpgrade && docs.get(docName) === doc && doc.conns.size === 0) {
      docs.delete(docName);
      roomReady.delete(doc);
      doc.destroy();
    }
  };

  /** `leave` releases the fence entry the gate took for this upgrade; it is held until the socket is attached or refused. */
  const attach = (req, socket, head, docName, leave) => {
    const upgradeTimer = setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, timeoutMs);
    upgradeTimer.unref();
    const hadDoc = docs.has(docName);
    const doc = getYDoc(docName, true);
    const createdForUpgrade = !hadDoc && docs.get(docName) === doc;
    // `handleUpgrade` returns normally when it rejects a malformed handshake, without invoking its callback. Retire a
    // room created for such an upgrade when the raw socket closes; a successful upgrade removes this listener.
    const cleanupUnattachedUpgrade = () => dropUnattached(docName, doc, createdForUpgrade);
    if (createdForUpgrade) socket.once('close', cleanupUnattachedUpgrade);
    Promise.resolve(roomReady.get(doc))
      .then(() => {
        if (socket.destroyed) throw new Error('socket closed');
        // A room fenced while this upgrade waited is being deleted: its doc is already gone.
        if (fence.isFenced(docName)) throw roomDeleted();
        const refused = refusal(doc, docName);
        if (refused) throw refused;
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
        dropUnattached(docName, doc, createdForUpgrade);
        log.error(UPGRADE_FAILED_LOG, { docName: roomLogId(docName), err: err.message });
        if (!socket.destroyed) reject(socket, err.status ?? STATUS.UNAVAILABLE);
      })
      .finally(leave);
  };

  return { attach };
}
