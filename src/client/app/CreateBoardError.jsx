import React from 'react';
import { t } from '../ui/i18n.js';
import { ROOM_SESSION_ERROR } from '../session/room-session.js';
import { CREATE_LOCK_ERROR, CREATE_RETRY_FALLBACK_SECONDS } from './create-board-error.js';


const messageFor = (error) => {
  if (error.code === ROOM_SESSION_ERROR.RATE_LIMITED) {
    return t('landing.create.error.rateLimited', { seconds: error.retryAfterSeconds || CREATE_RETRY_FALLBACK_SECONDS });
  }
  if (error.code === CREATE_LOCK_ERROR.SIGN_IN_REQUIRED) return t('landing.create.error.signIn');
  if (error.code === CREATE_LOCK_ERROR.PLAN_REQUIRED) return t('landing.create.error.plan');
  return t('landing.create.error.unavailable');
};

export default function CreateBoardError({ error, className = 'rb-landing__error' }) {
  if (!error) return null;
  return (
    <div role="alert" className={className}>
      {messageFor(error)}
    </div>
  );
}
