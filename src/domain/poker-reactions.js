// Emoji reactions thrown at a seat in a Planning Poker room. They travel in
// presence (awareness), never in the room document, so nothing is stored.
// Peers' presence is untrusted: decode it against the fixed emoji set.

export const POKER_REACTIONS = Object.freeze(['👍', '🎉', '❤️', '😂', '🤔', '😮']);
// How long one reaction stays on screen; the sender clears it afterwards.
export const POKER_REACTION_TTL_MS = 2400;
// Minimum gap between two reactions from one participant.
export const POKER_REACTION_COOLDOWN_MS = 600;
export const POKER_REACTION_FIELD = 'reaction';
const MAX_REACTION_ID_CHARS = 32;

const isShortString = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_REACTION_ID_CHARS;

// The presence value a participant publishes when reacting.
export function pokerReaction(toUserId, emoji, id) {
  if (!isShortString(toUserId) || !isShortString(id) || !POKER_REACTIONS.includes(emoji)) return null;
  return Object.freeze({ to: toUserId, emoji, id });
}

// Live reactions per target seat: Map<targetUserId, Array<{ key, emoji, fromUserId }>>.
// `states` are awareness states; `seatIds` limits targets to seats on the table.
export function activeReactions(states, seatIds) {
  const byTarget = new Map();
  for (const state of states) {
    const fromUserId = state?.user?.userId;
    const raw = state?.[POKER_REACTION_FIELD];
    const reaction = raw ? pokerReaction(raw.to, raw.emoji, raw.id) : null;
    if (!isShortString(fromUserId) || !reaction || !seatIds.has(reaction.to)) continue;
    const list = byTarget.get(reaction.to) ?? [];
    list.push({ key: `${fromUserId}:${reaction.id}`, emoji: reaction.emoji, fromUserId });
    byTarget.set(reaction.to, list);
  }
  return byTarget;
}
