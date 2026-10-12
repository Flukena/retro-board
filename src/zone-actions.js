import { effectiveOwnerZone } from './board-ownership.js';

export const isNestedIn = (z, ancestor, allItems) => {
  let current = z;
  const visited = new Set();
  while (!visited.has(current.id)) {
    visited.add(current.id);
    const parent = effectiveOwnerZone(current, allItems);
    if (!parent) return false;
    if (parent.id === ancestor.id) return true;
    current = parent;
  }
  return false;
};

// Ids of every item that moves together with `zone` for drag/z-order: the zone
// itself, any persistently nested zone, and any sticky/image/text owned by the
// root zone or one of those nested zones.
export const zoneGroupIds = (zone, allItems) => {
  const ids = new Set([zone.id]);
  const allZones = allItems.filter((i) => i.type === 'zone');
  allZones.forEach((z) => {
    if (z.id !== zone.id && isNestedIn(z, zone, allItems)) ids.add(z.id);
  });
  allItems.forEach((it) => {
    if (it.type === 'zone' || ids.has(it.id)) return;
    const owner = effectiveOwnerZone(it, allItems);
    if (owner && ids.has(owner.id)) ids.add(it.id);
  });
  return ids;
};

// A card's owner zone can hide/reveal its own private cards independently of
// the board-wide (now-legacy) allRevealed flag. A zone that has never had its
// own toggle clicked (revealed == null) inherits from the nearest ancestor
// zone that HAS an explicit value instead of jumping straight to the board
// default — so hiding a wrapper zone also hides a nested zone that hasn't
// set its own override, while a nested zone with its own explicit setting
// still keeps it (mirrors the ownership-chain walk activeVoteZone uses).
export const effectiveRevealed = (item, allItems, boardAllRevealed) => {
  let zone = effectiveOwnerZone(item, allItems);
  const visited = new Set();
  while (zone && !visited.has(zone.id)) {
    if (zone.revealed != null) return zone.revealed;
    visited.add(zone.id);
    zone = effectiveOwnerZone(zone, allItems);
  }
  return boardAllRevealed;
};

export const zoneEffectiveRevealed = (zone, items, allRevealed) => (
  zone.revealed ?? effectiveRevealed(zone, items, allRevealed)
);
