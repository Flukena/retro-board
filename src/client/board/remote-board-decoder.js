import { isVoteResults } from '../../domain/vote-results.js';
import { validateBoardItem } from '../../domain/import-schema.js';
import { COMMENT_AUTHOR_NAME_MAX_LEN, isSafeId } from '../../domain/comment-schema.js';
import { DISPLAY_NAME_MAX_LENGTH } from '../../domain/security-boundaries.js';

// hashAdminPin uses SHA-256, represented as two hexadecimal characters per byte.
const ADMIN_PIN_HASH_HEX_LENGTH = 64;
const isRecord = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && !Object.hasOwn(value, '__proto__');
};
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isBoolean = (value) => typeof value === 'boolean';
const boundedString = (maxLength) => (value) => typeof value === 'string' && value.length <= maxLength;
const isAuthorId = (value) => value === '' || isSafeId(value);
const isPinHash = (value) => value === '' || (typeof value === 'string'
  && value.length === ADMIN_PIN_HASH_HEX_LENGTH && /^[0-9a-f]+$/i.test(value));
const nullable = (validate) => (value) => value == null || validate(value);
const TIMER_FIELDS = {
  startedAt: isTimestamp, endsAt: nullable(isTimestamp),
  voteLimit: nullable((value) => Number.isSafeInteger(value) && value > 0),
  hideResults: isBoolean, showNonVoters: isBoolean,
};
const fieldsMatch = (record, fields) => Object.entries(fields).every(([key, validate]) => (
  !(key in record) || validate(record[key])
));
const isTimer = (value) => isRecord(value) && fieldsMatch(value, TIMER_FIELDS);
const ITEM_RUNTIME_FIELDS = {
  authorName: nullable(boundedString(COMMENT_AUTHOR_NAME_MAX_LEN)), authorId: nullable(isAuthorId),
  createdAt: nullable(isTimestamp), parentZoneId: nullable(isSafeId),
  voteTimer: nullable(isTimer), lastResultsAt: nullable(isTimestamp), votingLocked: isBoolean,
};
const META_FIELDS = {
  adminUserId: nullable(isSafeId), adminName: nullable(boundedString(DISPLAY_NAME_MAX_LENGTH)), adminPinHash: nullable(isPinHash),
  editingLocked: isBoolean, votingLocked: isBoolean, allRevealed: isBoolean,
  timer: nullable(isTimer), lastResultsAt: nullable(isTimestamp),
};

export function decodeRemoteItem(item) {
  if (!isRecord(item) || !fieldsMatch(item, ITEM_RUNTIME_FIELDS)) return null;
  try {
    validateBoardItem(item);
    if (item.voteResults != null && (item.type !== 'zone' || !isVoteResults(item.voteResults, item.id))) {
      const safe = { ...item };
      delete safe.voteResults;
      return safe;
    }
    return item;
  } catch (error) {
    // Schema rejection is isolated to this item; never repair the shared doc.
    if (error instanceof Error) return null;
    throw error;
  }
}

export function decodeRemoteBoard(items, meta) {
  const safeMeta = {};
  for (const [key, validate] of Object.entries(META_FIELDS)) {
    if (isRecord(meta) && Object.hasOwn(meta, key) && validate(meta[key])) safeMeta[key] = meta[key];
  }
  return { ...safeMeta, items: items.map(decodeRemoteItem).filter(Boolean) };
}
