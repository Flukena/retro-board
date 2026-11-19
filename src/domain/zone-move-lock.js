import { effectiveOwnerZone } from './board-ownership.js';

// Single enforcement point for "locked zones don't move" — every drag/
// resize path (solo, group, zone-carries-children) funnels through here,
// so filtering here also covers a locked zone caught in someone else's
// multi-select drag, not just its own title bar / resize handles.
//
// A locked zone should still be carried along when a larger unlocked
// ANCESTOR zone is the one being dragged — lock means "don't let a user
// grab/resize this zone directly", not "detach it from its parent's
// movement". A locked zone's patch is allowed only when ALL of:
//   - it's a pure x/y move (no w/h — resize never gets a pass, otherwise
//     a group-resize could still rescale a locked nested zone), and
//   - its immediate owner zone also has a patch in this same batch, and
//   - that owner is itself allowed to move (checked recursively, so a
//     locked zone under another locked, non-moving zone stays put too —
//     the owner's mere presence in the batch isn't proof it's moving,
//     since the owner itself may get filtered out).
export function filterLockedZoneMoves(items, entries, itemById = new Map(items.map(item => [item.id, item]))) {
  const patchById = new Map(entries.map((e) => [e.id, e.patch]));
  const isPureMove = (patch) => !('w' in patch) && !('h' in patch);
  const allowedCache = new Map();
  const isAllowed = (id) => {
    if (allowedCache.has(id)) return allowedCache.get(id);
    allowedCache.set(id, false); // guards a cyclic parentZoneId chain
    const it = itemById.get(id);
    let result = true;
    if (it?.type === 'zone' && it.locked) {
      const patch = patchById.get(id);
      const parent = patch && isPureMove(patch) ? effectiveOwnerZone(it, items) : null;
      result = !!(parent && patchById.has(parent.id) && isAllowed(parent.id));
    }
    allowedCache.set(id, result);
    return result;
  };
  return entries.filter((e) => isAllowed(e.id));
}
