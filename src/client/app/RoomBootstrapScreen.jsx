import React from 'react';
import { gotoLanding } from './router.js';
import { ROOM_SESSION_ERROR } from '../session/room-session.js';
import { t } from '../ui/i18n.js';

// Full-page status shown while a room link is checked, or why it failed.
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

export default function RoomBootstrapScreen({ status, retryAfterSeconds, onRetry, publicFull = false }) {
  const copy = publicFull ? { title: t('public.full'), body: t('public.watch') } : statusCopy(status, retryAfterSeconds);
  const checking = status === 'checking';
  return (
    <main
      aria-busy={checking}
      style={{
        position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
        padding: 24, boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <section
        role={checking ? 'status' : 'alert'}
        style={{
          width: '100%', maxWidth: 440, padding: 28, boxSizing: 'border-box',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
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
                padding: '9px 15px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-icon-tile)',
                background: 'var(--bg-panel-2)', color: 'var(--text)', cursor: 'pointer', fontWeight: 700,
              }}
            >
              {t('room.bootstrap.home')}
            </button>
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: '9px 15px', border: 'none', borderRadius: 'var(--radius-icon-tile)',
                background: 'var(--accent)', color: 'var(--accent-fg)', cursor: 'pointer', fontWeight: 700,
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
