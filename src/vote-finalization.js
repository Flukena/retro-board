import { protectedItemEntries } from './move-concealment.js';
import { buildVoteResults } from './vote-results.js';
import { zoneHeaderClearancePx } from './zone-title.js';

// Deterministic finalization plan shared by the browser and the relay. The
// relay runs it when a deadline passes even if the room creator is offline.
const STICKY_W = 200;
const STICKY_H = 180;
const TEXT_W = 400;
const TEXT_H = 80;
const GAP = 24;
const PAD = 16;

const centerOf = (item) => {
  if (item.type === 'zone') return { x: item.x + item.w / 2, y: item.y + item.h / 2 };
  const widths = { sticky: STICKY_W, text: TEXT_W, image: 200 };
  const heights = { sticky: STICKY_H, text: TEXT_H, image: 200 };
  return {
    x: item.x + (item.w || widths[item.type] || 0) / 2,
    y: item.y + (item.h || heights[item.type] || 0) / 2,
  };
};

const ownerZone = (item, items) => {
  const point = centerOf(item);
  const contains = (zone) => (
    point.x >= zone.x && point.x <= zone.x + zone.w
    && point.y >= zone.y && point.y <= zone.y + zone.h
  );
  if (Object.prototype.hasOwnProperty.call(item, 'parentZoneId')) {
    if (!item.parentZoneId) return null;
    return items.find((zone) => (
      zone.id === item.parentZoneId && zone.type === 'zone'
      && zone.id !== item.id && contains(zone)
    )) || null;
  }
  const defaultW = item.type === 'sticky' ? STICKY_W : item.type === 'text' ? TEXT_W : 200;
  const defaultH = item.type === 'sticky' ? STICKY_H : item.type === 'text' ? TEXT_H : 200;
  const area = item.type === 'zone' ? item.w * item.h
    : (item.w || defaultW) * (item.h || defaultH);
  const candidates = items.filter((zone) => (
    zone.type === 'zone' && zone.id !== item.id
    && zone.w * zone.h > area && contains(zone)
  ));
  if (!candidates.length) return null;
  const minArea = Math.min(...candidates.map((zone) => zone.w * zone.h));
  const tied = candidates.filter((zone) => zone.w * zone.h === minArea);
  return tied.find((zone) => zone.id === item.parentZoneId) || tied[0];
};

const isDescendant = (zone, root, items) => {
  let current = zone;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    current = ownerZone(current, items);
    if (current?.id === root.id) return true;
  }
  return false;
};

const buildFinalizationPlan = (items, votesByItem, zoneId, atTime, participants = []) => {
  const root = items.find((item) => item.id === zoneId && item.type === 'zone');
  if (!root?.voteTimer) return null;
  const zones = items.filter((item) => (
    item.type === 'zone'
    && (item.id === zoneId || (isDescendant(item, root, items) && !item.voteTimer))
  ));
  const zoneIds = new Set(zones.map((zone) => zone.id));
  const stickies = items.filter((item) => item.type === 'sticky');
  const ownerByStickyId = new Map(stickies.map((sticky) => (
    [sticky.id, ownerZone(sticky, items)?.id || null]
  )));
  let nextZIndex = items.reduce((max, item) => (
    Math.max(max, item.zIndex ?? item.createdAt ?? 0)
  ), 0) + 1;
  const entries = [];
  for (const zone of zones) {
    const children = stickies
      .filter((sticky) => ownerByStickyId.get(sticky.id) === zone.id)
      .sort((a, b) => (
        (votesByItem.get(b.id)?.size || 0) - (votesByItem.get(a.id)?.size || 0)
        || a.id.localeCompare(b.id)
      ));
    if (!children.length) continue;
    const colW = Math.max(...children.map((child) => child.w || STICKY_W));
    const rowH = Math.max(...children.map((child) => child.h || STICKY_H));
    const cols = Math.max(1, Math.floor((zone.w - PAD * 2 + GAP) / (colW + GAP)));
    const rowsNeeded = Math.ceil(children.length / cols);
    // Short zones keep overflowing: do not shrink cards or reduce header clearance.
    const headerClearancePx = zoneHeaderClearancePx(zone);
    const availH = Math.max(0, zone.h - headerClearancePx - PAD * 2);
    let rowStep = rowH + GAP;
    if (rowsNeeded > 1) rowStep = Math.min(rowStep, Math.max(1, (availH - rowH) / (rowsNeeded - 1)));
    children.forEach((sticky, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      entries.push({
        id: sticky.id,
        patch: {
          x: zone.x + PAD + col * (colW + GAP),
          y: zone.y + headerClearancePx + PAD + row * rowStep,
          zIndex: nextZIndex + children.length - index - 1,
        },
      });
    });
    nextZIndex += children.length;
  }
  const finalizedAt = root.voteTimer.endsAt || atTime;
  const captured = stickies.filter((sticky) => zoneIds.has(ownerByStickyId.get(sticky.id)));
  const voteResults = buildVoteResults(root, captured, votesByItem, participants, atTime);
  entries.push({ id: zoneId, patch: { voteTimer: null, lastResultsAt: finalizedAt, voteResults } });
  return { entries, finalizedAt, zoneIds, stickies, ownerByStickyId };
};

// The same plan is applied atomically by browser and relay finalizers.
export const planVoteFinalization = (items, votesByItem, zoneId, atTime, participants = [], allRevealed = false) => {
  const plan = buildFinalizationPlan(items, votesByItem, zoneId, atTime, participants);
  return plan && { ...plan, entries: protectedItemEntries(items, plan.entries, allRevealed) };
};
