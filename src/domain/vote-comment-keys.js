import { isSafeId } from './comment-schema.js';

export const VOTE_PREFIX = 's||vote:';
export const COMMENT_PREFIX = 's||comment:';
export const MOOD_PREFIX = 's||mood:';
const VOTE_KEY_PATTERN = /^s\|\|vote:([^:]+):([^:]+)$/;

export const voteKey = (itemId, userId) => `${VOTE_PREFIX}${itemId}:${userId}`;
export const commentKey = (itemId, commentId) => `${COMMENT_PREFIX}${itemId}:${commentId}`;
export const moodKey = (roundId, userId) => `${MOOD_PREFIX}${roundId}:${userId}`;

function parseStoredContributionKey(mapKey, prefix, participantField) {
  if (!mapKey.startsWith(prefix)) return null;
  const rest = mapKey.slice(prefix.length);
  const separator = rest.indexOf(':');
  if (separator < 0) return null;
  return { itemId: rest.slice(0, separator), [participantField]: rest.slice(separator + 1) };
}

// The bridge's legacy parser deliberately accepts empty and colon-bearing fields.
export const parseStoredVoteKey = key => parseStoredContributionKey(key, VOTE_PREFIX, 'userId');
export const parseStoredCommentKey = key => parseStoredContributionKey(key, COMMENT_PREFIX, 'commentId');

export function parseCanonicalVoteKey(key) {
  const match = VOTE_KEY_PATTERN.exec(key);
  return match ? { itemId: match[1], userId: match[2] } : null;
}

export function parseMoodKey(key) {
  if (typeof key !== 'string' || !key.startsWith(MOOD_PREFIX)) return null;
  const rest = key.slice(MOOD_PREFIX.length);
  const separator = rest.indexOf(':');
  const roundId = rest.slice(0, separator);
  const userId = rest.slice(separator + 1);
  return separator > 0 && isSafeId(roundId) && isSafeId(userId) ? { roundId, userId } : null;
}
