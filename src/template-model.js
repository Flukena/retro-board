import { effectiveOwnerZone } from './board-ownership.js';
import { sizeForPlacement } from './board-geometry.js';
import { IMPORT_COORDINATE_MAX_ABS } from './security-boundaries.js';
import { centerViewportOnWorld } from './minimap.js';

export const TEMPLATE_PLACEMENT_GAP_PX = 80;
export const TEMPLATE_PLACEMENT_MAX_RINGS = 8;
const CENTRE_DIVISOR = 2;

const reachesSelection = (zone, selected, owners) => {
  const visited = new Set();
  let current = zone;
  while (current && !visited.has(current.id) && visited.size < owners.size) {
    if (selected.has(current.id)) return true;
    visited.add(current.id);
    current = owners.get(current.id);
  }
  return false;
};

export const templateBounds = (zones) => {
  if (!zones.length) return null;
  const x = Math.min(...zones.map((zone) => zone.x));
  const y = Math.min(...zones.map((zone) => zone.y));
  return {
    x, y,
    w: Math.max(...zones.map((zone) => zone.x + zone.w)) - x,
    h: Math.max(...zones.map((zone) => zone.y + zone.h)) - y,
  };
};

export const templateThumbnail = (zones, boxW, boxH, paddingPx) => {
  const bounds = templateBounds(zones);
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return [];
  const availableW = boxW - paddingPx * CENTRE_DIVISOR;
  const availableH = boxH - paddingPx * CENTRE_DIVISOR;
  if (availableW <= 0 || availableH <= 0) return [];
  const scale = Math.min(availableW / bounds.w, availableH / bounds.h);
  const offsetX = (boxW - bounds.w * scale) / CENTRE_DIVISOR;
  const offsetY = (boxH - bounds.h * scale) / CENTRE_DIVISOR;
  return [...zones].sort((a, b) => b.w * b.h - a.w * a.h).map((zone) => ({
    x: offsetX + (zone.x - bounds.x) * scale,
    y: offsetY + (zone.y - bounds.y) * scale,
    w: zone.w * scale, h: zone.h * scale, color: zone.color,
  }));
};

export const templateZonesFromSelection = (items, selectedIds) => {
  const zones = items.filter((item) => item.type === 'zone');
  const selected = new Set(selectedIds);
  const owners = new Map(zones.map((zone) => [zone.id, effectiveOwnerZone(zone, items)]));
  const included = zones.filter((zone) => reachesSelection(zone, selected, owners));
  const bounds = templateBounds(included);
  if (!bounds) return [];
  return included.map((zone) => ({
    title: zone.title, color: zone.color,
    x: zone.x - bounds.x, y: zone.y - bounds.y, w: zone.w, h: zone.h,
  }));
};

export const templateOccupiedRects = (items) => items.map((item) => ({
  x: item.x, y: item.y, ...sizeForPlacement(item),
}));

const gridCandidates = (bounds, maxRings, gapPx) => {
  const candidates = [];
  const stepX = bounds.w + gapPx;
  const stepY = bounds.h + gapPx;
  for (let ring = 1; ring <= maxRings; ring += 1) {
    for (let x = -ring; x <= ring; x += 1) {
      for (let y = -ring; y <= ring; y += 1) {
        if (Math.max(Math.abs(x), Math.abs(y)) === ring) {
          candidates.push({ x: x * stepX, y: y * stepY });
        }
      }
    }
  }
  // Stable ties follow ring order, then x/y order. Sort all rings because a
  // tall template can have nearer horizontal candidates in a later ring.
  return candidates.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
};

const withinCoordinateLimit = (rect, limit) => (
  [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h]
    .every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= limit)
);

// Free means at least gapPx separation on either axis. Equality at the gap
// boundary is free; touching the occupied edge is free only when gapPx is zero.
const isFree = (rect, occupiedRects, gapPx) => occupiedRects.every((occupied) => (
  rect.x + rect.w + gapPx <= occupied.x || occupied.x + occupied.w + gapPx <= rect.x
  || rect.y + rect.h + gapPx <= occupied.y || occupied.y + occupied.h + gapPx <= rect.y
));

export const templatePlacementOffset = ({
  templateZones, viewportCenter, occupiedRects,
  gapPx = TEMPLATE_PLACEMENT_GAP_PX, maxRings = TEMPLATE_PLACEMENT_MAX_RINGS,
  coordinateLimit = IMPORT_COORDINATE_MAX_ABS,
}) => {
  const bounds = templateBounds(templateZones);
  if (!bounds) return null;
  const origin = {
    x: viewportCenter.x - bounds.w / CENTRE_DIVISOR,
    y: viewportCenter.y - bounds.h / CENTRE_DIVISOR,
  };
  const candidates = [{ x: 0, y: 0 }, ...gridCandidates(bounds, maxRings, gapPx)]
    .map((point) => ({ ...bounds, x: origin.x + point.x, y: origin.y + point.y }));
  const occupiedBounds = templateBounds(occupiedRects);
  if (occupiedBounds) candidates.push({
    ...bounds, x: occupiedBounds.x + occupiedBounds.w + gapPx, y: occupiedBounds.y,
  });
  const placed = candidates.find((rect) => (
    withinCoordinateLimit(rect, coordinateLimit) && isFree(rect, occupiedRects, gapPx)
  ));
  return placed ? { dx: placed.x - bounds.x, dy: placed.y - bounds.y } : null;
};

export const templateRevealViewport = ({ bounds, viewport, viewportSize }) => {
  const left = bounds.x * viewport.zoom + viewport.x;
  const top = bounds.y * viewport.zoom + viewport.y;
  if (left >= 0 && top >= 0
    && left + bounds.w * viewport.zoom <= viewportSize.w
    && top + bounds.h * viewport.zoom <= viewportSize.h) return null;
  return centerViewportOnWorld(viewport, viewportSize, {
    x: bounds.x + bounds.w / CENTRE_DIVISOR,
    y: bounds.y + bounds.h / CENTRE_DIVISOR,
  });
};
