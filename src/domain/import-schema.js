import {
  COMMENT_AUTHOR_NAME_MAX_LEN,
  isSafeId,
  normalizeComment,
} from './comment-schema.js';
import {
  BOARD_TEXT_MAX_LENGTH,
  IMPORT_COORDINATE_MAX_ABS,
  IMPORT_DIMENSION_MAX,
  IMPORT_MAX_CUSTOM_TEMPLATES,
  IMPORT_MAX_TEMPLATE_ZONES,
  IMPORT_MAX_TOTAL_TEMPLATE_ZONES,
  IMAGE_SOURCE_MAX_DIMENSION,
  IMAGE_SOURCE_MAX_PIXELS,
  TEMPLATE_NAME_MAX_LENGTH,
  ZONE_TITLE_MAX_LENGTH,
  isSafeImportedImageSource,
} from './security-boundaries.js';
import {
  GEOMETRY_SOURCE,
  geometryErrorForItem,
  repairBoardGeometry,
} from './board-geometry.js';
import { isValidFontColor, isValidFontSize, isValidZIndex } from './item-appearance.js';
import { isBoardTitle } from './board-title.js';

// Portable JSON backups include raster bytes expanded by base64. This file
// budget is separate from the small Yjs transaction after image uploads.
export const IMPORT_MAX_FILE_BYTES = 256 * 1024 * 1024;
export const IMPORT_MAX_CSV_FILE_BYTES = 25 * 1024 * 1024;
export const IMPORT_MAX_ARCHIVE_FILE_BYTES = 1024 * 1024 * 1024;
// A full import becomes one Yjs update. The encoded CRDT update is larger
// than its JSON snapshot, so leave headroom below the relay's 2 MB frame cap.
export const IMPORT_MAX_BUNDLE_BYTES = 1 * 1024 * 1024;
export const IMPORT_MAX_ITEMS = 10_000;
export const IMPORT_MAX_COMMENTS = 5_000;
export const IMPORT_MAX_COMMENTS_PER_ITEM = 500;
export const IMPORT_MAX_VOTES = 20_000;
export const IMPORT_MAX_RECORDS = 25_000;

const ITEM_ROTATION_MAX_DEGREES = 360;
const ITEM_TYPES = new Set(['sticky', 'zone', 'text', 'image']);
const isPlainRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const fail = (message) => {
  throw new Error(message);
};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const safeTimestamp = (value, fallback) => (
  Number.isSafeInteger(value) && value >= 0 ? value : fallback
);
const finiteWithin = (value, maxAbs) => Number.isFinite(value) && Math.abs(value) <= maxAbs;
const positiveWithin = (value, max) => Number.isFinite(value) && value > 0 && value <= max;

const readBoundedString = (value, maxLength, label, { optional = false } = {}) => {
  if (value == null && optional) return '';
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (value.length > maxLength) fail(`${label} is too long (max ${maxLength})`);
  return value;
};

const readOptionalBoolean = (record, key, label) => {
  if (!hasOwn(record, key)) return undefined;
  if (typeof record[key] !== 'boolean') fail(`${label} must be a boolean`);
  return record[key];
};

const readOptionalNullableBoolean = (record, key, label) => {
  if (!hasOwn(record, key) || record[key] == null) return undefined;
  return readOptionalBoolean(record, key, label);
};

const stickyRevealOverride = (item) => {
  if (!hasOwn(item, 'revealed')) return {};
  if (item.revealed !== false && item.revealed !== null) {
    fail(`item ${item.id} revealed must be false or null`);
  }
  return { revealed: item.revealed };
};

const normalizeColor = (value, label) => {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 5) fail(`${label} has an invalid color`);
  return value;
};

const normalizeFontColor = (value, label) => {
  if (value == null) return undefined;
  if (!isValidFontColor(value)) {
    fail(`${label} has an invalid fontColor`);
  }
  return value.toLowerCase();
};

const normalizeTemplateZone = (zone, templateId, index) => {
  const label = `template ${templateId} zone ${index + 1}`;
  if (!isPlainRecord(zone)) fail(`${label} is not an object`);
  if (!finiteWithin(zone.x, IMPORT_COORDINATE_MAX_ABS)
    || !finiteWithin(zone.y, IMPORT_COORDINATE_MAX_ABS)) {
    fail(`${label} has invalid coordinates`);
  }
  if (!positiveWithin(zone.w, IMPORT_DIMENSION_MAX)
    || !positiveWithin(zone.h, IMPORT_DIMENSION_MAX)) {
    fail(`${label} has invalid dimensions`);
  }
  const title = readBoundedString(zone.title ?? '', ZONE_TITLE_MAX_LENGTH, `${label} title`);
  const color = normalizeColor(zone.color, label);
  return {
    title,
    color: color ?? 0,
    x: zone.x,
    y: zone.y,
    w: zone.w,
    h: zone.h,
  };
};

