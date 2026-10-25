import { BOARD_MODE } from '../../domain/public-wall-contract.js';
import React, { useState } from 'react';
import {
  Copy, Crown, Languages, Lock, Monitor, Moon, MoreHorizontal,
  Redo2, Sparkles, Sun, Undo2, Unlock,
} from 'lucide-react';
import { Avatar } from '../ui/Avatar.jsx';
import { MorePopover, PlayersPopover, TransferPopover } from './TopBarPopovers.jsx';
import { Button, Divider } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT, DIVIDER_ORIENTATION, topBarButtonVariant } from '../ui/ui-variants.js';
import { TOPBAR_H_PX, TOPBAR_INSET_PX, TOPBAR_ICON_SIZE_PX, Z } from './chrome-layout.js';
import { t } from '../ui/i18n.js';
import { boardManagementPermissions } from '../../domain/public-board-permissions.js';
import './topbar.css';
import '../ui/mobile-layout.css';

const MAX_VISIBLE_AVATARS = 6;
const OFFLINE_ADMIN_OPACITY = 0.55;
const THEME_ICONS = Object.freeze({ auto: Monitor, dark: Moon, light: Sun });

export function TopBarButton({ title, onClick, active, enabled, icon, label, disabledHint }) {
  return (
    <Button
      variant={topBarButtonVariant({ active })}
      disabledLook={!enabled}
      onClick={onClick}
      title={enabled ? title : (disabledHint || `${title} (${t('common.adminOnly')})`)}
    >
      {icon}
      {label && <span>{label}</span>}
    </Button>
  );
}

// Your own admin role already shows as the crown on your name button.
function AdminPill({ admin, isAdmin }) {
  if (!admin || isAdmin) return null;
  return (
    <div
      className="rb-topbar-admin"
      title={t('common.admin')}
      style={{ opacity: admin.isOnline ? 1 : OFFLINE_ADMIN_OPACITY }}
    >
      <Crown size={TOPBAR_ICON_SIZE_PX.CHIP} />
      <span>{admin.name}</span>
    </div>
  );
}

function PresenceButton({ players, onClick }) {
  return (
    <button
      type="button"
      className="rb-topbar-presence"
      onClick={onClick}
      title={t('topbar.playersTitle', { n: players.length })}
    >
      {players.slice(0, MAX_VISIBLE_AVATARS).map((player) => (
        <span className="rb-topbar-presence__avatar" key={player.userId}>
          <Avatar
            id={player.userId}
            name={player.name}
            crown={player.isAdmin}
            ring
          />
        </span>
      ))}
      {players.length > MAX_VISIBLE_AVATARS && (
        <span className="rb-topbar-presence__extra">
          {t('topbar.extraPlayers', { n: players.length - MAX_VISIBLE_AVATARS })}
        </span>
      )}
    </button>
  );
}

