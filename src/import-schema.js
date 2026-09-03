import {
  COMMENT_AUTHOR_NAME_MAX_LEN,
  isSafeId,
  normalizeComment,
} from './comment-schema.js';

export const IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024;
// A full import becomes one Yjs update. The encoded CRDT update is larger
// than its JSON snapshot, so leave headroom below the relay's 2 MB frame cap.
export const IMPORT_MAX_BUNDLE_BYTES = 1 * 1024 * 1024;
export const IMPORT_MAX_ITEMS = 10_000;
export const IMPORT_MAX_COMMENTS = 5_000;
export const IMPORT_MAX_COMMENTS_PER_ITEM = 500;
export const IMPORT_MAX_VOTES = 20_000;
export const IMPORT_MAX_RECORDS = 25_000;

const ITEM_TYPES = new Set(['sticky', 'zone', 'text', 'image']);
const isPlainRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const fail = (message) => {
  throw new Error(message);
};

// Validate and normalize every cross-reference before an import is allowed to
// replace live state. This module deliberately has no browser/Yjs dependency,
// making malformed backups testable without connecting to a room.
export const normalizeImportManifest = (parsed, importedAt = Date.now()) => {
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.board) || !Array.isArray(parsed.board.items)) {
    fail('missing board.items');
  }
  if (parsed.board.items.length > IMPORT_MAX_ITEMS) fail(`too many items (max ${IMPORT_MAX_ITEMS})`);

  const zLimit = Number.MAX_SAFE_INTEGER - parsed.board.items.length - 1;
  const itemById = new Map();
  const items = parsed.board.items.map((item, index) => {
    if (!isPlainRecord(item)) fail(`item ${index + 1} is not an object`);
    if (!isSafeId(item.id)) fail(`item ${index + 1} has an invalid id`);
    if (itemById.has(item.id)) fail(`duplicate item id: ${item.id}`);
    if (!ITEM_TYPES.has(item.type)) fail(`item ${item.id} has an invalid type`);
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) {
      fail(`item ${item.id} has invalid coordinates`);
    }
    if (item.type === 'zone' && (
      !Number.isFinite(item.w) || item.w <= 0 || !Number.isFinite(item.h) || item.h <= 0
    )) {
      fail(`zone ${item.id} has invalid dimensions`);
    }
    ['w', 'h'].forEach((field) => {
      if (item[field] != null && (!Number.isFinite(item[field]) || item[field] <= 0)) {
        fail(`item ${item.id} has an invalid ${field}`);
      }
    });
    const normalized = { ...item };
    normalized.authorId = isSafeId(item.authorId) ? item.authorId : '';
    normalized.authorName = typeof item.authorName === 'string'
      ? item.authorName.slice(0, COMMENT_AUTHOR_NAME_MAX_LEN)
      : '';
    if (item.type === 'sticky' || item.type === 'text') {
      normalized.text = typeof item.text === 'string' ? item.text : '';
    }
    if (item.type === 'zone') {
      normalized.title = typeof item.title === 'string' ? item.title : '';
    }
    if (item.type === 'image' && typeof item.src !== 'string') {
      fail(`image ${item.id} has an invalid src`);
    }
    normalized.createdAt = Number.isFinite(item.createdAt) && Math.abs(item.createdAt) <= zLimit
      ? item.createdAt
      : importedAt + index;
    if (!Number.isFinite(item.zIndex) || Math.abs(item.zIndex) > zLimit) delete normalized.zIndex;
    if (!Number.isFinite(item.rotation)) delete normalized.rotation;
    if (!Number.isFinite(item.fontSize) || item.fontSize <= 0) delete normalized.fontSize;
    itemById.set(item.id, normalized);
    return normalized;
  });

  items.forEach((item) => {
    if (item.parentZoneId == null) return;
    if (!isSafeId(item.parentZoneId)) fail(`item ${item.id} has an invalid parentZoneId`);
    const parent = itemById.get(item.parentZoneId);
    if (!parent || parent.type !== 'zone') fail(`item ${item.id} references a missing parent zone`);
    if (parent.id === item.id) fail(`item ${item.id} cannot own itself`);
  });
  items.forEach((item) => {
    const visited = new Set([item.id]);
    let parentId = item.parentZoneId;
    while (parentId) {
      if (visited.has(parentId)) fail(`cyclic parentZoneId chain at ${item.id}`);
      visited.add(parentId);
      parentId = itemById.get(parentId)?.parentZoneId ?? null;
    }
  });

  const voteEntries = [];
  const voteKeys = new Set();
  if (parsed.votes != null) {
    if (!isPlainRecord(parsed.votes)) fail('votes must be an object');
    Object.entries(parsed.votes).forEach(([itemId, voters]) => {
      if (itemById.get(itemId)?.type !== 'sticky') fail(`votes reference a non-sticky item: ${itemId}`);
      if (!Array.isArray(voters)) fail(`votes for ${itemId} must be an array`);
      voters.forEach((userId) => {
        if (!isSafeId(userId)) fail(`vote for ${itemId} has an invalid user id`);
        const key = `${itemId}:${userId}`;
        if (voteKeys.has(key)) fail(`duplicate vote: ${key}`);
        voteKeys.add(key);
        voteEntries.push({ itemId, userId });
        if (voteEntries.length > IMPORT_MAX_VOTES) fail(`too many votes (max ${IMPORT_MAX_VOTES})`);
      });
    });
  }

  const commentEntries = [];
  if (parsed.comments != null) {
    if (!isPlainRecord(parsed.comments)) fail('comments must be an object');
    Object.entries(parsed.comments).forEach(([itemId, comments]) => {
      if (itemById.get(itemId)?.type !== 'sticky') fail(`comments reference a non-sticky item: ${itemId}`);
      if (!Array.isArray(comments)) fail(`comments for ${itemId} must be an array`);
      if (comments.length > IMPORT_MAX_COMMENTS_PER_ITEM) {
        fail(`too many comments for ${itemId} (max ${IMPORT_MAX_COMMENTS_PER_ITEM})`);
      }
      const commentIds = new Set();
      comments.forEach((comment) => {
        const normalized = normalizeComment(comment, comment?.id, importedAt + commentEntries.length);
        if (!normalized) fail(`invalid comment for ${itemId}`);
        if (commentIds.has(normalized.id)) fail(`duplicate comment id for ${itemId}: ${normalized.id}`);
        commentIds.add(normalized.id);
        commentEntries.push({ itemId, comment: normalized });
        if (commentEntries.length > IMPORT_MAX_COMMENTS) {
          fail(`too many comments (max ${IMPORT_MAX_COMMENTS})`);
        }
      });
    });
  }

  const customTemplates = parsed.customTemplates == null ? null : parsed.customTemplates;
  if (customTemplates !== null && !Array.isArray(customTemplates)) fail('customTemplates must be an array');
  const recordCount = items.length + voteEntries.length + commentEntries.length + (customTemplates?.length ?? 0);
  if (recordCount > IMPORT_MAX_RECORDS) fail(`too many records (max ${IMPORT_MAX_RECORDS})`);

  return { items, voteEntries, commentEntries, customTemplates };
};

export const importBundleByteLength = (bundle) => (
  new TextEncoder().encode(JSON.stringify(bundle)).byteLength
);