export const normalizeCustomTemplates = (value, importedAt = Date.now()) => {
  if (value == null) return null;
  if (!Array.isArray(value)) fail('customTemplates must be an array');
  if (value.length > IMPORT_MAX_CUSTOM_TEMPLATES) {
    fail(`too many custom templates (max ${IMPORT_MAX_CUSTOM_TEMPLATES})`);
  }
  const ids = new Set();
  let totalZones = 0;
  return value.map((template, index) => {
    if (!isPlainRecord(template)) fail(`custom template ${index + 1} is not an object`);
    if (!isSafeId(template.id)) fail(`custom template ${index + 1} has an invalid id`);
    if (ids.has(template.id)) fail(`duplicate custom template id: ${template.id}`);
    ids.add(template.id);
    const name = readBoundedString(
      template.name,
      TEMPLATE_NAME_MAX_LENGTH,
      `custom template ${template.id} name`,
    ).trim();
    if (!name) fail(`custom template ${template.id} has an empty name`);
    if (!Array.isArray(template.zones) || template.zones.length === 0) {
      fail(`custom template ${template.id} must contain zones`);
    }
    if (template.zones.length > IMPORT_MAX_TEMPLATE_ZONES) {
      fail(`custom template ${template.id} has too many zones (max ${IMPORT_MAX_TEMPLATE_ZONES})`);
    }
    totalZones += template.zones.length;
    if (totalZones > IMPORT_MAX_TOTAL_TEMPLATE_ZONES) {
      fail(`custom templates have too many zones (max ${IMPORT_MAX_TOTAL_TEMPLATE_ZONES})`);
    }
    return {
      id: template.id,
      name,
      zones: template.zones.map((zone, zoneIndex) => (
        normalizeTemplateZone(zone, template.id, zoneIndex)
      )),
      createdAt: safeTimestamp(template.createdAt, importedAt + index),
    };
  });
};

const normalizeItemAppearance = (item, zLimit) => {
  const normalized = {};
  const color = normalizeColor(item.color, `item ${item.id}`);
  if (color != null) normalized.color = color;
  const fontColor = normalizeFontColor(item.fontColor, `item ${item.id}`);
  if (fontColor != null) normalized.fontColor = fontColor;
  if (item.fontSize != null) {
    if (!isValidFontSize(item.fontSize)) {
      fail(`item ${item.id} has an invalid fontSize`);
    }
    normalized.fontSize = item.fontSize;
  }
  if (item.rotation != null) {
    if (!Number.isFinite(item.rotation) || Math.abs(item.rotation) > ITEM_ROTATION_MAX_DEGREES) {
      fail(`item ${item.id} has an invalid rotation`);
    }
    normalized.rotation = item.rotation;
  }
  if (isValidZIndex(item.zIndex, zLimit)) {
    normalized.zIndex = item.zIndex;
  } else if (item.zIndex != null) {
    fail(`item ${item.id} has an invalid zIndex`);
  }

  return normalized;
};

const normalizeImageFields = (item) => {
  const normalized = {};
  if (!isSafeImportedImageSource(item.src)) fail(`image ${item.id} has an invalid src`);
  normalized.src = item.src;
  const hasNatW = item.natW != null;
  const hasNatH = item.natH != null;
  if (hasNatW !== hasNatH) fail(`image ${item.id} has incomplete natural dimensions`);
  if (hasNatW) {
    if (!positiveWithin(item.natW, IMAGE_SOURCE_MAX_DIMENSION)
      || !positiveWithin(item.natH, IMAGE_SOURCE_MAX_DIMENSION)
      || item.natW * item.natH > IMAGE_SOURCE_MAX_PIXELS) {
      fail(`image ${item.id} has invalid natural dimensions`);
    }
    normalized.natW = item.natW;
    normalized.natH = item.natH;
  }
  return normalized;
};

const normalizeZoneFields = (item) => {
  const normalized = {};
  normalized.title = readBoundedString(
    item.title ?? '', ZONE_TITLE_MAX_LENGTH, `zone ${item.id} title`,
  );
  const locked = readOptionalBoolean(item, 'locked', `zone ${item.id} locked`);
  // `null`/missing means inherit from the nearest ancestor zone or board.
  const revealed = readOptionalNullableBoolean(item, 'revealed', `zone ${item.id} revealed`);
  if (locked != null) normalized.locked = locked;
  if (revealed != null) normalized.revealed = revealed;
  return normalized;
};

