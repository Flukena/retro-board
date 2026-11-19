import { geometryErrorForItem } from './board-geometry.js';
import { DEFAULT_PALETTE_INDEX, isPaletteIndex } from './palette-index.js';

export const MAX_PREVIEW_ZONES = 24;

const previewZone = (item) => ({
  x: item.x,
  y: item.y,
  w: item.w,
  h: item.h,
  color: isPaletteIndex(item.color) ? item.color : DEFAULT_PALETTE_INDEX,
});

const byAreaThenInputOrder = (a, b) => (b.area - a.area) || (a.index - b.index);

// Geometry and colour only: titles, text and images never leave the board.
export const boardPreviewFromItems = (items) => {
  const candidates = [];
  let index = 0;
  for (const item of items) {
    if (item?.type === 'zone' && !geometryErrorForItem(item)) {
      candidates.push({ index, area: item.w * item.h, zone: previewZone(item) });
    }
    index += 1;
  }
  if (candidates.length === 0) return null;
  const zones = candidates
    .sort(byAreaThenInputOrder)
    .slice(0, MAX_PREVIEW_ZONES)
    .sort((a, b) => a.index - b.index)
    .map((candidate) => candidate.zone);
  return { zones };
};
