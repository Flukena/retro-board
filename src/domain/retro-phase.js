import { effectiveOwnerZone } from './board-ownership.js';
import { BOARD_MODE } from './public-wall-contract.js';
import { zoneEffectiveRevealed } from './zone-actions.js';

// Meeting phases guide a retro; they do not lock anything by themselves.
// `meta.phase` only records where the meeting is, and each phase offers one
// shortcut that runs an existing (undoable) board action.

export const RETRO_PHASES = Object.freeze(['write', 'reveal', 'group', 'vote', 'discuss', 'actions']);
export const PHASE_SHORTCUT = Object.freeze({
  UNLOCK: 'unlock', REVEAL: 'reveal', VOTE: 'vote', LOCK: 'lock', ACTIONS: 'actions',
});
const MINUTE_MS = 60_000;

/** Public rooms have no single facilitator, so phases are private-only. */
export const phasesAvailable = (mode) => mode !== BOARD_MODE.PUBLIC;

export const isPhaseState = (value) => value === null || (
  typeof value === 'object' && !Array.isArray(value)
  && RETRO_PHASES.includes(value.id)
  && Number.isFinite(value.startedAt) && value.startedAt >= 0
);

/** First phase when none is running; null after the last phase. */
export function nextPhaseId(id) {
  if (id == null) return RETRO_PHASES[0];
  const index = RETRO_PHASES.indexOf(id);
  return index >= 0 && index < RETRO_PHASES.length - 1 ? RETRO_PHASES[index + 1] : null;
}

export const phaseElapsedMinutes = (phase, now) => Math.max(0, Math.floor((now - phase.startedAt) / MINUTE_MS));

const byPosition = (a, b) => a.y - b.y || a.x - b.x;
const topLevelZones = (items) => items
  .filter((item) => item.type === 'zone' && !effectiveOwnerZone(item, items))
  .sort(byPosition);

/**
 * The suggested action for a phase as data, or null when there is nothing to do.
 * Reveal and vote act on top-level zones only, because nested zones follow their parent.
 */
export function phaseShortcut(phaseId, { items, allRevealed, editingLocked }) {
  switch (phaseId) {
    case 'write':
      return editingLocked ? { kind: PHASE_SHORTCUT.UNLOCK } : null;
    case 'reveal': {
      const zoneIds = topLevelZones(items).filter((zone) => !zoneEffectiveRevealed(zone, items, allRevealed)).map((zone) => zone.id);
      return zoneIds.length ? { kind: PHASE_SHORTCUT.REVEAL, zoneIds } : null;
    }
    case 'vote': {
      const zone = topLevelZones(items).find((candidate) => !candidate.voteTimer);
      return zone ? { kind: PHASE_SHORTCUT.VOTE, zoneId: zone.id } : null;
    }
    case 'discuss':
      return editingLocked ? null : { kind: PHASE_SHORTCUT.LOCK };
    case 'actions':
      return { kind: PHASE_SHORTCUT.ACTIONS };
    default:
      return null;
  }
}
