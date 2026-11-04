import { isSafeId } from './comment-schema.js';
import { BOARD_MODE } from './public-wall-contract.js';

// Mood check: the admin opens a round (`meta.moodCheck`), each person answers
// once on a 1-5 scale under their own kv key, and the closed round shows an
// anonymous histogram. One round lives in the room at a time; starting a new
// one clears the old answers. Answers are room-readable (SECURITY.md).

export const MOOD_SCALE = Object.freeze([
  { score: 1, emoji: '😫' }, { score: 2, emoji: '😕' }, { score: 3, emoji: '😐' },
  { score: 4, emoji: '🙂' }, { score: 5, emoji: '😄' },
]);
/** Cap on answers per round, for both the live read and imported backups. */
export const MOOD_MAX_ANSWERS = 1_000;
export const MOOD_PREFIX = 's||mood:';
const AVERAGE_DECIMALS = 1;
const AVERAGE_ROUNDING = 10 ** AVERAGE_DECIMALS;

export const moodKey = (roundId, userId) => `${MOOD_PREFIX}${roundId}:${userId}`;

export function parseMoodKey(key) {
  if (typeof key !== 'string' || !key.startsWith(MOOD_PREFIX)) return null;
  const rest = key.slice(MOOD_PREFIX.length);
  const separator = rest.indexOf(':');
  const roundId = rest.slice(0, separator);
  const userId = rest.slice(separator + 1);
  return separator > 0 && isSafeId(roundId) && isSafeId(userId) ? { roundId, userId } : null;
}

export const isMoodScore = (value) => Number.isInteger(value) && value >= 1 && value <= MOOD_SCALE.length;

/** Public rooms have no single facilitator, so mood checks are private-only. */
export const moodCheckAvailable = (mode) => mode !== BOARD_MODE.PUBLIC;

export const isMoodCheckState = (value) => value === null || (
  typeof value === 'object' && !Array.isArray(value)
  && isSafeId(value.id) && Number.isSafeInteger(value.startedAt) && value.startedAt >= 0
  && typeof value.open === 'boolean'
);

/** Count, per-score histogram (index 0 = score 1) and average of one round's answers. */
export function moodSummary(answers, roundId) {
  const scores = answers.filter((answer) => answer.roundId === roundId).map((answer) => answer.score);
  const histogram = MOOD_SCALE.map(({ score }) => scores.filter((value) => value === score).length);
  const total = scores.reduce((sum, value) => sum + value, 0);
  const average = scores.length ? Math.round((total / scores.length) * AVERAGE_ROUNDING) / AVERAGE_ROUNDING : null;
  return { count: scores.length, histogram, average };
}
