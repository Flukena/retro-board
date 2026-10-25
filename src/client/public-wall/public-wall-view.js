import { geometryErrorForItem, sizeForPlacement } from '../../domain/board-geometry.js';
import { PALETTE, paletteIndexByName } from '../ui/palette.js';
import { resolveOwnerZone } from '../../domain/board-ownership.js';
import { fitViewportToItems } from '../../domain/viewport-framing.js';
import { safeSnapshotAppearance } from '../../domain/item-appearance.js';
import { compareZOrder } from '../../domain/z-order.js';
import { canonicalPublicImageSource } from '../../domain/public-wall-image-source.js';
import { PUBLIC_ITEM_TYPES, PUBLIC_MAX_ITEMS, PUBLIC_TEXT_MAX_CHARACTERS,
  PUBLIC_SNAPSHOT_IMAGE_WIDTH_PX as PUBLIC_SCENE_WIDTH_PX,
  PUBLIC_SNAPSHOT_IMAGE_HEIGHT_PX as PUBLIC_SCENE_HEIGHT_PX } from '../../domain/public-wall-contract.js';

const EMPTY_EXTENT_PX = 1;
const DEFAULT_COLOR_INDEX = paletteIndexByName('yellow');
export { PUBLIC_SCENE_WIDTH_PX, PUBLIC_SCENE_HEIGHT_PX };
export function publicWallView(snapshot) {
  const candidates = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const items = candidates.slice(0, PUBLIC_MAX_ITEMS).filter(item => (
    PUBLIC_ITEM_TYPES.includes(item?.type) && !geometryErrorForItem(item)
      && (item.type !== 'image' || canonicalPublicImageSource(item.src))
  )).map(item => ({
    id: item.id, type: item.type, x: item.x, y: item.y, ...sizeForPlacement(item),
    ...safeSnapshotAppearance(item),
    ...(item.type === 'image' ? { src: canonicalPublicImageSource(item.src) } : {}),
    color: Number.isSafeInteger(item.color) && PALETTE[item.color] ? item.color : DEFAULT_COLOR_INDEX,
    text: typeof item.text === 'string' ? item.text.slice(0, PUBLIC_TEXT_MAX_CHARACTERS) : '',
  }));
  if (!items.length) return { items, x: 0, y: 0, w: EMPTY_EXTENT_PX, h: EMPTY_EXTENT_PX };
  const x = Math.min(...items.map(item => item.x));
  const y = Math.min(...items.map(item => item.y));
  return { items: items.sort(compareZOrder), x, y,
    w: Math.max(...items.map(item => item.x + item.w)) - x,
    h: Math.max(...items.map(item => item.y + item.h)) - y };
}

export function publicWallScene(snapshot) {
  const items = publicWallView(snapshot).items.map(item => item.type === 'zone' ? { ...item, title: item.text } : item);
  const zones = items.filter(item => item.type === 'zone');
  const childCounts = new Map(zones.map(zone => [zone.id, 0]));
  for (const item of items) {
    if (item.type === 'zone') continue;
    const owner = resolveOwnerZone(item, items);
    if (owner) childCounts.set(owner.id, childCounts.get(owner.id) + 1);
  }
  return { items, childCounts, width: PUBLIC_SCENE_WIDTH_PX, height: PUBLIC_SCENE_HEIGHT_PX,
    viewport: fitViewportToItems(zones.length ? zones : items, PUBLIC_SCENE_WIDTH_PX, PUBLIC_SCENE_HEIGHT_PX) };
}
