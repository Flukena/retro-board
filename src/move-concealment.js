import { stickyEffectiveRevealed } from './board-visibility.js';
import { isNestedIn } from './zone-actions.js';

export const mergeItemEntries = (...batches) => {
  const patches = new Map();
  for (const { id, patch } of batches.flat()) patches.set(id, { ...patches.get(id), ...patch });
  return Array.from(patches, ([id, patch]) => ({ id, patch }));
};

export const applyItemEntries = (items, entries) => {
  const patches = new Map(mergeItemEntries(entries).map(({ id, patch }) => [id, patch]));
  return items.map((item) => patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item);
};

export const concealEntriesForMove = (beforeItems, afterItems, allRevealed) => {
  const beforeById = new Map(beforeItems.map((item) => [item.id, item]));
  const zoneRevealChanged = afterItems.some((item) => (
    item.type === 'zone' && beforeById.has(item.id)
    && item.revealed !== beforeById.get(item.id).revealed
  ));
  if (zoneRevealChanged) return [];
  return afterItems.filter((item) => {
    const before = beforeById.get(item.id);
    return item.type === 'sticky' && item.private && before?.private
      && !stickyEffectiveRevealed(before, beforeItems, allRevealed)
      && stickyEffectiveRevealed(item, afterItems, allRevealed);
  }).map(({ id }) => ({ id, patch: { revealed: false } }));
};

// Deliberately walk the whole owner chain, even past explicit nested overrides.
export const revealEntriesForZone = (zoneId, patch, items) => {
  if (patch.revealed !== true) return [];
  const zone = items.find((item) => item.id === zoneId && item.type === 'zone');
  if (!zone) return [];
  return items.filter((item) => (
    item.type === 'sticky' && item.private && item.revealed === false
    && isNestedIn(item, zone, items)
  )).map(({ id }) => ({ id, patch: { revealed: null } }));
};

// Shared by optimistic geometry and canonical storage. All patches remain in
// the caller's one transaction, including inherited changes on unmoved cards.
export const protectedItemEntries = (items, entries, allRevealed) => {
  const after = applyItemEntries(items, entries);
  const clears = entries.flatMap(({ id, patch }) => revealEntriesForZone(id, patch, after));
  return mergeItemEntries(entries, concealEntriesForMove(items, after, allRevealed), clears);
};
