import { t } from '../ui/i18n.js';
import { nextThemePref } from '../ui/theme.js';
import { adminPillModel, playerRows } from './topbar-model.js';

export function topBarProps({ boardState, session, collaboration, appearance, workflow, actions }) {
  const { board, undoState } = boardState;
  const { mode, boardCode, isAdmin, canClaim, userId, userName } = session;
  const { presence, onlineUsers, followedUserId, votesUsedByUser, activeZoneVoteLimit } = collaboration;
  const { themePref, setThemePref, scrollWheelZoomEnabled, toggleScrollWheelZoom } = appearance;
  const { presenter, retroPhase, mood, boardExports, actionItems } = workflow;
  const {
    setToast, copyRoomLink, doUndo, doRedo, adminToggle, adminClaim,
    setNameDraft, setNameModalOpen, onImportPick, setHelpOpen,
    setConfirmUnlockAll, setConfirmResetVotes, setConfirmClear,
    requirePrivateAdminPin, adminTransfer, startFollowing, stopFollowing,
  } = actions;
  const topbarAdminAction = (action) => {
    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
    action();
  };
  return {
    mode,
    code: boardCode,
    title: board.title,
    canUndo: undoState.canUndo,
    canRedo: undoState.canRedo,
    editingLocked: board.editingLocked,
    isAdmin,
    canClaim,
    admin: adminPillModel({
        adminUserId: board.adminUserId,
        adminName: board.adminName,
        presence,
        onlineUsers,
        fallbackName: t('common.admin'),
      }),
    players: playerRows({
        onlineUsers,
        userId,
        adminUserId: board.adminUserId,
        followedUserId,
        votesUsedByUser,
        limit: activeZoneVoteLimit,
      }),
    userId,
    userName,
    themePref,
    presenter,
    phase: retroPhase,
    mood,
    exports: { ...boardExports, onActionItems: actionItems.show, openActionCount: actionItems.openCount },
    scrollWheelZoomEnabled,
    onHome: () => { window.location.href = '/'; },
    onCopyLink: copyRoomLink,
    onUndo: doUndo,
    onRedo: doRedo,
    onToggleEditingLock: () => adminToggle('editingLocked'),
    onClaimAdmin: adminClaim,
    onEditName: () => { setNameDraft(userName); setNameModalOpen(true); },
    onToggleTheme: () => setThemePref(nextThemePref(themePref)),
    onToggleScrollWheelZoom: toggleScrollWheelZoom,
    onImport: onImportPick,
    onHelp: () => setHelpOpen(true),
    onUnlockAll: () => topbarAdminAction(() => setConfirmUnlockAll(true)),
    onResetVotes: () => topbarAdminAction(() => setConfirmResetVotes(true)),
    onClear: () => topbarAdminAction(() => setConfirmClear(true)),
    onTransferAdmin: (targetUserId) => requirePrivateAdminPin(() => adminTransfer(targetUserId)),
    onFollow: startFollowing,
    onStopFollowing: stopFollowing,
  };
}
