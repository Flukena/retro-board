import { useCallback } from 'react';
import { PHASE_SHORTCUT, nextPhaseId, phasesAvailable } from '../../domain/retro-phase.js';
import { phaseBarModel } from './phase-bar-model.js';

/**
 * Meeting phases for the board. Phase changes are silent (Ctrl+Z must not move
 * the meeting back); shortcuts call the board's existing undoable actions.
 */
export function useRetroPhase({ mode, isAdmin, board, now, patchMeta, adminToggle, zoneActions, fitToItems, showActionItems }) {
  const available = phasesAvailable(mode);
  const phase = available ? board.phase ?? null : null;
  const setPhase = useCallback((id) => {
    patchMeta({ phase: id ? { id, startedAt: Date.now() } : null }, { silent: true });
  }, [patchMeta]);

  const toggleEditingLock = () => adminToggle('editingLocked');
  const shortcutHandlers = {
    [PHASE_SHORTCUT.UNLOCK]: toggleEditingLock,
    [PHASE_SHORTCUT.LOCK]: toggleEditingLock,
    [PHASE_SHORTCUT.REVEAL]: ({ zoneIds }) => zoneIds.forEach((zoneId) => zoneActions.toggleReveal(zoneId)),
    [PHASE_SHORTCUT.VOTE]: ({ zoneId }) => {
      fitToItems([zoneId]);
      zoneActions.vote(zoneId);
    },
    [PHASE_SHORTCUT.ACTIONS]: () => showActionItems(),
  };
  const runShortcut = (shortcut) => shortcutHandlers[shortcut.kind](shortcut);

  return {
    available,
    running: phase !== null,
    bar: phase ? phaseBarModel({ phase, now, board, isAdmin }) : null,
    start: () => setPhase(nextPhaseId(null)),
    end: () => setPhase(null),
    advance: () => setPhase(nextPhaseId(phase?.id)),
    runShortcut,
  };
}
