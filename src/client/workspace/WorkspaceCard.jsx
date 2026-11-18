import React, { useId, useRef } from 'react';
import { ArrowUpRight, Lock, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { t } from '../ui/i18n.js';
import { focusIfInside } from '../ui/focus-return.js';
import { formatRelativeTime } from '../ui/relative-time.js';
import { useDismiss } from '../ui/useDismiss.js';
import { Divider, MenuItem, MenuLink } from '../ui/UiPrimitives.jsx';
import { DIVIDER_ORIENTATION, MENU_ITEM_VARIANT } from '../ui/ui-variants.js';
import { TemplateThumbnail } from '../templates/TemplateThumbnail.jsx';
import {
  CARD_ACTIVITY, CARD_THUMBNAIL, RENAME_ACTION, cardActivityOf, cardThumbnailOf, renameActionOf, roomNameOf,
} from './workspace-model.js';

// The card thumbnail band, drawn in viewBox units and stretched to the band by CSS.
const ZONES_BOX = Object.freeze({ width: 280, height: 140, padding: 14 });
const LOCK_ICON_SIZE_PX = 22;
const MORE_ICON_SIZE_PX = 20;
const MENU_ICON_SIZE_PX = 18;
// A short Fibonacci hand; the middle card is the picked one.
const POKER_HAND = Object.freeze(['3', '5', '8']);
const POKER_PICKED_INDEX = 1;
const ACTIVITY_KEYS = Object.freeze({
  [CARD_ACTIVITY.LAST_ACTIVE]: 'myBoards.lastActive',
  [CARD_ACTIVITY.CREATED]: 'myBoards.created',
});

function ZonesThumbnail({ zones }) {
  return <TemplateThumbnail zones={zones} {...ZONES_BOX} className="rb-workspace-card__zones" />;
}

function LockedThumbnail() {
  return <span className="rb-workspace-card__lock"><Lock size={LOCK_ICON_SIZE_PX} /></span>;
}

function PokerThumbnail() {
  return POKER_HAND.map((label, index) => (
    <span key={label}
      className={index === POKER_PICKED_INDEX ? 'rb-workspace-card__poker-card rb-workspace-card__poker-card--picked' : 'rb-workspace-card__poker-card'}>
      {label}
    </span>
  ));
}

function EmptyThumbnail() {
  return <span className="rb-workspace-card__no-zones">{t('workspace.card.noZones')}</span>;
}

const THUMBNAILS = Object.freeze({
  [CARD_THUMBNAIL.ZONES]: ZonesThumbnail,
  [CARD_THUMBNAIL.LOCKED]: LockedThumbnail,
  [CARD_THUMBNAIL.POKER]: PokerThumbnail,
  [CARD_THUMBNAIL.EMPTY]: EmptyThumbnail,
});

function CardBadge({ kind }) {
  if (kind === CARD_THUMBNAIL.POKER) return <span className="rb-workspace-card__badge">{t('poker.title')}</span>;
  if (kind === CARD_THUMBNAIL.LOCKED) return <span className="rb-workspace-card__badge">{t('workspace.badge.locked')}</span>;
  return null;
}

function CardActivity({ room, now }) {
  const activity = cardActivityOf(room);
  if (!activity) return null;
  return <p className="rb-workspace-card__meta">{t(ACTIVITY_KEYS[activity.kind], { time: formatRelativeTime(activity.at, now) })}</p>;
}

function MenuButton({ Icon, ...rest }) {
  return <MenuItem role="menuitem" icon={<Icon size={MENU_ICON_SIZE_PX} aria-hidden="true" />} {...rest} />;
}

function CardMenu({ room, name, busy, onAskRename, onAskDelete }) {
  const hintId = useId();
  const rename = renameActionOf(room);
  const renameLocked = rename === RENAME_ACTION.DISABLED;
  return (
    <div className="rb-surface rb-workspace-card__menu" role="menu" aria-label={t('workspace.card.options', { title: name })}>
      {/* A full page load: the link carries the room key in its fragment. */}
      <MenuLink role="menuitem" href={room.link} icon={<ArrowUpRight size={MENU_ICON_SIZE_PX} aria-hidden="true" />}
        label={t('myBoards.open')} />
      {/* A locked rename stays focusable (aria-disabled, no handler) so its hint is read out. */}
      {rename !== RENAME_ACTION.HIDDEN && (
        <MenuButton Icon={Pencil} label={t('myBoards.rename')} disabled={busy}
          aria-disabled={renameLocked || undefined} aria-describedby={renameLocked ? hintId : undefined}
          onClick={renameLocked ? undefined : () => onAskRename(room)} />
      )}
      {renameLocked && <p id={hintId} className="rb-workspace-card__hint">{t('workspace.card.renameLocked')}</p>}
      <Divider orientation={DIVIDER_ORIENTATION.HORIZONTAL} />
      <MenuButton Icon={Trash2} label={t('workspace.card.delete')} variant={MENU_ITEM_VARIANT.DANGER} disabled={busy}
        onClick={() => onAskDelete(room)} />
    </div>
  );
}

/** One room in the workspace grid: the whole card opens the room; the ⋯ menu holds the other actions. */
export default function WorkspaceCard({ room, now, busy, menuOpen, onToggleMenu, onAskRename, onAskDelete }) {
  const actionsRef = useRef(null);
  const triggerRef = useRef(null);
  // Closing the menu unmounts the focused item, so focus moves to the ⋯ trigger first. A dialog opened
  // from the menu then records the trigger as its opener and returns focus there when it closes.
  const focusTrigger = () => triggerRef.current?.focus();
  const dismissMenu = () => {
    focusIfInside(actionsRef, triggerRef);
    onToggleMenu(null);
  };
  const askRename = (target) => { focusTrigger(); onAskRename(target); };
  const askDelete = (target) => { focusTrigger(); onAskDelete(target); };
  // Trigger and menu share one ref, so a press on the open card's ⋯ toggles instead of dismissing and reopening.
  useDismiss(menuOpen, actionsRef, dismissMenu);
  const thumbnail = cardThumbnailOf(room);
  const Thumbnail = THUMBNAILS[thumbnail.kind];
  const name = roomNameOf(room);
  const label = thumbnail.kind === CARD_THUMBNAIL.POKER ? t('workspace.card.poker', { code: room.code }) : name;
  return (
    <li className={menuOpen ? 'rb-workspace-card rb-workspace-card--menu-open' : 'rb-workspace-card'}>
      {/* A full page load: the link carries the room key in its fragment. */}
      <a className="rb-workspace-card__link" href={room.link}>
        <div className={`rb-workspace-card__thumb rb-workspace-card__thumb--${thumbnail.kind}`} aria-hidden="true">
          <Thumbnail zones={thumbnail.zones} />
        </div>
        <div className="rb-workspace-card__body">
          <CardBadge kind={thumbnail.kind} />
          <h2 className="rb-workspace-card__title" title={label}>{label}</h2>
          <CardActivity room={room} now={now} />
        </div>
      </a>
      <div className="rb-workspace-card__actions" ref={actionsRef}>
        <button type="button" ref={triggerRef} className="rb-workspace-card__more" aria-haspopup="menu"
          aria-expanded={menuOpen} aria-label={t('workspace.card.options', { title: name })}
          onClick={() => onToggleMenu(room.code)}>
          <MoreHorizontal size={MORE_ICON_SIZE_PX} aria-hidden="true" />
        </button>
        {menuOpen && <CardMenu room={room} name={name} busy={busy} onAskRename={askRename} onAskDelete={askDelete} />}
      </div>
    </li>
  );
}
