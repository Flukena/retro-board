import { resolveOwnerZone } from './board-ownership.js';
import { sizeForPlacement } from './board-geometry.js';

const TEXT_SIZE_PX = sizeForPlacement({ type: 'text' });
const IMAGE_CREATION_MAX_WIDTH_PX = 480;

function withOwner(item, items) {
  item.parentZoneId = resolveOwnerZone(item, items)?.id ?? null;
  return item;
}

export function createStickyItem({ id, authorId, authorName, createdAt, wx, wy, size, enclosingZone, color, publicMode }) {
  const { w, h, fontSize } = size;
  const it = {
    id,
    type: 'sticky',
    x: wx - w / 2,
    y: wy - h / 2,
    w,
    h,
    authorId,
    authorName,
    createdAt,
    text: '',
    color,
    parentZoneId: enclosingZone?.id ?? null,
    private: !publicMode,
    ...(fontSize ? { fontSize } : {}),
  };
  return it;
}
export function createTextItem({ id, authorId, authorName, createdAt, wx, wy, text }, items) {
  const it = {
    id,
    type: 'text',
    x: wx,
    y: wy,
    w: TEXT_SIZE_PX.w,
    h: TEXT_SIZE_PX.h,
    authorId,
    authorName,
    createdAt,
    text,
  };
  return withOwner(it, items);
}
export function createZoneItem({ id, authorId, authorName, createdAt, x, y, w, h, title = 'Untitled', color = 0 }, items) {
  const it = {
    id,
    type: 'zone',
    x, y, w, h,
    title,
    color,
    authorId,
    authorName,
    createdAt,
  };
  return withOwner(it, items);
}
export function createImageItem({ id, authorId, authorName, createdAt, wx, wy, src, natW, natH }, items) {
  // Scale display size down if huge
  let dispW = natW;
  let dispH = natH;
  if (dispW > IMAGE_CREATION_MAX_WIDTH_PX) {
    const r = IMAGE_CREATION_MAX_WIDTH_PX / dispW;
    dispW = IMAGE_CREATION_MAX_WIDTH_PX;
    dispH = Math.round(natH * r);
  }
  const it = {
    id,
    type: 'image',
    x: wx - dispW / 2,
    y: wy - dispH / 2,
    w: dispW,
    h: dispH,
    natW,
    natH,
    src,
    authorId,
    authorName,
    createdAt,
  };
  return withOwner(it, items);
}
