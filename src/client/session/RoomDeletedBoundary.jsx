import React, { useEffect, useId, useSyncExternalStore } from 'react';
import { t } from '../ui/i18n.js';
import SitePage from '../app/SitePage.jsx';
import { ButtonLink } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { ROOM_KIND, forgetRecent } from '../app/router.js';
import { forgetWhenDeleted, pageRoomDeleted } from './room-deleted.js';

const TITLE_KEYS = Object.freeze({ [ROOM_KIND.BOARD]: 'roomDeleted.title.board', [ROOM_KIND.POKER]: 'roomDeleted.title.poker' });

/** Full page shown instead of a room its owner deleted. */
export function RoomDeletedScreen({ kind }) {
  const titleId = useId();
  return (
    <SitePage labelledBy={titleId} homeLink={false}>
      <h1 id={titleId} className="rb-legal__title">{t(TITLE_KEYS[kind])}</h1>
      <p className="rb-template__lede">{t('roomDeleted.body')}</p>
      <p><ButtonLink variant={BUTTON_VARIANT.PRIMARY} href="/">{t('room.bootstrap.home')}</ButtonLink></p>
    </SitePage>
  );
}

/** Wraps a private room view: once the room is deleted it forgets the room from recents and shows the deleted screen. */
export default function RoomDeletedBoundary({
  code, token, kind = ROOM_KIND.BOARD, roomDeleted = pageRoomDeleted, forget = forgetRecent, children,
}) {
  const deleted = useSyncExternalStore(roomDeleted.subscribe, roomDeleted.isDeleted, roomDeleted.isDeleted);
  useEffect(() => forgetWhenDeleted(roomDeleted, { code, token, forget }), [roomDeleted, code, token, forget]);
  return deleted ? <RoomDeletedScreen kind={kind} /> : children;
}
