import React from 'react';
import { t } from '../ui/i18n.js';

export default function BoardLoading() {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', color: 'var(--text-muted)',
      fontFamily: 'var(--font-ui)',
    }}
    >{t('loading') || 'Loading…'}
    </div>
  );
}
