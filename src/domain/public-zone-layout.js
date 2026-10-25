import { BOARD_MODE } from './public-wall-contract.js';
import { geometryErrorForBoard, sizeForPlacement } from './board-geometry.js';

export const ZONE_MIN_WIDTH_PX = 240;
export const ZONE_MIN_HEIGHT_PX = 200;
export const PUBLIC_ZONE_LAYOUT_SCALE_FACTOR = 2;
const CENTER_DIVISOR = 2;

export function publicZoneCreationSize(mode, widthPx, heightPx) {
  const minimum = mode === BOARD_MODE.PUBLIC
    ? sizeForPlacement({ type: 'zone' }) : { w: ZONE_MIN_WIDTH_PX, h: ZONE_MIN_HEIGHT_PX };
  return { w: Math.max(minimum.w, widthPx), h: Math.max(minimum.h, heightPx) };
}

export function enlargedZoneGeometry(zone, origin = { x: 0, y: 0 }) {
  return {
    x: origin.x + (zone.x - origin.x) * PUBLIC_ZONE_LAYOUT_SCALE_FACTOR,
    y: origin.y + (zone.y - origin.y) * PUBLIC_ZONE_LAYOUT_SCALE_FACTOR,
    w: zone.w * PUBLIC_ZONE_LAYOUT_SCALE_FACTOR,
    h: zone.h * PUBLIC_ZONE_LAYOUT_SCALE_FACTOR,
  };
}

function enlargedCardPosition(item, origin) {
  const { w, h } = sizeForPlacement(item);
  return {
    x: origin.x + (item.x + w / CENTER_DIVISOR - origin.x) * PUBLIC_ZONE_LAYOUT_SCALE_FACTOR - w / CENTER_DIVISOR,
    y: origin.y + (item.y + h / CENTER_DIVISOR - origin.y) * PUBLIC_ZONE_LAYOUT_SCALE_FACTOR - h / CENTER_DIVISOR,
  };
}

export function enlargedZoneLayoutEntries(items) {
  const zones = items.filter(item => item.type === 'zone');
  if (!zones.length) return [];
  const origin = { x: Math.min(...zones.map(zone => zone.x)), y: Math.min(...zones.map(zone => zone.y)) };
  const entries = items.map(item => ({ id: item.id, patch: item.type === 'zone'
    ? enlargedZoneGeometry(item, origin) : enlargedCardPosition(item, origin) }));
  const nextItems = items.map((item, index) => ({ ...item, ...entries[index].patch }));
  const error = geometryErrorForBoard(nextItems);
  if (error) throw new Error(error);
  return entries;
}
