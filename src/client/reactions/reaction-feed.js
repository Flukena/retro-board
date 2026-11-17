// The reaction effects on screen right now. Peers' presence is untrusted, so the client send limit does not bound
// what arrives: each look keeps at most a fixed number at once and drops the oldest.
import {
  MAX_SPARKS_PER_SHOW, REACTION_LOOK, fireworksShow, floatPlacement, lookDurationMs, reactionLook, reactionSeed,
} from './reaction-timeline.js';

export const MAX_ACTIVE_BY_LOOK = Object.freeze({
  [REACTION_LOOK.FIREWORKS]: 2,
  [REACTION_LOOK.FLOAT]: 12,
  [REACTION_LOOK.STILL]: 4,
});
export const MAX_ACTIVE_SPARKS = MAX_ACTIVE_BY_LOOK[REACTION_LOOK.FIREWORKS] * MAX_SPARKS_PER_SHOW;

/** What to draw for one received reaction, starting `now`. */
export function reactionEntry({ clientId, seq, emoji, name }, { reducedMotion, now }) {
  const look = reactionLook(emoji, reducedMotion);
  const seed = reactionSeed(clientId, seq);
  const fireworks = look === REACTION_LOOK.FIREWORKS;
  return Object.freeze({
    key: `${clientId}:${seq}`, emoji, name, look, startedAt: now, endsAt: now + lookDurationMs(look),
    sparks: fireworks ? fireworksShow(seed) : null,
    placement: fireworks ? null : floatPlacement(seed),
  });
}

/** What may stay on screen once reduced motion is on: running fireworks and floats stop at once; still badges stay. */
export const withoutMotion = (entries) => Object.freeze(entries.filter((entry) => entry.look === REACTION_LOOK.STILL));

export const liveReactions = (entries, now) => entries.filter((entry) => entry.endsAt > now);

/** The live entries plus `entry`, keeping each look within its cap by dropping its oldest. */
export function addReaction(entries, entry, now) {
  const live = liveReactions(entries, now).filter((existing) => existing.key !== entry.key);
  const sameLook = live.filter((existing) => existing.look === entry.look);
  const overflow = Math.max(0, sameLook.length + 1 - MAX_ACTIVE_BY_LOOK[entry.look]);
  const dropped = new Set(sameLook.slice(0, overflow));
  return Object.freeze([...live.filter((existing) => !dropped.has(existing)), entry]);
}

/** Milliseconds until the earliest entry ends (0 when one is overdue), or null when nothing is showing. */
export function nextExpiryInMs(entries, now) {
  if (!entries.length) return null;
  return Math.max(0, Math.min(...entries.map((entry) => entry.endsAt)) - now);
}
