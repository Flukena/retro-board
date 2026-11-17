import React from 'react';
import { Clock } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { ACCOUNT_STATUS } from '../account/account-api.js';
import { useAccountSession } from '../account/use-account-session.js';
import { GUEST_ROOM_RETENTION_HOURS } from '../../domain/room-retention.js';

const ICON_SIZE_PX = 14;

// Hidden while the account is loading and for signed-in users, whose boards are kept.
const showsGuestRoomNote = (session) => session !== null && session.status !== ACCOUNT_STATUS.SIGNED_IN;

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
