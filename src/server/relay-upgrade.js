import { HTTP_STATUS } from './relay-status-codes.js';
import { isExactAllowedOrigin } from './relay-http.js';
import { roomTargetFromRequest, tokenDocNameFromRequest } from './relay-room-target.js';
import { CORRUPT_LOCK } from './room-lock-record.js';

export function createUpgradeHandler({ settings, roomRegistry, accounting, docs, roomFence, wsTraffic, isRoomBlocked, hasActiveRoomCapacity, takeWsUpgradeToken, clientIpFromRequest, authenticatedDocFromRequest, roomKeyEpoch, e2eRelay, plainUpgrades, rejectUpgrade }) {
  const { PUBLIC_WALL, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP, ALLOW_LEGACY_URL_TOKENS, ALLOW_LEGACY_ROOMS } = settings;
  const { registeredRoomsByHandle, registeredDocs, existingDocNames } = roomRegistry;
  const resolveDocument = (req, handle) => {
    const legacyDoc = !handle && ALLOW_LEGACY_URL_TOKENS ? tokenDocNameFromRequest(req, { allowLegacyRooms: ALLOW_LEGACY_ROOMS }) : null;
    return handle ? registeredRoomsByHandle.get(handle)
      : legacyDoc && (registeredDocs.has(legacyDoc) || (ALLOW_LEGACY_ROOMS && existingDocNames.has(legacyDoc))) && legacyDoc;
  };

  const authorizeRoom = (req, socket, docName, roomTarget, handle) => {
    // Locked rooms are served only on /e2e and normal rooms never are; an unreadable lock is never served.
    const lock = roomRegistry.lockFor(docName);
    if (lock === CORRUPT_LOCK || Boolean(lock) !== Boolean(roomTarget?.e2e)) {
      rejectUpgrade(socket, lock === CORRUPT_LOCK ? HTTP_STATUS.UNAVAILABLE : HTTP_STATUS.NOT_FOUND);
      return null;
    }
    const session = handle ? authenticatedDocFromRequest(req, handle) : null;
    if (handle && !session) {
      rejectUpgrade(socket, HTTP_STATUS.UNAUTHORIZED);
      return null;
    }
    const expiresAt = session?.expiresAt || null;
    return { expiresAt };
  };

  const attachAdmitted = (req, socket, head, docName, roomTarget, expiresAt) => {
    // Reject known-doomed upgrades before getYDoc can allocate and hydrate a
    // room that will never receive a connection.
    if (accounting.shuttingDown || accounting.storageFailure || isRoomBlocked(docName)) {
      rejectUpgrade(socket, HTTP_STATUS.UNAVAILABLE);
      return;
    }
    const e2e = Boolean(roomTarget?.e2e);
    const coldRoom = e2e ? e2eRelay.connectionsFor(docName) === 0 : !docs.has(docName);
    if (coldRoom && !hasActiveRoomCapacity()) {
      rejectUpgrade(socket, HTTP_STATUS.UNAVAILABLE);
      return;
    }
    const clientIp = clientIpFromRequest(req);
    if (!takeWsUpgradeToken(clientIp, docName, coldRoom)) {
      rejectUpgrade(socket, HTTP_STATUS.TOO_MANY_REQUESTS);
      return;
    }
    // Taken in the same tick as the room lookup and held until attach: a room being deleted answers like a missing one.
    const leave = roomFence.enter(docName);
    const reservation = leave ? wsTraffic.reserve(clientIp, docName) : { status: HTTP_STATUS.NOT_FOUND };
    if (reservation.status) {
      leave?.();
      rejectUpgrade(socket, reservation.status);
      return;
    }
    socket.once('close', reservation.release);
    req.wsSecurityContext = {
      docName,
      clientIp,
      expiresAt,
      expectedAwarenessClientId: roomTarget?.awarenessClientId ?? null,
      supportsQuota: roomTarget?.supportsQuota ?? false,
      e2e, keyEpoch: roomKeyEpoch(docName),
    };
    if (e2e) {
      e2eRelay.handleUpgrade(req, socket, head);
      leave();
      return;
    }
    // Same canonical name as setupWSConnection, so hydration and the attachment cannot diverge between path forms.
    plainUpgrades.attach(req, socket, head, docName, leave);
  };

  const handleUpgrade = (req, socket, head) => {
    // Origin allowlist — set YJS_ALLOWED_ORIGINS in prod to lock the relay to
    // the public site. Browsers always send Origin on WS handshakes; non-browser
    // clients can spoof it but at least defeats opportunistic CSRF-style abuse
    // from a malicious site running a ws() in the user's tab.
    const origin = req.headers.origin || '';
    if (!isExactAllowedOrigin(origin, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP)) {
      rejectUpgrade(socket, HTTP_STATUS.FORBIDDEN);
      return;
    }
    const roomTarget = roomTargetFromRequest(req, { publicWall: PUBLIC_WALL });
    const handle = roomTarget?.handle || null;
    // Resolve the canonical room first, on every route, so the lock check below covers legacy URLs too.
    const docName = resolveDocument(req, handle);
    if (!docName) {
      rejectUpgrade(socket, HTTP_STATUS.NOT_FOUND);
      return;
    }
    const authorized = authorizeRoom(req, socket, docName, roomTarget, handle);
    if (!authorized) return;
    const { expiresAt } = authorized;
    attachAdmitted(req, socket, head, docName, roomTarget, expiresAt);
  };

  return { handleUpgrade };
}
