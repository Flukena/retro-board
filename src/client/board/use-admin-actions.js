import { createVoteFinalizationController } from './vote-finalization-controller.js';
import { useCallback } from 'react';
import { t as translate } from '../ui/i18n.js';
import { CLEARED_VOTE_RESULTS, voteSessionScope, resetVoteSessionEntries } from '../../domain/vote-session-lifecycle.js';
import { extendedDeadline } from '../../domain/countdown.js';

const MINUTE_MS = 60000;

export function createAdminActions({
  isAdmin, setToast, t = translate, patchMeta, boardRef, clock = globalThis.Date,
  view = globalThis.window, reportWriteFailure, setBoard, setTimerSetupZoneId, updateItem,
  finalizeVotingSession, replaceBoardLocal, setConfirmClear, storage, setConfirmResetVotes,
  setConfirmUnlockAll,
}) {
  const adminToggle = (key) => {
    if (!isAdmin) { setToast({ msg: t('common.adminOnly'), type: 'warn' }); return; }
    // patchMeta writes the single flipped flag immediately — no debounce window
    // for applyRemoteBoard to re-spread DEFAULT_BOARD over the local toggle.
    patchMeta({ [key]: !boardRef.current[key] });
  };
  const adminStartTimer = (zoneId, minutes, voteLimit, hideResults, showNonVoters) => {
    if (!isAdmin) return;
    const items = boardRef.current.items;
    const rootZone = items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!rootZone) return;
    const nowMs = clock.now();
    // Expired-but-unfinalized timers still block related starts.
    const { relatedActive, capturedIds, staleResultZoneIds } = voteSessionScope(rootZone, items);
    if (relatedActive) {
      setToast({ msg: t('vote.session.relatedActive'), type: 'warn' });
      return;
    }
    const startedAt = nowMs;
    const endsAt = minutes && minutes > 0 ? startedAt + minutes * MINUTE_MS : null;
    const limit = voteLimit && voteLimit > 0 ? voteLimit : null;
    const timerPatch = {
      voteTimer: {
        startedAt, endsAt, voteLimit: limit, hideResults: !!hideResults, showNonVoters: !!showNonVoters,
      },
      ...CLEARED_VOTE_RESULTS,
      votingLocked: false,
    };
    try {
      if (view.storage.startVoteSession(zoneId, timerPatch, staleResultZoneIds, capturedIds) !== true) {
        reportWriteFailure();
        return;
      }
    } catch {
      reportWriteFailure();
      return;
    }
    setBoard((prev) => ({
      ...prev,
      items: prev.items.map((it) => {
        if (it.id === zoneId) return { ...it, ...timerPatch };
        if (staleResultZoneIds.includes(it.id)) return { ...it, ...CLEARED_VOTE_RESULTS };
        return it;
      }),
    }));
    setTimerSetupZoneId(null);
    setToast({
      msg: t('vote.session.started', {
        limit: limit ? t('vote.session.votesLimit', { n: limit }) : t('vote.session.unlimited'),
        time: minutes ? t('vote.session.minutes', { n: minutes }) : t('vote.session.noTime'),
      }),
      type: 'info',
    });
  };
  const adminExtendTimer = (zoneId, minutes) => {
    if (!isAdmin) return;
    const zone = boardRef.current.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!zone?.voteTimer) return;
    updateItem(zoneId, { voteTimer: { ...zone.voteTimer, endsAt: extendedDeadline(zone.voteTimer.endsAt, clock.now(), minutes) } });
  };
  const adminStopTimer = (zoneId) => {
    if (!isAdmin) return;
    const zone = boardRef.current.items.find((i) => i.id === zoneId && i.type === 'zone');
    if (!zone?.voteTimer) return;
    finalizeVotingSession(zoneId);
  };
  const adminClearBoard = () => {
    if (!isAdmin) return;
    view.storage?.clearAllVotes?.();
    view.storage?.clearAllComments?.();
    // Full replace: drop every item, reset session meta, preserve admin identity.
    if (!replaceBoardLocal({
      ...boardRef.current,
      items: [],
      timer: null,
      lastResultsAt: null,
      allRevealed: false,
      votingLocked: false,
      editingLocked: false,
      phase: null, moodCheck: null,
    })) return;
    setConfirmClear(false);
  };
  const adminResetVotes = () => {
    if (!isAdmin) return;
    // Votes live in CRDT keys; clearing them re-renders via the vote subscription.
    view.storage?.clearAllVotes?.();
    const zoneEntries = resetVoteSessionEntries(boardRef.current.items);
    if (zoneEntries.length) {
      if (!storage.updateItems(zoneEntries)) { reportWriteFailure(); return; }
      const patchById = new Map(zoneEntries.map((entry) => [entry.id, entry.patch]));
      setBoard((prev) => ({
        ...prev,
        items: prev.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        )),
      }));
    }
    patchMeta({ lastResultsAt: null });
    setConfirmResetVotes(false);
    setToast({ msg: t('reset.done'), type: 'info' });
  };
  const adminUnlockAll = () => {
    if (!isAdmin) return;
    const entries = boardRef.current.items
      .filter((i) => (i.type === 'zone' && i.locked) || (i.type === 'sticky' && i.private))
      .map((i) => ({ id: i.id, patch: i.type === 'zone' ? { locked: false } : { private: false } }));
    if (entries.length) {
      if (!storage.updateItems(entries)) { reportWriteFailure(); return; }
      const patchById = new Map(entries.map((entry) => [entry.id, entry.patch]));
      setBoard((prev) => ({
        ...prev,
        items: prev.items.map((it) => (
          patchById.has(it.id) ? { ...it, ...patchById.get(it.id) } : it
        )),
      }));
    }
    patchMeta({ editingLocked: false });
    setConfirmUnlockAll(false);
    setToast({ msg: t('unlockAll.done'), type: 'info' });
  };
  return { adminToggle, adminStartTimer, adminExtendTimer, adminStopTimer, adminClearBoard, adminResetVotes, adminUnlockAll };
}

export function useAdminToggle(options, dependencies) {
  return useCallback(createAdminActions(options).adminToggle, dependencies);
}

export function useAdminStartTimer(options, dependencies) {
  return useCallback(createAdminActions(options).adminStartTimer, dependencies);
}

export function useAdminExtendTimer(options, dependencies) {
  return useCallback(createAdminActions(options).adminExtendTimer, dependencies);
}

export function useAdminStopTimer(options, dependencies) {
  return useCallback(createAdminActions(options).adminStopTimer, dependencies);
}

export function useAdminClearBoard(options, dependencies) {
  return useCallback(createAdminActions(options).adminClearBoard, dependencies);
}

export function useAdminResetVotes(options, dependencies) {
  return useCallback(createAdminActions(options).adminResetVotes, dependencies);
}

export function useAdminUnlockAll(options, dependencies) {
  return useCallback(createAdminActions(options).adminUnlockAll, dependencies);
}

export function useFinalizeVotingSession(options, dependencies) {
  return useCallback(createVoteFinalizationController(options).finalizeVotingSession, dependencies);
}
