import { effectiveOwnerZone } from './board-ownership.js';
import { BOARD_MODE } from './public-wall-contract.js';
import { isSafeId } from './comment-schema.js';
import { zoneEffectiveRevealed, zoneGroupIds } from './zone-actions.js';

// Meeting phases guide a retro; they do not lock anything by themselves.
// `meta.phase` records where the meeting is and, optionally, the top-level
// zone it runs on (`zoneId`; null means the whole board). A phase can offer
// a shortcut that runs an existing (undoable) board action.

export const RETRO_PHASES = Object.freeze(['write', 'reveal', 'group', 'vote', 'discuss', 'actions']);
export const PHASE_SHORTCUT = Object.freeze({
  UNLOCK: 'unlock', REVEAL: 'reveal', VOTE: 'vote', LOCK: 'lock',
});
const MINUTE_MS = 60_000;

/** Public rooms have no single facilitator, so phases are private-only. */
export const phasesAvailable = (mode) => mode !== BOARD_MODE.PUBLIC;

export const isPhaseState = (value) => value === null || (
  typeof value === 'object' && !Array.isArray(value)
  && RETRO_PHASES.includes(value.id)
  && Number.isFinite(value.startedAt) && value.startedAt >= 0
  && (value.zoneId == null || isSafeId(value.zoneId))
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

/** Top-level zones the meeting can run on, top to bottom, with their card counts. */
export const phaseZoneChoices = (items) => topLevelZones(items).map((zone) => {
  const group = zoneGroupIds(zone, items);
  return { id: zone.id, title: zone.title ?? '', cardCount: items.filter((item) => item.type === 'sticky' && group.has(item.id)).length };
});

/** The chosen meeting zone while it is still a top-level zone; otherwise null (whole board). */
export const phaseZone = (phase, items) => (phase?.zoneId
  ? topLevelZones(items).find((zone) => zone.id === phase.zoneId) ?? null : null);

/**
 * The suggested action for a phase as data, or null when there is nothing to do.
 * Reveal and vote act on the meeting zone, or on every top-level zone when the
 * meeting runs on the whole board; nested zones follow their parent.
 */
export function phaseShortcut(phaseId, { items, allRevealed, editingLocked }, zone = null) {
  const zones = zone ? [zone] : topLevelZones(items);
  switch (phaseId) {
    case 'write':
      return editingLocked ? { kind: PHASE_SHORTCUT.UNLOCK } : null;
    case 'reveal': {
      const zoneIds = zones.filter((candidate) => !zoneEffectiveRevealed(candidate, items, allRevealed)).map((candidate) => candidate.id);
      return zoneIds.length ? { kind: PHASE_SHORTCUT.REVEAL, zoneIds } : null;
    }
    case 'vote': {
      const target = zones.find((candidate) => !candidate.voteTimer);
      return target ? { kind: PHASE_SHORTCUT.VOTE, zoneId: target.id } : null;
    }
    case 'discuss':
      return editingLocked ? null : { kind: PHASE_SHORTCUT.LOCK };
    default:
      return null;
  }
}
