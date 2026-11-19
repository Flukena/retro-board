import { voteKey, commentKey } from '../../../domain/vote-comment-keys.js';
import { isSafeId, normalizeComment } from '../../../domain/comment-schema.js';
import { normalizeTemplateEntries } from '../../../domain/template-store.js';
import { moodImportWrites } from '../mood-store.js';
import { boardItemWriteError, boardItemsWriteError } from './snapshot-doc.js';

export function planImportBundle(board, voteEntries, commentEntries, customTemplates, moodEntries = []) {
  if (!board || typeof board !== 'object' || !Array.isArray(board.items)) return null;
  if (!Array.isArray(voteEntries) || !Array.isArray(commentEntries)) return null;
  const moodWrites = moodImportWrites(moodEntries);
  if (!moodWrites) return null;
  const normalizedTemplates = normalizeTemplateEntries(customTemplates);
  if (customTemplates != null && !normalizedTemplates) return null;
  if (boardItemsWriteError(board.items)) return null;

  const itemTypes = importItemTypes(board.items);
  if (!itemTypes) return null;
  const normalizedVotes = importVoteKeys(voteEntries, itemTypes);
  if (!normalizedVotes) return null;
  const normalizedComments = importComments(commentEntries, itemTypes);
  if (!normalizedComments) return null;
  return { moodWrites, normalizedTemplates, normalizedVotes, normalizedComments };
}

function importItemTypes(items) {
  const itemTypes = new Map();
  for (const item of items) {
    if (boardItemWriteError(item) || itemTypes.has(item.id)) return null;
    itemTypes.set(item.id, item.type);
  }

  return itemTypes;
}

function importVoteKeys(voteEntries, itemTypes) {
  const normalizedVotes = [];
  const seenVotes = new Set();
  for (const entry of voteEntries) {
    if (!entry || itemTypes.get(entry.itemId) !== 'sticky' || !isSafeId(entry.userId)) return null;
    const key = voteKey(entry.itemId, entry.userId);
    if (seenVotes.has(key)) return null;
    seenVotes.add(key);
    normalizedVotes.push(key);
  }

  return normalizedVotes;
}

function importComments(commentEntries, itemTypes) {
  const normalizedComments = [];
  const seenComments = new Set();
  for (const entry of commentEntries) {
    if (!entry || itemTypes.get(entry.itemId) !== 'sticky') return null;
    const comment = normalizeComment(entry.comment, entry.comment?.id);
    if (!comment) return null;
    const key = commentKey(entry.itemId, comment.id);
    if (seenComments.has(key)) return null;
    seenComments.add(key);
    normalizedComments.push({ key, comment });
  }

  return normalizedComments;
}
