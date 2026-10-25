import { effectiveOwnerZone } from './board-ownership.js';
import { voteTimerIsOpen } from './vote-timing.js';

// Nearest zone — the item's own owner, or the nearest ancestor via the
// ownership chain — that currently has an active voteTimer. Mutual exclusion
// at start time guarantees at most one zone in a chain is active at once.
export const activeVoteZone = (item, allItems, atTime) => {
  let zone = effectiveOwnerZone(item, allItems);
  const visited = new Set();
  while (zone && !visited.has(zone.id)) {
    visited.add(zone.id);
    const timer = zone.voteTimer;
    if (voteTimerIsOpen(timer, atTime)) return zone;
    zone = effectiveOwnerZone(zone, allItems);
  }
  return null;
};

// True if this zone, or any ancestor in its ownership chain, currently holds
// a voteTimer — presence-based (not endsAt-gated) so a deeper untimered
// descendant is still treated as "live" while its governing ancestor's
// session hasn't been finalized yet. Used to keep a stale "finished" badge
// from exposing a live in-progress tally anywhere beneath it, not just on
// the zone that stores the timer.
export const zoneHasActiveGovernor = (zone, allItems) => {
  let z = zone;
  const visited = new Set();
  while (z && !visited.has(z.id)) {
    visited.add(z.id);
    if (z.voteTimer) return true;
    z = effectiveOwnerZone(z, allItems);
  }
  return false;
};

