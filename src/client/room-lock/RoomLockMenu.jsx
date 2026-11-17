import React, { useSyncExternalStore } from 'react';
import { KeyRound, Pencil, UserX } from 'lucide-react';
import { Divider, MenuItem } from '../ui/UiPrimitives.jsx';
import { DIVIDER_ORIENTATION, MENU_ITEM_VARIANT } from '../ui/ui-variants.js';
import { TOPBAR_ICON_SIZE_PX } from '../chrome/chrome-layout.js';
import { t } from '../ui/i18n.js';
import { ROOM_KEY_CHANGED_EVENT, getRoomKey } from './lock-session.js';
import { canManageRoomLock } from './room-lock-form.js';
import { ROOM_LOCK_DIALOG, roomLockDialog } from './room-lock-dialog-store.js';

const subscribeToKey = (listener) => {
  globalThis.window?.addEventListener(ROOM_KEY_CHANGED_EVENT, listener);
  return () => globalThis.window?.removeEventListener(ROOM_KEY_CHANGED_EVENT, listener);
};
const ownsOpenRoom = () => canManageRoomLock(getRoomKey());
const serverOwnsNothing = () => false;

/** The owner's entries in the More menu; nothing for anyone else. The relay cannot read a locked board's title, so its owner renames it here. */
export function RoomLockMenuItems({ isOwner, onSelect }) {
  if (!isOwner) return null;
  return (
    <>
      <Divider orientation={DIVIDER_ORIENTATION.HORIZONTAL} />
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
    </>
  );
}

/** Rendered inside MorePopover; the dialogs open outside it (RoomLockDialogs), because the popover closes on click. */
export default function RoomLockMenu({ onClose }) {
  const isOwner = useSyncExternalStore(subscribeToKey, ownsOpenRoom, serverOwnsNothing);
  const select = (dialog) => {
    onClose();
    roomLockDialog.set(dialog);
  };
  return <RoomLockMenuItems isOwner={isOwner} onSelect={select} />;
}