const normalizeBoardItem = (item, index, importedAt, zLimit) => {
  if (!isPlainRecord(item)) fail(`item ${index + 1} is not an object`);
  if (!isSafeId(item.id)) fail(`item ${index + 1} has an invalid id`);
  if (!ITEM_TYPES.has(item.type)) fail(`item ${item.id} has an invalid type`);
  const geometryError = geometryErrorForItem(item);
  if (geometryError) fail(geometryError);

  const normalized = {
    id: item.id,
    type: item.type,
    x: item.x,
    y: item.y,
    authorId: isSafeId(item.authorId) ? item.authorId : '',
    authorName: typeof item.authorName === 'string'
      ? item.authorName.slice(0, COMMENT_AUTHOR_NAME_MAX_LEN)
      : '',
    createdAt: safeTimestamp(item.createdAt, importedAt + index),
  };
  ['w', 'h'].forEach((field) => {
    if (item[field] != null) normalized[field] = item[field];
  });
  if (hasOwn(item, 'parentZoneId')) normalized.parentZoneId = item.parentZoneId;

  Object.assign(normalized, normalizeItemAppearance(item, zLimit));
  if (item.type === 'sticky' || item.type === 'text') {
    normalized.text = readBoundedString(
      item.text ?? '', BOARD_TEXT_MAX_LENGTH, `item ${item.id} text`,
    );
  }
  if (item.type === 'sticky') {
    const privateValue = readOptionalBoolean(item, 'private', `item ${item.id} private`);
    normalized.private = privateValue ?? false;
    Object.assign(normalized, stickyRevealOverride(item));
  }
  if (item.type === 'zone') Object.assign(normalized, normalizeZoneFields(item));
  if (item.type === 'image') Object.assign(normalized, normalizeImageFields(item));
  return normalized;
};

// Remote reads reuse the strict item contract without import's geometry repair.
// The caller retains original valid values instead of applying import defaults.
export const validateBoardItem = (item) => {
  normalizeBoardItem(item, 0, 0, Number.MAX_SAFE_INTEGER);
};

const importedBoardTitle = (title) => {
  if (title == null) return null;
  if (!isBoardTitle(title)) fail('board.title must be a trimmed, non-empty bounded string');
  return title;
};

const normalizeBoardMeta = (board) => ({
  timer: null,
  editingLocked: board.editingLocked === true,
  votingLocked: board.votingLocked === true,
  allRevealed: board.allRevealed === true,
  lastResultsAt: safeTimestamp(board.lastResultsAt, null),
  title: importedBoardTitle(board.title),
});

// Validate and normalize every cross-reference before an import is allowed to
// replace live state. This module deliberately has no browser/Yjs dependency,
// making malformed backups testable without connecting to a room.
export const normalizeImportManifest = (parsed, importedAt = Date.now()) => {
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.board) || !Array.isArray(parsed.board.items)) {
    fail('missing board.items');
  }
  if (parsed.board.items.length > IMPORT_MAX_ITEMS) fail(`too many items (max ${IMPORT_MAX_ITEMS})`);
  const repaired = repairBoardGeometry(parsed.board.items, {
    source: GEOMETRY_SOURCE.LEGACY_IMPORT,
  });
  const manifest = {
    ...parsed,
    board: { ...parsed.board, items: repaired.items },
  };

  const zLimit = Number.MAX_SAFE_INTEGER - manifest.board.items.length - 1;
  const itemById = new Map();
  const items = manifest.board.items.map((item, index) => {
    const normalized = normalizeBoardItem(item, index, importedAt, zLimit);
    if (itemById.has(normalized.id)) fail(`duplicate item id: ${normalized.id}`);
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
  if (manifest.votes != null) {
    if (!isPlainRecord(manifest.votes)) fail('votes must be an object');
    Object.entries(manifest.votes).forEach(([itemId, voters]) => {
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
  if (manifest.comments != null) {
    if (!isPlainRecord(manifest.comments)) fail('comments must be an object');
    Object.entries(manifest.comments).forEach(([itemId, comments]) => {
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

  const customTemplates = normalizeCustomTemplates(manifest.customTemplates, importedAt);
  const customTemplateZoneCount = customTemplates?.reduce((sum, template) => sum + template.zones.length, 0) ?? 0;
  const recordCount = items.length + voteEntries.length + commentEntries.length
    + (customTemplates?.length ?? 0) + customTemplateZoneCount;
  if (recordCount > IMPORT_MAX_RECORDS) fail(`too many records (max ${IMPORT_MAX_RECORDS})`);

  return {
    items,
    voteEntries,
    commentEntries,
    customTemplates,
    boardMeta: normalizeBoardMeta(manifest.board),
    geometryRepairs: repaired.repairs,
  };
};

export const importBundleByteLength = (bundle) => (
  new TextEncoder().encode(JSON.stringify(bundle)).byteLength
);
