import { protectedItemEntries } from './move-concealment.js';
import {
  GEOMETRY_SOURCE,
  repairBoardGeometry,
} from './board-geometry.js';

const META_MAP_KEY = 'meta';
const ALL_REVEALED_KEY = 'allRevealed';

const isYMapLike = (value) => (
  value != null
  && typeof value.get === 'function'
  && typeof value.set === 'function'
  && typeof value.forEach === 'function'
);

// Repair legacy room records in-place after the canonical Yjs document has
// synced. Valid geometry remains untouched; concealment accompanies any
// inherited reveal caused by repair. A second call is a no-op.
export const repairStoredBoardGeometry = (ydoc, yItems) => {
  if (typeof ydoc?.transact !== 'function' || !isYMapLike(yItems)) {
    return { positions: 0, zoneDimensions: 0 };
  }

  const items = [];
  yItems.forEach((yItem, id) => {
    if (!isYMapLike(yItem)) return;
    const item = { id };
    yItem.forEach((value, field) => { item[field] = value; });
    items.push(item);
  });

  const repaired = repairBoardGeometry(items, { source: GEOMETRY_SOURCE.STORED_ROOM });
  if (!repaired.patchEntries.length) return repaired.repairs;

  const allRevealed = ydoc.getMap(META_MAP_KEY).get(ALL_REVEALED_KEY) === true;
  const entries = protectedItemEntries(items, repaired.patchEntries, allRevealed);
  ydoc.transact(() => {
    entries.forEach(({ id, patch }) => {
      const yItem = yItems.get(id);
      if (!isYMapLike(yItem)) return;
      Object.entries(patch).forEach(([field, value]) => yItem.set(field, value));
    });
  }, 'system');

  return repaired.repairs;
};
