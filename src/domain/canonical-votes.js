import { parseCanonicalVoteKey } from './vote-comment-keys.js';

export function readCanonicalVotes(voteMap) {
  const votes = new Map();
  voteMap.forEach((value, key) => {
    if (!value) return;
    const parsed = parseCanonicalVoteKey(key);
    if (!parsed) return;
    const { itemId, userId } = parsed;
    if (!votes.has(itemId)) votes.set(itemId, new Set());
    votes.get(itemId).add(userId);
  });
  return votes;
}
