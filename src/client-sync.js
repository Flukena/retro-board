import { SYNC_STATE, SyncStatus, shouldGuardUnload } from './sync-status.js';
import { ROOM_SESSION_HEALTH, getRoomSessionHealth, onRoomSessionHealth } from './room-session.js';

const SESSION_POLICY_CLOSE_CODE = 1008;
const SESSION_EXPIRED_REASON = 'session expired';

function hasSharedLocalChange(doc, transaction) {
  if (!transaction.local) return false;
  if (['items', 'meta'].some((name) => transaction.changedParentTypes.has(doc.getMap(name)))) return true;
  const changedKeys = transaction.changed.get(doc.getMap('kv'));
  return changedKeys && [...changedKeys].some((key) => key?.startsWith('s|'));
}

export function attachClientSync(provider, doc, browser) {
  const state = new SyncStatus();
  const onStatus = ({ status }) => state.transport(status);
  const onSync = (synced) => { if (synced) state.synced(provider.wsconnected); };
  const onClose = (event) => {
    state.transport(SYNC_STATE.DISCONNECTED);
    if (event?.code === SESSION_POLICY_CLOSE_CODE && event.reason === SESSION_EXPIRED_REASON) state.sessionLost(true);
  };
  const onTransaction = (transaction) => {
    if (hasSharedLocalChange(doc, transaction)) state.localChange(provider.wsconnected && provider.synced);
  };
  const onHealth = () => {
    const lost = getRoomSessionHealth() === ROOM_SESSION_HEALTH.LOST;
    state.sessionLost(lost);
    if (!lost && !provider.wsconnected) { provider.disconnect(); provider.connect(); }
  };
  const onUnload = (event) => {
    if (!shouldGuardUnload(state.getSnapshot())) return;
    event.preventDefault();
    event.returnValue = '';
  };
  provider.on('status', onStatus);
  provider.on('sync', onSync);
  provider.on('connection-close', onClose);
  doc.on('afterTransaction', onTransaction);
  browser.addEventListener('beforeunload', onUnload);
  const unsubscribe = onRoomSessionHealth(onHealth);
  doc.on('destroy', () => {
    unsubscribe();
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