export function TopBar({
  mode = BOARD_MODE.PRIVATE, code, title = null, canUndo, canRedo, editingLocked, isAdmin, admin, canClaim, players,
  userId, userName, lang, themePref, exportBusy, scrollWheelZoomEnabled,
  onHome, onCopyLink, onUndo, onRedo, onToggleEditingLock, onClaimAdmin,
  onEditName, onToggleLanguage, onToggleTheme, onToggleScrollWheelZoom,
  onExport, onExportCsv, onImport, onHelp, onUnlockAll, onResetVotes, onClear,
  onTransferAdmin, onFollow, onStopFollowing,
}) {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [playerListOpen, setPlayerListOpen] = useState(false);
  const ThemeIcon = THEME_ICONS[themePref];
  const permissions = boardManagementPermissions(mode, isAdmin);
  return (
    <div
      className="rb-topbar"
      style={{
        '--rb-topbar-inset-px': `${TOPBAR_INSET_PX}px`,
        height: TOPBAR_H_PX, zIndex: Z.TOPBAR,
      }}
    >
      <div className="rb-topbar-scroll">
        <button
          type="button"
          className="rb-topbar-brand"
          onClick={onHome}
          title={t('topbar.home')}
        >
          <span className="rb-topbar-brand__tile">
            <Sparkles size={TOPBAR_ICON_SIZE_PX.BRAND} />
          </span>
          <span>{t('app.title')}</span>
        </button>
        {code && (
          <button
            type="button"
            className="rb-topbar-code"
            onClick={onCopyLink}
            title={t('topbar.copyLink')}
          >
            <Copy size={TOPBAR_ICON_SIZE_PX.CHIP} />
            {code}
          </button>
        )}
        {title && <span className="rb-topbar-title" title={title}>{title}</span>}
        <div className="rb-topbar-spacer" />
        <div className="rb-topbar-controls">
          <TopBarButton
            title={t('topbar.undo')}
            onClick={onUndo}
            enabled={canUndo}
            disabledHint={t('topbar.nothingToUndo')}
            icon={<Undo2 size={TOPBAR_ICON_SIZE_PX.ACTION} />}
          />
          <TopBarButton
            title={t('topbar.redo')}
            onClick={onRedo}
            enabled={canRedo}
            disabledHint={t('topbar.nothingToRedo')}
            icon={<Redo2 size={TOPBAR_ICON_SIZE_PX.ACTION} />}
          />
          {mode !== BOARD_MODE.PUBLIC && <>
            <Divider orientation={DIVIDER_ORIENTATION.VERTICAL} />
            <TopBarButton
              title={editingLocked ? t('topbar.editingLocked') : t('topbar.lockEdit')}
              onClick={onToggleEditingLock}
              active={editingLocked}
              enabled={permissions.canManage}
              icon={editingLocked
                ? <Lock size={TOPBAR_ICON_SIZE_PX.ACTION} />
                : <Unlock size={TOPBAR_ICON_SIZE_PX.ACTION} />}
              label={editingLocked ? t('topbar.unlockEdit') : t('topbar.lockEdit')}
            />
            <Divider orientation={DIVIDER_ORIENTATION.VERTICAL} />
          </>}
        </div>
        {mode !== BOARD_MODE.PUBLIC && <AdminPill admin={admin} isAdmin={isAdmin} />}
        {mode !== BOARD_MODE.PUBLIC && canClaim && (
          <Button
            variant={BUTTON_VARIANT.PRIMARY}
            className="rb-btn--pill"
            data-action="claim"
            onClick={onClaimAdmin}
            title={t('admin.claim.title')}
          >
            <Crown size={TOPBAR_ICON_SIZE_PX.CHIP} />
            <span>{t('admin.claim')}</span>
          </Button>
        )}
        <div className="rb-topbar-anchor rb-topbar-players">
          <PresenceButton players={players} onClick={() => setPlayerListOpen((open) => !open)} />
          {playerListOpen && (
            <PlayersPopover
              players={players}
              onFollow={onFollow}
              onStopFollowing={onStopFollowing}
              onClose={() => setPlayerListOpen(false)}
            />
          )}
        </div>
        <Button className="rb-btn--pill" onClick={onEditName} title={t('topbar.editName')}>
          <Avatar
            id={userId || ''}
            name={userName}
            crown={permissions.isPrivateAdmin}
            small
          />
          <span>{userName || t('topbar.setName')}</span>
        </Button>
        <Button className="rb-btn--pill" onClick={onToggleLanguage} title={t('settings.lang')}>
          <Languages size={TOPBAR_ICON_SIZE_PX.TOGGLE} />
          {lang === 'th' ? 'TH' : 'EN'}
        </Button>
        <Button
          className="rb-btn--pill"
          onClick={onToggleTheme}
          title={`${t('settings.theme')}: ${t(`settings.theme.${themePref}`)}`}
        >
          <ThemeIcon size={TOPBAR_ICON_SIZE_PX.TOGGLE} />
        </Button>
      </div>
      <div className="rb-topbar-anchor rb-topbar-menu">
        <TopBarButton
          title={t('topbar.more')}
          onClick={() => setMoreMenuOpen((open) => !open)}
          enabled
          icon={<MoreHorizontal size={TOPBAR_ICON_SIZE_PX.ACTION} />}
        />
        {moreMenuOpen && (
          <MorePopover mode={mode}
            isAdmin={isAdmin}
            exportBusy={exportBusy}
            scrollWheelZoomEnabled={scrollWheelZoomEnabled}
            onToggleScrollWheelZoom={onToggleScrollWheelZoom}
            onExport={onExport}
            onExportCsv={onExportCsv}
            onImport={onImport}
            onHelp={onHelp}
            onUnlockAll={onUnlockAll}
            onResetVotes={onResetVotes}
            onClear={onClear}
            onTransfer={() => setTransferOpen(true)}
            onClose={() => setMoreMenuOpen(false)}
          />
        )}
        {transferOpen && isAdmin && (
          <TransferPopover
            players={players}
            onTransferAdmin={onTransferAdmin}
            onClose={() => setTransferOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
