import React from 'react';
import { t } from '../ui/i18n.js';
import { ROOM_SESSION_ERROR } from '../session/room-session.js';
import { CREATE_RETRY_FALLBACK_SECONDS } from './create-board-error.js';


export default function CreateBoardError({ error, className = 'rb-landing__error' }) {
  if (!error) return null;
  return (
    <div role="alert" className={className}>
      {error.code === ROOM_SESSION_ERROR.RATE_LIMITED
        ? t('landing.create.error.rateLimited', { seconds: error.retryAfterSeconds || CREATE_RETRY_FALLBACK_SECONDS })
        : t('landing.create.error.unavailable')}
    </div>
  );
}
