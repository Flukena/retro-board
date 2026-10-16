import { effectiveOwnerZone } from './board-ownership.js';
import { zoneGroupIds, isNestedIn } from './zone-actions.js';

export const CLEARED_VOTE_RESULTS = Object.freeze({ lastResultsAt: null, voteResults: null });

function hasActiveAncestor(root, items) {
  let ancestor = effectiveOwnerZone(root, items);
  const visited = new Set();
  while (ancestor && !visited.has(ancestor.id)) {
    if (ancestor.voteTimer) return true;
    visited.add(ancestor.id);
    ancestor = effectiveOwnerZone(ancestor, items);
  }
  return false;
}
export function voteSessionScope(root, items) {
  const descendantZones = [...zoneGroupIds(root, items)]
    .map((id) => items.find((item) => item.id === id))
    .filter((zone) => zone && zone.type === 'zone');
  const capturedIds = items.filter((item) => item.type === 'sticky').filter((sticky) => {
    const owner = effectiveOwnerZone(sticky, items);
    return !!owner && (owner.id === root.id || isNestedIn(owner, root, items));
  }).map((sticky) => sticky.id);
  return {
    relatedActive: descendantZones.some((zone) => !!zone.voteTimer) || hasActiveAncestor(root, items),
    capturedIds,
    staleResultZoneIds: descendantZones.filter((zone) => zone.lastResultsAt || zone.voteResults).map((zone) => zone.id),
  };
}
export function resetVoteSessionEntries(items) {
  return items.filter((item) => item.type === 'zone' && (item.voteTimer || item.lastResultsAt || item.voteResults))
    .map((zone) => ({ id: zone.id, patch: { voteTimer: null, ...CLEARED_VOTE_RESULTS } }));
}
