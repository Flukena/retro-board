import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.js'; // apply CSS variables on <html> before first paint
import RetroBoard from '../RetroBoard.jsx';
import Landing from './Landing.jsx';
import { t } from './i18n.js';
import {
  isBoardCreatedByMe, gotoLanding, parseRoute, rememberRecent,
} from './router.js';
import {
  ROOM_SESSION_ERROR,
  RoomSessionError,
  establishRoomSession,
} from './room-session.js';

const route = parseRoute();

const statusCopy = (status, retryAfterSeconds) => {
  if (status === ROOM_SESSION_ERROR.INVALID) {
    return {
      title: t('room.bootstrap.invalid.title'),
      body: t('room.bootstrap.invalid.body'),
    };
  }
  if (status === ROOM_SESSION_ERROR.RATE_LIMITED) {
    return {
      title: t('room.bootstrap.rateLimited.title'),
      body: t('room.bootstrap.rateLimited.body', { seconds: retryAfterSeconds || 2 }),
    };
  }
  if (status === ROOM_SESSION_ERROR.UNAVAILABLE) {
    return {
      title: t('room.bootstrap.unavailable.title'),
      body: t('room.bootstrap.unavailable.body'),
    };
  }
  return {
    title: t('room.bootstrap.checking.title'),
    body: t('room.bootstrap.checking.body'),
  };
};

function RoomBootstrapScreen({ status, retryAfterSeconds, onRetry }) {
  const copy = statusCopy(status, retryAfterSeconds);
  const checking = status === 'checking';
  return (
    <main
      aria-busy={checking}
      style={{
        position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
        padding: 24, boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text)',
        fontFamily: '"Plus Jakarta Sans", "Sarabun", sans-serif',
      }}
    >
      <section
        role={checking ? 'status' : 'alert'}
        style={{
          width: '100%', maxWidth: 440, padding: 28, boxSizing: 'border-box',
          border: '1px solid var(--border)', borderRadius: 16,
          background: 'var(--bg-panel)', boxShadow: 'var(--shadow-card)', textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 10 }}>{copy.title}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>{copy.body}</div>
        {!checking && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 20 }}>
            <button
              type="button"
              onClick={gotoLanding}
              style={{
                padding: '9px 15px', border: '1px solid var(--border-strong)', borderRadius: 9,
                background: 'var(--bg-panel-2)', color: 'var(--text)', cursor: 'pointer', fontWeight: 700,
              }}
            >
              {t('room.bootstrap.home')}
            </button>
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: '9px 15px', border: 'none', borderRadius: 9,
                background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 700,
              }}
            >
              {t('room.bootstrap.retry')}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function BoardBootstrap({ code, token }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: 'checking', retryAfterSeconds: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'checking', retryAfterSeconds: null });
    (async () => {
      try {
        if (!token) throw new RoomSessionError(ROOM_SESSION_ERROR.INVALID);
        await establishRoomSession(code, token);
        // The storage module creates its WebsocketProvider as a side effect.
        // Import it only after the server has issued the board-scoped cookie.
        await import('./storage-bridge.js');
        if (cancelled) return;
        if (isBoardCreatedByMe(code, token)) {
          // Forwarded links are deliberately not persisted as recents because
          // doing so would retain their long-lived fragment capability.
          rememberRecent(code, undefined, token);
        }
        setState({ status: 'ready', retryAfterSeconds: null });
      } catch (error) {
        if (cancelled) return;
        const status = error instanceof RoomSessionError
          ? error.code
          : ROOM_SESSION_ERROR.UNAVAILABLE;
        setState({
          status,
          retryAfterSeconds: error instanceof RoomSessionError
            ? error.retryAfterSeconds
            : null,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [attempt, code, token]);

  if (state.status === 'ready') {
    return <RetroBoard boardCode={code} boardToken={token} />;
  }
  return (
    <RoomBootstrapScreen
      status={state.status}
      retryAfterSeconds={state.retryAfterSeconds}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

const App = route.kind === 'board'
  ? <BoardBootstrap code={route.code} token={route.token} />
  : <Landing />;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>{App}</React.StrictMode>,
);
