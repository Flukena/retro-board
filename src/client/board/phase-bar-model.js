import { RETRO_PHASES, nextPhaseId, phaseElapsedMinutes, phaseShortcut } from '../../domain/retro-phase.js';

export const PHASE_STEP_STATE = Object.freeze({ DONE: 'done', CURRENT: 'current', TODO: 'todo' });

const stepState = (index, currentIndex) => {
  if (index < currentIndex) return PHASE_STEP_STATE.DONE;
  return index === currentIndex ? PHASE_STEP_STATE.CURRENT : PHASE_STEP_STATE.TODO;
};

/** What the phase bar shows; only the admin gets the shortcut and the Next/Finish control. */
export function phaseBarModel({ phase, now, board, isAdmin }) {
  const currentIndex = RETRO_PHASES.indexOf(phase.id);
  return {
    steps: RETRO_PHASES.map((id, index) => ({ id, state: stepState(index, currentIndex) })),
    elapsedMinutes: phaseElapsedMinutes(phase, now),
    shortcut: isAdmin ? phaseShortcut(phase.id, board) : null,
    canAdvance: Boolean(isAdmin),
    isLast: nextPhaseId(phase.id) === null,
  };
}
