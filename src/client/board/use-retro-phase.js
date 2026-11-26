import { useCallback, useState } from 'react';
import { PHASE_SHORTCUT, nextPhaseId, phaseZoneChoices, phasesAvailable } from '../../domain/retro-phase.js';
import { phaseBarModel } from './phase-bar-model.js';

/**
 * Meeting phases for the board. Start asks which top-level zone the meeting runs
 * on. Phase changes are silent (Ctrl+Z must not move the meeting back);
 * shortcuts call the board's existing undoable actions.
 */
export function useRetroPhase({ mode, isAdmin, board, now, patchMeta, adminToggle, zoneActions, fitToItems }) {
  const available = phasesAvailable(mode);
  const phase = available ? board.phase ?? null : null;
  const [choosing, setChoosing] = useState(false);
  const setPhase = useCallback((id, zoneId = null) => {
    patchMeta({ phase: id ? { id, startedAt: Date.now(), zoneId } : null }, { silent: true });
  }, [patchMeta]);
  // zoneId null runs the meeting on the whole board.
  const startIn = (zoneId) => {
    setChoosing(false);
    setPhase(nextPhaseId(null), zoneId);
    if (zoneId) fitToItems([zoneId]);
  };

  const toggleEditingLock = () => adminToggle('editingLocked');
  const shortcutHandlers = {
    [PHASE_SHORTCUT.UNLOCK]: toggleEditingLock,
    [PHASE_SHORTCUT.LOCK]: toggleEditingLock,
    [PHASE_SHORTCUT.REVEAL]: ({ zoneIds }) => zoneIds.forEach((zoneId) => zoneActions.toggleReveal(zoneId)),
    [PHASE_SHORTCUT.VOTE]: ({ zoneId }) => {
      fitToItems([zoneId]);
      zoneActions.vote(zoneId);
    },
  };
  const runShortcut = (shortcut) => shortcutHandlers[shortcut.kind](shortcut);

  return {
    available,
    running: phase !== null,
    bar: phase ? phaseBarModel({ phase, now, board, isAdmin }) : null,
    choices: available && choosing ? phaseZoneChoices(board.items) : null,
    start: () => setChoosing(true),
    startIn,
    cancelChoose: () => setChoosing(false),
    end: () => setPhase(null),
    advance: () => setPhase(nextPhaseId(phase?.id), phase?.zoneId ?? null),
    runShortcut,
  };
}
