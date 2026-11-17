// The reaction effects on screen right now. Peers' presence is untrusted, so the client send limit does not bound
// what arrives: each look keeps at most a fixed number at once and drops the oldest.
import {
  FIREWORKS_DURATION_MS, REACTION_LOOK, floatPlacement, lookDurationMs, reactionLook, reactionSeed,
} from './reaction-timeline.js';
import { MAX_PARTICLES_PER_SHOW, fireworksShow } from './fireworks-physics.js';
import { REACTION_PLAY_INTERVAL_MS } from './reaction-receiver.js';

// A page plays each sender's reactions at most once per play interval (reaction-receiver.js) and a show outlasts it,
// so one sender can have this many shows running at once; none of them is cut short.
const SHOWS_PER_SENDER = Math.ceil(FIREWORKS_DURATION_MS / REACTION_PLAY_INTERVAL_MS);
export const MAX_ACTIVE_BY_LOOK = Object.freeze({
  [REACTION_LOOK.FIREWORKS]: SHOWS_PER_SENDER,
  [REACTION_LOOK.FLOAT]: 12,
  [REACTION_LOOK.STILL]: 4,
});
// The most fireworks particles and rockets on screen at once, however many people send (720; see the measured cost at
// MAX_PARTICLES_PER_SHOW).
export const MAX_ACTIVE_PARTICLES = MAX_ACTIVE_BY_LOOK[REACTION_LOOK.FIREWORKS] * MAX_PARTICLES_PER_SHOW;

/** What to draw for one received reaction, starting `now`. */
export function reactionEntry({ clientId, seq, emoji, name }, { reducedMotion, now }) {
  const look = reactionLook(emoji, reducedMotion);
  const seed = reactionSeed(clientId, seq);
  const fireworks = look === REACTION_LOOK.FIREWORKS;
  return Object.freeze({
    key: `${clientId}:${seq}`, emoji, name, look, startedAt: now, endsAt: now + lookDurationMs(look),
    fireworks: fireworks ? fireworksShow(seed) : null,
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
