import { validateBoardItem } from './import-schema.js';
import { isSafeId } from './comment-schema.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isBoolean = (value) => typeof value === 'boolean';
const isString = (value) => typeof value === 'string';
const nullable = (validate) => (value) => value == null || validate(value);
const TIMER_FIELDS = {
  startedAt: isTimestamp, endsAt: nullable(isTimestamp),
  voteLimit: nullable((value) => Number.isSafeInteger(value) && value > 0),
  hideResults: isBoolean, showNonVoters: isBoolean,
};
const fieldsMatch = (record, fields) => Object.entries(fields).every(([key, validate]) => (
  !Object.hasOwn(record, key) || validate(record[key])
));
const isTimer = (value) => isRecord(value) && fieldsMatch(value, TIMER_FIELDS);
const ITEM_RUNTIME_FIELDS = {
  authorName: nullable(isString), authorId: nullable(isString),
  createdAt: nullable(isTimestamp), parentZoneId: nullable(isSafeId),
  voteTimer: nullable(isTimer), lastResultsAt: nullable(isTimestamp), votingLocked: isBoolean,
};
const META_FIELDS = {
  adminUserId: nullable(isSafeId), adminName: nullable(isString), adminPinHash: nullable(isString),
  editingLocked: isBoolean, votingLocked: isBoolean, allRevealed: isBoolean,
  timer: nullable(isTimer), lastResultsAt: nullable(isTimestamp),
};

export function decodeRemoteItem(item) {
  if (!isRecord(item) || !fieldsMatch(item, ITEM_RUNTIME_FIELDS)) return null;
  try {
    validateBoardItem(item);
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
    if (Object.hasOwn(meta, key) && validate(meta[key])) safeMeta[key] = meta[key];
  }
  return { ...safeMeta, items: items.map(decodeRemoteItem).filter(Boolean) };
}
