import React, { useState, useSyncExternalStore } from 'react';
import { BookmarkMinus, KeyRound, Pencil, UserX } from 'lucide-react';
import { Divider, MenuItem } from '../ui/UiPrimitives.jsx';
import { DIVIDER_ORIENTATION, MENU_ITEM_VARIANT } from '../ui/ui-variants.js';
import { TOPBAR_ICON_SIZE_PX } from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';
import { ROOM_KEY_CHANGED_EVENT, ROOM_REMEMBER_CHANGED_EVENT, forgetRememberedRoom, getRoomKey } from './lock-session.js';
import { canManageRoomLock } from './room-lock-form.js';
import { ROOM_LOCK_DIALOG, ROOM_LOCK_NOTICE, roomLockDialog, roomLockNotice } from './room-lock-dialog-store.js';

const ROOM_LOCK_MENU_EVENTS = [ROOM_KEY_CHANGED_EVENT, ROOM_REMEMBER_CHANGED_EVENT];
const subscribeToRoomLock = (listener) => {
  const target = globalThis.window;
  ROOM_LOCK_MENU_EVENTS.forEach((event) => target?.addEventListener(event, listener));
  return () => ROOM_LOCK_MENU_EVENTS.forEach((event) => target?.removeEventListener(event, listener));
};
const ownsOpenRoom = () => canManageRoomLock(getRoomKey());
const remembersOpenRoom = () => getRoomKey()?.remembered === true;
const serverHasNoRoomLock = () => false;

/** Owner controls and the action that removes the browser's saved unlock. */
export function RoomLockMenuItems({ isOwner, remembered, forgetting, onSelect, onForget }) {
  if (!isOwner && !remembered) return null;
  return (
    <>
      <Divider orientation={DIVIDER_ORIENTATION.HORIZONTAL} />
      {isOwner && <>
        <MenuItem
          icon={<Pencil size={TOPBAR_ICON_SIZE_PX.MENU} />}
          label={t('roomLock.menu.rename')}
          onClick={() => onSelect(ROOM_LOCK_DIALOG.RENAME)}
        />
        <MenuItem
          icon={<KeyRound size={TOPBAR_ICON_SIZE_PX.MENU} />}
          label={t('roomLock.menu.changePassword')}
          onClick={() => onSelect(ROOM_LOCK_DIALOG.PASSWORD)}
        />
        <MenuItem
          icon={<UserX size={TOPBAR_ICON_SIZE_PX.MENU} />}
          label={t('roomLock.menu.removeEveryone')}
          variant={MENU_ITEM_VARIANT.DANGER}
          onClick={() => onSelect(ROOM_LOCK_DIALOG.ROTATE)}
        />
      </>}
      {remembered && <MenuItem
        icon={<BookmarkMinus size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={t('roomLock.menu.forget')}
        disabled={forgetting}
        onClick={onForget}
      />}
    </>
  );
}

/** Rendered inside MorePopover; the dialogs open outside it (RoomLockDialogs), because the popover closes on click. */
export default function RoomLockMenu({ onClose }) {
  const isOwner = useSyncExternalStore(subscribeToRoomLock, ownsOpenRoom, serverHasNoRoomLock);
  const remembered = useSyncExternalStore(subscribeToRoomLock, remembersOpenRoom, serverHasNoRoomLock);
  const [forgetting, setForgetting] = useState(false);
  const select = (dialog) => {
    onClose();
    roomLockDialog.set(dialog);
  };
  const forget = async () => {
    setForgetting(true);
    try {
      if (await forgetRememberedRoom()) onClose();
      else roomLockNotice.set(ROOM_LOCK_NOTICE.FORGET_FAILED);
    } finally {
      setForgetting(false);
    }
  };
  return <RoomLockMenuItems isOwner={isOwner} remembered={remembered} forgetting={forgetting} onSelect={select} onForget={forget} />;
}
