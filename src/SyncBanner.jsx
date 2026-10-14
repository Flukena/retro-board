import React, { useState, useSyncExternalStore } from 'react';
import { Button, Surface } from './UiPrimitives.jsx';
import { t, useLang } from './i18n.js';
import { refreshActiveRoomSession, canRefreshRoomSession } from './room-session.js';
import { SYNC_STATE } from './sync-status.js';
import { TOAST_BOTTOM_PX, Z } from './chrome-layout.js';
import './client-resilience.css';

export function useSyncStatus() {
  return useSyncExternalStore(window.storage.onSyncStatus, window.storage.getSyncStatus);
}

export function SyncBanner() {
  const state = useSyncStatus();
  return <SyncStatusBanner state={state} />;
}

export function SyncStatusBanner({ state }) {
  useLang();
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  if (state.status === SYNC_STATE.CONNECTED) return null;
  const sessionLost = state.status === SYNC_STATE.SESSION_LOST;
  const canReenter = canRefreshRoomSession();
  const reenter = async () => {
    setRetrying(true);
    setRetryFailed(false);
    try { await refreshActiveRoomSession(); }
    catch { setRetryFailed(true); }
    finally { setRetrying(false); }
  };
  return (
    <Surface role="status" aria-live="polite" className="rb-sync-banner"
      style={{ bottom: TOAST_BOTTOM_PX, zIndex: Z.TOAST }}>
      <span>{t(`resilience.${state.status}`)}</span>
      {state.hasUnsyncedLocalChanges && <span>{t('resilience.pending')}</span>}
      {sessionLost && !canReenter && <span>{t('resilience.reopen')}</span>}
      {sessionLost && canReenter && (
        <Button disabled={retrying} onClick={reenter}>{t('resilience.reenter')}</Button>
      )}
      {sessionLost && retryFailed && <span>{t('resilience.retryFailed')}</span>}
    </Surface>
  );
}
