import { userKeyPrefix } from './kv-keys.js';
export function attachRoomDiagnostics({ provider, route }) {
  // Use the visible board code in diagnostics. The actual provider room handle
  // is non-secret, but omitting it keeps logs stable and easy to correlate.
  const ROOM_LABEL = `board-${route.code || 'unused'}`;

  if (provider) {
    provider.on('status', (ev) => {
      console.debug('[yjs]', ROOM_LABEL, ev.status);
    });
  }
}

export function installBridgeDebugHandles({ provider, ydoc, ymap, yItems, yMeta, clientId, roomHandle }) {
  window.__rbYDoc = ydoc;
  window.__rbClientId = clientId;
  window.__rbRoom = roomHandle;
  window.__rbYItems = yItems;
  window.__rbYMeta = yMeta;
  window.__rbProvider = provider;
  window.__rbDebug = () => ({
    room: roomHandle,
    clientId,
    yClientID: ydoc.clientID,
    synced: !!provider?.synced,
    yMetaAdminUserId: yMeta.get('adminUserId') || null,
    yMetaAdminName: yMeta.get('adminName') || null,
    yMetaAll: Array.from(yMeta.entries()).filter(([k]) => !k.startsWith('__')),
    uScopeKeys: Array.from(ymap.entries()).filter(([k]) => k.startsWith(userKeyPrefix(clientId))),
    awareness: Array.from((provider?.awareness?.getStates?.() || new Map()).entries()),
    yItemsCount: yItems.size,
  });
}
