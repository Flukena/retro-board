import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { t, useLang } from '../ui/i18n.js';
import { Button } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import RoomBootstrapScreen from '../app/RoomBootstrapScreen.jsx';
import { ROOM_BOOTSTRAP_STATUS, useRoomBootstrap } from '../app/use-room-bootstrap.js';
import { gotoBoard } from '../app/router.js';
import { ROOM_SESSION_ERROR, RoomSessionError, establishRoomSession } from '../session/room-session.js';
import { SYNC_STATE } from '../session/sync-status.js';
import { createRandomId } from '../session/random-id.js';
import { loadPokerIdentity } from './poker-identity.js';
import { openPokerRoom } from './poker-session.js';
import { createPokerRoomStore } from './poker-room-store.js';
import PokerApp from './PokerApp.jsx';
import './poker.css';

function useOpenPokerRoom() {
  const [opened, setOpened] = useState(null);
  useEffect(() => {
    const session = openPokerRoom();
    const identity = loadPokerIdentity(createRandomId, localStorage);
    const store = createPokerRoomStore(session, identity, { createId: createRandomId });
    setOpened({ session, store, identity });
    return () => {
      store.destroy();
      session.destroy();
    };
  }, []);
  return opened;
}

function Notice({ children }) {
  return <main className="rb-poker-notice"><section role="status">{children}</section></main>;
}

function PokerRoom({ code, token }) {
  useLang();
  const opened = useOpenPokerRoom();
  if (!opened) return <Notice>{t('poker.loading')}</Notice>;
  return <SyncedPokerRoom code={code} token={token} {...opened} />;
}

// Waits for the relay's copy of the room before deciding what kind it is, so
// a guest never claims a room that the creator already set up.
function SyncedPokerRoom({ code, token, session, store, identity }) {
  const sync = useSyncExternalStore(session.syncStatus.subscribe, session.syncStatus.getSnapshot);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const synced = sync.status === SYNC_STATE.CONNECTED || snapshot.room.isPoker;
  const claimable = synced && !snapshot.room.isPoker && !snapshot.hasBoardContent;
  useEffect(() => { if (claimable) store.claimRoom(); }, [claimable, store]);
  if (synced && snapshot.hasBoardContent && !snapshot.room.isPoker) {
    return (
      <Notice>
        <p>{t('poker.wrongKind.head')}</p>
        <Button variant={BUTTON_VARIANT.PRIMARY} onClick={() => gotoBoard(code, token)}>{t('poker.wrongKind.open')}</Button>
      </Notice>
    );
  }
  if (!snapshot.room.isPoker) return <Notice>{t('poker.loading')}</Notice>;
  return <PokerApp code={code} token={token} store={store} syncStatus={session.syncStatus} initialName={identity.userName} />;
}

export default function PokerBootstrap({ code, token }) {
  const state = useRoomBootstrap(async () => {
    if (!token) throw new RoomSessionError(ROOM_SESSION_ERROR.INVALID);
    await establishRoomSession(code, token);
  }, `${code}:${token}`);
  if (state.status === ROOM_BOOTSTRAP_STATUS.READY) return <PokerRoom code={code} token={token} />;
  return <RoomBootstrapScreen status={state.status} retryAfterSeconds={state.retryAfterSeconds} onRetry={state.retry} />;
}
