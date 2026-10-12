import React from 'react';
import {
  Check, Crown, Download, HelpCircle, LocateFixed,
  RotateCcw, Trash2, Unlock, Upload, ZoomIn,
} from 'lucide-react';
import { Avatar } from './Avatar.jsx';
import { Button, Divider, MenuItem, Surface } from './UiPrimitives.jsx';
import { BUTTON_VARIANT, DIVIDER_ORIENTATION, MENU_ITEM_VARIANT } from './ui-variants.js';
import { TOPBAR_ICON_SIZE_PX, Z } from './chrome-layout.js';
import { t } from './i18n.js';
import { transferCandidates } from './topbar-model.js';

export function Popover({ children, onClose, className, shortcutsOff }) {
  return (
    <>
      <div
        className="rb-topbar-backdrop"
        onClick={onClose}
        style={{ zIndex: Z.POPOVER_BACKDROP }}
      />
      <Surface
        className={`rb-topbar-popover ${className || ''}`}
        data-board-shortcuts={shortcutsOff ? 'off' : undefined}
        style={{ zIndex: Z.POPOVER }}
      >
        {children}
      </Surface>
    </>
  );
}

export function MorePopover({
  isAdmin, exportBusy, scrollWheelZoomEnabled, onToggleScrollWheelZoom,
  onExport, onExportCsv, onImport, onHelp, onUnlockAll, onResetVotes,
  onClear, onTransfer, onClose,
}) {
  const closeThen = (action) => () => { onClose(); action(); };
  return (
    <Popover onClose={onClose} className="rb-topbar-popover--more">
      <MenuItem
        icon={<ZoomIn size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={t('settings.scrollWheelZoom')}
        checked={scrollWheelZoomEnabled}
        checkIcon={<Check size={TOPBAR_ICON_SIZE_PX.MENU} />}
        onClick={onToggleScrollWheelZoom}
      />
      <Divider orientation={DIVIDER_ORIENTATION.HORIZONTAL} />
      <MenuItem
        icon={<Download size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={exportBusy ? t('export.processing') : t('topbar.export')}
        onClick={closeThen(onExport)}
      />
      <MenuItem
        icon={<Download size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={t('topbar.exportCsv')}
        onClick={closeThen(onExportCsv)}
      />
      <MenuItem
        icon={<Upload size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={t('topbar.import')}
        disabled={!isAdmin}
        onClick={closeThen(onImport)}
      />
      <MenuItem
        icon={<HelpCircle size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={t('help.menuLabel')}
        onClick={closeThen(onHelp)}
      />
      <Divider orientation={DIVIDER_ORIENTATION.HORIZONTAL} />
      <MenuItem
        icon={<Unlock size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={t('topbar.unlockAll')}
        disabled={!isAdmin}
        onClick={closeThen(onUnlockAll)}
      />
      <MenuItem
        icon={<RotateCcw size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={t('topbar.resetVotes')}
        disabled={!isAdmin}
        variant={MENU_ITEM_VARIANT.DANGER}
        onClick={closeThen(onResetVotes)}
      />
      <MenuItem
        icon={<Trash2 size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={t('topbar.clear')}
        disabled={!isAdmin}
        variant={MENU_ITEM_VARIANT.DANGER}
        onClick={closeThen(onClear)}
      />
      <Divider orientation={DIVIDER_ORIENTATION.HORIZONTAL} />
      <MenuItem
        icon={<Crown size={TOPBAR_ICON_SIZE_PX.MENU} />}
        label={t('topbar.transfer')}
        disabled={!isAdmin}
        onClick={closeThen(onTransfer)}
      />
    </Popover>
  );
}

export function TransferRow({ player, onClose, onTransferAdmin }) {
  return (
    <button
      type="button"
      className="rb-menu-item rb-topbar-transfer-row"
      onClick={() => { onClose(); onTransferAdmin(player.userId); }}
    >
      <Avatar id={player.userId} name={player.name} />
      <span>{player.name}</span>
    </button>
  );
}

export function TransferPopover({ players, onClose, onTransferAdmin }) {
  const candidates = transferCandidates(players);
  return (
    <Popover onClose={onClose} shortcutsOff className="rb-topbar-popover--transfer">
      <div className="rb-topbar-popover__heading">{t('transfer.list.title')}</div>
      {candidates.length === 0 && (
        <div className="rb-topbar-popover__empty">{t('transfer.list.empty')}</div>
      )}
      {candidates.map((player) => (
        <TransferRow
          key={player.userId}
          player={player}
          onClose={onClose}
          onTransferAdmin={onTransferAdmin}
        />
      ))}
    </Popover>
  );
}

export function PlayerRow({ player, onClose, onFollow, onStopFollowing }) {
  const follow = () => {
    if (player.isFollowing) onStopFollowing();
    else onFollow(player.userId);
    onClose();
  };
  return (
    <div className={`rb-topbar-player-row${player.isFollowing ? ' rb-topbar-player-row--following' : ''}`}>
      <Avatar id={player.userId} name={player.name} crown={player.isAdmin} />
      <span className="rb-topbar-player-row__name">
        {player.name}
        {player.isMe && <span className="rb-topbar-player-row__you">{t('common.you')}</span>}
      </span>
      <span
        title={t('players.votesTooltip')}
        className={`rb-topbar-votes${player.isFull ? ' rb-topbar-votes--full' : ''}`}
      >
        {player.limit != null ? `${player.used}/${player.limit}` : `${player.used}`}
      </span>
      {player.isAdmin && <span className="rb-topbar-admin-badge">{t('common.admin')}</span>}
      {!player.isMe && (
        <Button
          variant={player.isFollowing ? BUTTON_VARIANT.PRIMARY : BUTTON_VARIANT.DEFAULT}
          className="rb-btn--icon-sm"
          aria-pressed={player.isFollowing}
          title={player.isFollowing ? t('follow.stop') : t('follow.start', { name: player.name })}
          onClick={follow}
        >
          <LocateFixed size={TOPBAR_ICON_SIZE_PX.MENU} />
        </Button>
      )}
    </div>
  );
}

export function PlayersPopover({ players, onClose, onFollow, onStopFollowing }) {
  return (
    <Popover onClose={onClose} className="rb-topbar-popover--players">
      <div className="rb-topbar-popover__heading">{t('players.head', { n: players.length })}</div>
      {players.map((player) => (
        <PlayerRow
          key={player.userId}
          player={player}
          onClose={onClose}
          onFollow={onFollow}
          onStopFollowing={onStopFollowing}
        />
      ))}
    </Popover>
  );
}
