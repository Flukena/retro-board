import { compareStableText } from '../../domain/vote-ranking.js';

export const RESULT_DISMISSAL_STORAGE_KEY = 'rb_vote_result_dismissals';
export const MAX_RESULT_DISMISSALS = 128;
const dismissalKey = (roomHandle, resultId) => JSON.stringify([roomHandle, resultId]);

export function readResultDismissals(storage) {
  try {
    const value = JSON.parse(storage?.getItem(RESULT_DISMISSAL_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter((key) => typeof key === 'string').slice(-MAX_RESULT_DISMISSALS) : [];
  } catch (error) {
    if (error instanceof Error) return [];
    throw error;
  }
}
export function resultIsDismissed(storage, roomHandle, resultId) {
  return readResultDismissals(storage).includes(dismissalKey(roomHandle, resultId));
}
export function dismissResult(storage, roomHandle, resultId) {
  const key = dismissalKey(roomHandle, resultId);
  const keys = [...readResultDismissals(storage).filter((entry) => entry !== key), key].slice(-MAX_RESULT_DISMISSALS);
  try {
    if (!storage) return false;
    storage.setItem(RESULT_DISMISSAL_STORAGE_KEY, JSON.stringify(keys));
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export function resultDismissalStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

export function visibleVoteResultZones(items, storage, roomHandle) {
  const dismissed = new Set(readResultDismissals(storage));
  return items.filter((item) => item.type === 'zone' && item.voteResults
    && !dismissed.has(dismissalKey(roomHandle, item.voteResults.resultId)))
    .sort((a, b) => b.voteResults.finalizedAt - a.voteResults.finalizedAt || compareStableText(a.id, b.id));
}
