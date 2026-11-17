import React from 'react';
import { Clock } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { ACCOUNT_STATUS } from '../account/account-api.js';
import { useAccountSession } from '../account/use-account-session.js';
import { GUEST_ROOM_RETENTION_HOURS } from '../../domain/room-retention.js';

const ICON_SIZE_PX = 14;

// Only a definite "signed out": loading, a relay blip (unavailable) or sign-in being off (disabled) say nothing.
const showsGuestRoomNote = (session) => session?.status === ACCOUNT_STATUS.SIGNED_OUT;

/** Stateless, so each account state renders on its own in tests. */
export function GuestRoomNoteView({ session }) {
  if (!showsGuestRoomNote(session)) return null;
  return (
    <p className="rb-landing__guest-note" role="note">
      <Clock size={ICON_SIZE_PX} aria-hidden="true" />
      {t('landing.guestNote', { hours: GUEST_ROOM_RETENTION_HOURS })}
    </p>
  );
}

/** Tells signed-out visitors how long a board made without an account lasts. */
export default function GuestRoomNote() {
  return <GuestRoomNoteView session={useAccountSession()} />;
}
