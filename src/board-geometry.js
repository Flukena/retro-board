import {
  IMPORT_COORDINATE_MAX_ABS,
  IMPORT_DIMENSION_MAX,
} from './security-boundaries.js';

export const GEOMETRY_SOURCE = Object.freeze({
  LEGACY_IMPORT: 'legacy-import',
  STORED_ROOM: 'stored-room',
});

const ITEM_SIZE = Object.freeze({
  sticky: Object.freeze({ w: 200, h: 180 }),
  zone: Object.freeze({ w: 1200, h: 1080 }),
  text: Object.freeze({ w: 400, h: 80 }),
  image: Object.freeze({ w: 200, h: 200 }),
});
const RECOVERY_GAP = 48;
const RECOVERY_ROW_WIDTH = 6000;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteCoordinate = (value) => (
  Number.isFinite(value) && Math.abs(value) <= IMPORT_COORDINATE_MAX_ABS
);
const validDimension = (value) => (
  Number.isFinite(value) && value > 0 && value <= IMPORT_DIMENSION_MAX
);
const sizeForPlacement = (item) => {
  const fallback = ITEM_SIZE[item?.type] || ITEM_SIZE.sticky;
  return {
    w: validDimension(item?.w) ? item.w : fallback.w,
    h: validDimension(item?.h) ? item.h : fallback.h,
  };
};

export const geometryErrorForItem = (item) => {
  const label = typeof item?.id === 'string' && item.id ? item.id : 'unknown';
  if (!isRecord(item) || !finiteCoordinate(item.x) || !finiteCoordinate(item.y)) {
    return `item ${label} has invalid coordinates`;
  }
  if (item.type === 'zone' && (!validDimension(item.w) || !validDimension(item.h))) {
    return `zone ${label} has invalid dimensions`;
  }
  for (const field of ['w', 'h']) {
    if (item[field] != null && !validDimension(item[field])) {
      return `item ${label} has an invalid ${field}`;
    }
  }
  return null;
};

export const geometryErrorForPatch = (currentItem, patch) => (
  geometryErrorForItem({ ...currentItem, ...patch })
);

export const geometryErrorForBoard = (items) => {
  if (!Array.isArray(items)) return 'board items must be an array';
  for (const item of items) {
    const error = geometryErrorForItem(item);
    if (error) return error;
  }
  return null;
};

// One geometry interface serves both flows:
// - legacy-import repairs only omitted fields; explicit invalid values remain errors.
// - stored-room repairs any invalid canonical geometry left by old clients.
// The input is never mutated. Patch entries contain only fields that changed.
export const repairBoardGeometry = (inputItems, { source = GEOMETRY_SOURCE.LEGACY_IMPORT } = {}) => {
  if (!Array.isArray(inputItems)) {
    return {
      items: inputItems,
      repairs: { positions: 0, zoneDimensions: 0 },
      patchEntries: [],
    };
  }
  const repairInvalid = source === GEOMETRY_SOURCE.STORED_ROOM;
  const items = inputItems.map((item) => (isRecord(item) ? { ...item } : item));
  const patchById = new Map();
  const addPatch = (item, patch) => {
    if (typeof item?.id !== 'string' || !item.id) return;
    patchById.set(item.id, {
      id: item.id,
      patch: { ...(patchById.get(item.id)?.patch || {}), ...patch },
    });
  };

  let zoneDimensions = 0;
  items.forEach((item) => {
    if (!isRecord(item) || item.type !== 'zone') return;
    const repairWidth = repairInvalid
      ? !validDimension(item.w)
      : (!hasOwn(item, 'w') || item.w === undefined);
    const repairHeight = repairInvalid
      ? !validDimension(item.h)
      : (!hasOwn(item, 'h') || item.h === undefined);
    if (!repairWidth && !repairHeight) return;
    const patch = {};
    if (repairWidth) {
      item.w = ITEM_SIZE.zone.w;
      patch.w = item.w;
    }
    if (repairHeight) {
      item.h = ITEM_SIZE.zone.h;
      patch.h = item.h;
    }
    addPatch(item, patch);
    zoneDimensions += 1;
  });

  const needsPosition = (item) => {
    if (!isRecord(item)) return false;
    if (repairInvalid) return !finiteCoordinate(item.x) || !finiteCoordinate(item.y);
    return (!hasOwn(item, 'x') || item.x === undefined)
      && (!hasOwn(item, 'y') || item.y === undefined);
  };
  const missingPositions = items.filter(needsPosition);
  if (missingPositions.length) {
    const positioned = items.filter((item) => (
      isRecord(item) && finiteCoordinate(item.x) && finiteCoordinate(item.y)
    ));
    const originX = positioned.length ? Math.min(...positioned.map((item) => item.x)) : 0;
    const bottom = positioned.length
      ? Math.max(...positioned.map((item) => item.y + sizeForPlacement(item).h))
      : 0;
    let cursorX = originX;
    let cursorY = bottom + RECOVERY_GAP;
    let rowHeight = 0;
    if (!finiteCoordinate(cursorY)) throw new Error('cannot safely recover missing item positions');

    missingPositions.forEach((item) => {
      const size = sizeForPlacement(item);
      if (cursorX > originX && cursorX + size.w > originX + RECOVERY_ROW_WIDTH) {
        cursorX = originX;
        cursorY += rowHeight + RECOVERY_GAP;
        rowHeight = 0;
      }
      if (!finiteCoordinate(cursorX)
        || !finiteCoordinate(cursorY)
        || cursorX + size.w > IMPORT_COORDINATE_MAX_ABS
        || cursorY + size.h > IMPORT_COORDINATE_MAX_ABS) {
        throw new Error('cannot safely recover missing item positions');
      }
      item.x = cursorX;
      item.y = cursorY;
      addPatch(item, { x: item.x, y: item.y });
      cursorX += size.w + RECOVERY_GAP;
      rowHeight = Math.max(rowHeight, size.h);
    });
  }

  return {
    items,
    repairs: { positions: missingPositions.length, zoneDimensions },
    patchEntries: Array.from(patchById.values()),
  };
};
