// Emoji reactions anyone on a retro board sends to everyone in it. They travel in presence (awareness), never in the
// board document, so nothing is stored and nothing reaches undo history. Peers' presence is untrusted: decode strictly.

export const FIREWORKS_REACTION = '🎆';
export const BOARD_REACTIONS = Object.freeze([FIREWORKS_REACTION, '👏', '❤️', '😂', '🔥', '👍', '🪓']);
// Planning Poker rooms use `reaction`; a distinct field keeps the two shapes apart.
export const BOARD_REACTION_FIELD = 'boardReaction';
// About one reaction per second per person (owner decision). Senders hold to it, and every page enforces a slightly
// shorter play interval on what it plays, because a modified client can skip its own limit.
export const REACTION_SEND_INTERVAL_MS = 1000;

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * The presence value for one reaction. `seq` grows with every send, so each send is a new presence state. No sender
 * clock is published: machines' clocks disagree, and playback never depends on them.
 */
export function boardReaction(emoji, seq) {
  if (!BOARD_REACTIONS.includes(emoji) || !isPositiveSafeInteger(seq)) return null;
  return Object.freeze({ emoji, seq });
}

/** A peer's presence field as a reaction, or null when it is anything else. Unknown keys are ignored. */
export function decodeBoardReaction(raw) {
  return isPlainObject(raw) ? boardReaction(raw.emoji, raw.seq) : null;
}
