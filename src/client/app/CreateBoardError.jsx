import React from 'react';
import { t } from '../ui/i18n.js';
import { ROOM_SESSION_ERROR } from '../session/room-session.js';
import { MAX_OWNED_ROOMS_PER_ACCOUNT } from '../../domain/room-ownership.js';
import { CREATE_ERROR, CREATE_LOCK_ERROR, CREATE_RETRY_FALLBACK_SECONDS } from './create-board-error.js';


const messageFor = (error) => {
  if (error.code === ROOM_SESSION_ERROR.RATE_LIMITED) {
    return t('landing.create.error.rateLimited', { seconds: error.retryAfterSeconds || CREATE_RETRY_FALLBACK_SECONDS });
  }
  if (error.code === CREATE_LOCK_ERROR.SIGN_IN_REQUIRED) return t('landing.create.error.signIn');
  if (error.code === CREATE_LOCK_ERROR.PLAN_REQUIRED) return t('landing.create.error.plan');
  if (error.code === CREATE_ERROR.OWNED_ROOM_LIMIT) return t('landing.create.error.ownedRoomLimit', { max: MAX_OWNED_ROOMS_PER_ACCOUNT });
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
