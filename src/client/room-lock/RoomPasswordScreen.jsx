import React from 'react';
import { t } from '../ui/i18n.js';
import PasswordPrompt from './PasswordPrompt.jsx';

/** Full-page password prompt shown before a locked board boots. */
export default function RoomPasswordScreen({ onUnlock }) {
  return (
    <main
      style={{
        position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
        padding: 24, boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <section
        aria-labelledby="room-password-title"
        style={{
          width: '100%', maxWidth: 440, padding: 28, boxSizing: 'border-box',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
          background: 'var(--bg-panel)', boxShadow: 'var(--shadow-card)',
        }}
      >
        <h1 id="room-password-title" style={{ fontSize: 20, fontWeight: 800, margin: '0 0 10px' }}>{t('roomLock.prompt.title')}</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6, margin: '0 0 18px' }}>{t('roomLock.prompt.body')}</p>
        <PasswordPrompt submit={onUnlock} submitLabel={t('roomLock.prompt.submit')} />
      </section>
    </main>
  );
}
