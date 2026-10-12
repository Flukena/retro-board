const STICKY_W = 200;
const STICKY_H = 180;
const TEXT_W = 400;
const TEXT_H = 80;

// Board writes create a new items array. Reuse only the index for that exact
// snapshot; a moved/resized/revealed parent immediately gets a fresh index.
const zoneIndexes = new WeakMap();
const zoneIndexFor = (allItems) => {
  let index = zoneIndexes.get(allItems);
  if (!index) {
    const zones = [];
    const byId = new Map();
    for (const item of allItems) {
      if (item.type !== 'zone') continue;
      zones.push(item);
      byId.set(item.id, item);
    }
    index = { zones, byId };
    zoneIndexes.set(allItems, index);
  }
  return index;
};

export const centerOf = (it) => {
  if (it.type === 'zone') return { x: it.x + it.w / 2, y: it.y + it.h / 2 };
  if (it.type === 'sticky') {
    const w = it.w || STICKY_W;
    const h = it.h || STICKY_H;
    return { x: it.x + w / 2, y: it.y + h / 2 };
  }
  if (it.type === 'text') return { x: it.x + (it.w || TEXT_W) / 2, y: it.y + (it.h || TEXT_H) / 2 };
  if (it.type === 'image') return { x: it.x + (it.w || 200) / 2, y: it.y + (it.h || 200) / 2 };
  return { x: it.x, y: it.y };
};

export const insideZone = (p, z) =>
  p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;

export const effectiveArea = (it) => {
  if (it.type === 'zone') return it.w * it.h;
  const w = it.w || (it.type === 'sticky' ? STICKY_W : it.type === 'text' ? TEXT_W : it.type === 'image' ? 200 : 0);
  const h = it.h || (it.type === 'sticky' ? STICKY_H : it.type === 'text' ? TEXT_H : it.type === 'image' ? 200 : 0);
  return w * h;
};

// Pure geometric lookup, used only when writing a new persistent owner.
export const resolveOwnerZone = (item, allItems) => {
  const c = centerOf(item);
  const area = effectiveArea(item);
  const candidates = zoneIndexFor(allItems).zones.filter((z) => (
    z.type === 'zone' && z.id !== item.id && z.w * z.h > area && insideZone(c, z)
  ));
  if (!candidates.length) return null;
  const minArea = Math.min(...candidates.map((z) => z.w * z.h));
  const tied = candidates.filter((z) => z.w * z.h === minArea);
  if (tied.length > 1) {
    const incumbent = tied.find((z) => z.id === item.parentZoneId);
    if (incumbent) return incumbent;
  }
  return tied[0];
};

// A persisted owner wins while it still covers the item. Explicit null means
// durably unzoned; only legacy items with no field fall back to geometry.
export const effectiveOwnerZone = (item, allItems) => {
  if (Object.prototype.hasOwnProperty.call(item, 'parentZoneId')) {
    if (!item.parentZoneId) return null;
    const z = zoneIndexFor(allItems).byId.get(item.parentZoneId);
    return (z && z.id !== item.id && insideZone(centerOf(item), z)) ? z : null;
  }
  return resolveOwnerZone(item, allItems);
};
