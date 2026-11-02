import { SYNC_STATE, SyncStatus, shouldGuardUnload } from './sync-status.js';
import { PUBLIC_ACTION_LIMIT_REASON } from '../../domain/public-wall-contract.js';
import { ROOM_SESSION_HEALTH, getRoomSessionHealth, onRoomSessionHealth, isPublicRoomSession, refreshActiveRoomSession } from './room-session.js';

const SESSION_POLICY_CLOSE_CODE = 1008;
const SESSION_EXPIRED_REASON = 'session expired';

// Top-level maps whose local edits must reach the relay before unload.
// Board rooms use these; other room kinds pass their own list.
export const BOARD_SHARED_MAP_NAMES = Object.freeze(['items', 'meta']);

function hasSharedLocalChange(doc, transaction, sharedMapNames) {
  if (!transaction.local) return false;
  if (sharedMapNames.some((name) => transaction.changedParentTypes.has(doc.getMap(name)))) return true;
  const changedKeys = transaction.changed.get(doc.getMap('kv'));
  return changedKeys && [...changedKeys].some((key) => key?.startsWith('s|'));
}

export function attachClientSync(provider, doc, browser, { sharedMapNames = BOARD_SHARED_MAP_NAMES } = {}) {
  const state = new SyncStatus();
  const onStatus = ({ status }) => state.transport(status);
  const onSync = (synced) => { if (synced) state.synced(provider.wsconnected); };
  const onClose = (event) => {
    state.transport(SYNC_STATE.DISCONNECTED);
    if (event?.code === SESSION_POLICY_CLOSE_CODE && event.reason === SESSION_EXPIRED_REASON) state.socketExpired();
    if (event?.code === SESSION_POLICY_CLOSE_CODE && event.reason === PUBLIC_ACTION_LIMIT_REASON) {
      state.actionLimitReached();
      provider.disconnect();
    }
  };
  const onTransaction = (transaction) => {
    if (hasSharedLocalChange(doc, transaction, sharedMapNames)) state.localChange(provider.wsconnected && provider.synced);
  };
  const onHealth = () => {
    if (state.getSnapshot().status === SYNC_STATE.ACTION_LIMIT) return;
    if (getRoomSessionHealth() === ROOM_SESSION_HEALTH.REPLACED) {
      provider.disconnect();
      browser.removeEventListener('beforeunload', onUnload);
      browser.location.reload();
      return;
    }
    const lost = getRoomSessionHealth() === ROOM_SESSION_HEALTH.LOST;
    state.sessionLost(lost);
    if (!lost && !provider.wsconnected) { provider.disconnect(); provider.connect(); }
  };
  const onUnload = (event) => {
    if (!shouldGuardUnload(state.getSnapshot())) return;
    event.preventDefault();
    event.returnValue = '';
  };
  const onConnectionError = () => {
    if (isPublicRoomSession()) void refreshActiveRoomSession().catch(onHealth);
  };
  provider.on('connection-error', onConnectionError);
  provider.on('status', onStatus);
  provider.on('sync', onSync);
  provider.on('connection-close', onClose);
  doc.on('afterTransaction', onTransaction);
  browser.addEventListener('beforeunload', onUnload);
  const unsubscribe = onRoomSessionHealth(onHealth);
  doc.on('destroy', () => {
    unsubscribe();
    provider.off('connection-error', onConnectionError);
    provider.off('status', onStatus);
    provider.off('sync', onSync);
    provider.off('connection-close', onClose);
    doc.off('afterTransaction', onTransaction);
    browser.removeEventListener('beforeunload', onUnload);
  });
  state.sessionLost(getRoomSessionHealth() === ROOM_SESSION_HEALTH.LOST);
  onSync(provider.synced);
  return state;
}
