// Emoji reactions anyone on a retro board sends to everyone in it. They travel in presence (awareness), never in the
// board document, so nothing is stored and nothing reaches undo history. Peers' presence is untrusted: decode strictly.

export const FIREWORKS_REACTION = '🎆';
export const BOARD_REACTIONS = Object.freeze([FIREWORKS_REACTION, '👏', '❤️', '😂', '🔥', '👍']);
// Planning Poker rooms use `reaction`; a distinct field keeps the two shapes apart.
export const BOARD_REACTION_FIELD = 'boardReaction';

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isPositiveTime = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The presence value for one reaction: `seq` grows with every send, `at` is the sender's clock in ms. */
export function boardReaction(emoji, seq, at) {
  if (!BOARD_REACTIONS.includes(emoji) || !isPositiveSafeInteger(seq) || !isPositiveTime(at)) return null;
  return Object.freeze({ emoji, seq, at });
}

/** A peer's presence field as a reaction, or null when it is anything else. */
export function decodeBoardReaction(raw) {
  return isPlainObject(raw) ? boardReaction(raw.emoji, raw.seq, raw.at) : null;
}
