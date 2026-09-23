import {
  GEOMETRY_SOURCE,
  repairBoardGeometry,
} from './board-geometry.js';

const isYMapLike = (value) => (
  value != null
  && typeof value.get === 'function'
  && typeof value.set === 'function'
  && typeof value.forEach === 'function'
);

// Repair legacy room records in-place after the canonical Yjs document has
// synced. Only missing geometry fields are written, so valid positions and all
// non-geometry data remain untouched. A second call is a no-op.
export const repairStoredBoardGeometry = (ydoc, yItems) => {
  if (typeof ydoc?.transact !== 'function' || !isYMapLike(yItems)) {
    return { positions: 0, zoneDimensions: 0 };
  }

  const items = [];
  yItems.forEach((yItem, id) => {
    if (!isYMapLike(yItem)) return;
    items.push({
      id,
      type: yItem.get('type'),
      x: yItem.get('x'),
      y: yItem.get('y'),
      w: yItem.get('w'),
      h: yItem.get('h'),
    });
  });

  const repaired = repairBoardGeometry(items, { source: GEOMETRY_SOURCE.STORED_ROOM });
  if (!repaired.patchEntries.length) return repaired.repairs;

  ydoc.transact(() => {
    repaired.patchEntries.forEach(({ id, patch }) => {
      const yItem = yItems.get(id);
      if (!isYMapLike(yItem)) return;
      Object.entries(patch).forEach(([field, value]) => yItem.set(field, value));
    });
  }, 'system');

  return repaired.repairs;
};
