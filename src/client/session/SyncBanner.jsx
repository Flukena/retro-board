import React, { useState, useSyncExternalStore } from 'react';
import { Button, Surface } from '../ui/UiPrimitives.jsx';
import { t, useLang } from '../ui/i18n.js';
import { refreshActiveRoomSession, canRefreshRoomSession } from './room-session.js';
import { SYNC_STATE } from './sync-status.js';
import { PublicCreationNotice } from './PublicCreationNotice.jsx';
import { TOAST_BOTTOM_PX, Z } from '../chrome/chrome-layout.js';
import './client-resilience.css';

export function useSyncStatus() {
  return useSyncExternalStore(window.storage.onSyncStatus, window.storage.getSyncStatus);
}

export function SyncBanner() {
  const state = useSyncStatus();
  return <><SyncStatusBanner state={state} /><PublicCreationNotice syncStatus={state.status} /></>;
}

export function SyncStatusBanner({ state }) {
  useLang();
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  // Saving is the normal moment between an encrypted edit and its acknowledgement; only the unload guard shows it.
  if (state.status === SYNC_STATE.CONNECTED || state.status === SYNC_STATE.SAVING) return null;
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
      style={{ '--rb-sync-bottom-px': `${TOAST_BOTTOM_PX}px`, zIndex: Z.TOAST }}>
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
