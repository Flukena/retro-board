import { centerOf, insideZone, resolveOwnerZone } from './board-ownership.js';
import { applyItemEntries, mergeItemEntries } from './move-concealment.js';

const detachedChildEntries = (zone, items) => items.filter((child) => (
  child.parentZoneId === zone.id && !insideZone(centerOf(child), zone)
)).map(({ id }) => ({ id, patch: { parentZoneId: null } }));

// Final drag ownership shared by item/group drag and zone-carries-children.
export const reparentMoveEntries = (items, entries, primaryIds) => {
  const finalItems = applyItemEntries(items, entries);
  const reparents = [];
  for (const id of primaryIds) {
    const item = finalItems.find((candidate) => candidate.id === id);
    if (!item || (item.type === 'zone' && item.locked)) continue;
    const parentZoneId = resolveOwnerZone(item, finalItems)?.id ?? null;
    if (!Object.hasOwn(item, 'parentZoneId') || item.parentZoneId !== parentZoneId) {
      reparents.push({ id, patch: { parentZoneId } });
    }
    if (item.type === 'zone') reparents.push(...detachedChildEntries(item, finalItems));
  }
  return mergeItemEntries(entries, reparents);
};
