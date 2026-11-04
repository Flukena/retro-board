import { isSafeId } from '../../domain/comment-schema.js';
import { MOOD_MAX_ANSWERS, MOOD_PREFIX, isMoodScore, moodKey, parseMoodKey } from '../../domain/mood-check.js';

// Mood answers live at one kv key per person and round, like votes, so two
// people answering at once never overwrite each other.

export const isMoodKey = (key) => key.startsWith(MOOD_PREFIX);

/** Validated answers `{ roundId, userId, score }`, capped at MOOD_MAX_ANSWERS. */
export function readMoods(ymap) {
  const answers = [];
  ymap.forEach((value, key) => {
    const parsed = answers.length < MOOD_MAX_ANSWERS ? parseMoodKey(key) : null;
    if (parsed && isMoodScore(value)) answers.push({ ...parsed, score: value });
  });
  return answers;
}

export const moodKeys = (ymap) => {
  const keys = [];
  ymap.forEach((_value, key) => { if (isMoodKey(key)) keys.push(key); });
  return keys;
};

/** `{ key, score }` writes for an import, or null when any entry is invalid or repeated. */
export function moodImportWrites(entries) {
  if (!Array.isArray(entries) || entries.length > MOOD_MAX_ANSWERS) return null;
  const writes = new Map();
  for (const entry of entries) {
    if (!isSafeId(entry?.roundId) || !isSafeId(entry.userId) || !isMoodScore(entry.score)) return null;
    const key = moodKey(entry.roundId, entry.userId);
    if (writes.has(key)) return null;
    writes.set(key, entry.score);
  }
  return [...writes].map(([key, score]) => ({ key, score }));
}
