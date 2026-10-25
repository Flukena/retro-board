const VOTE_KEY_PATTERN = /^s\|\|vote:([^:]+):([^:]+)$/;
export function readCanonicalVotes(voteMap) {
  const votes = new Map();
  voteMap.forEach((value, key) => {
    if (!value) return;
    const match = VOTE_KEY_PATTERN.exec(key);
    if (!match) return;
    const [, itemId, userId] = match;
    if (!votes.has(itemId)) votes.set(itemId, new Set());
    votes.get(itemId).add(userId);
  });
  return votes;
}
