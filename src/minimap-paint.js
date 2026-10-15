import { TOKENS } from './theme.js';

const TEXT_ALPHA = 0.72;
const CARD_ALPHA = 0.9;
const ZONE_MIN_SIZE_PX = 2;
const CARD_MIN_SIZE_PX = 3;
const ZONE_STROKE_WIDTH_PX = 1;
const ZONE_STROKE_INSET_PX = ZONE_STROKE_WIDTH_PX / 2;
const FALLBACK_PALETTE_INDEX = 3;

const itemFillColor = (item, palette, textColor, imageColor) => {
  if (item.type === 'zone') return palette.zoneBg;
  if (item.type === 'sticky') return palette.bg;
  return item.type === 'image' ? imageColor : textColor;
};

const paintMinimapItem = (ctx, item, colors, textColor, imageColor) => {
  const isZone = item.type === 'zone';
  const palette = colors[item.color] || colors[FALLBACK_PALETTE_INDEX];
  ctx.globalAlpha = item.type === 'text' ? TEXT_ALPHA : CARD_ALPHA;
  ctx.fillStyle = itemFillColor(item, palette, textColor, imageColor);
  const minSize = isZone ? ZONE_MIN_SIZE_PX : CARD_MIN_SIZE_PX;
  const width = Math.max(item.w, minSize);
  const height = Math.max(item.h, minSize);
  ctx.fillRect(item.x, item.y, width, height);
  if (isZone) {
    ctx.strokeStyle = palette.border;
    ctx.lineWidth = ZONE_STROKE_WIDTH_PX;
    ctx.strokeRect(item.x + ZONE_STROKE_INSET_PX, item.y + ZONE_STROKE_INSET_PX,
      Math.max(ZONE_STROKE_WIDTH_PX, width - ZONE_STROKE_WIDTH_PX),
      Math.max(ZONE_STROKE_WIDTH_PX, height - ZONE_STROKE_WIDTH_PX));
  }
};

export function paintMinimapItems(ctx, items, colors, textColor, imageColor = TOKENS.light['--minimap-image']) {
  // Preserve zones behind cards independently of the board's z-order.
  for (const zonesOnly of [true, false]) {
    for (const item of items) {
      if ((item.type === 'zone') !== zonesOnly) continue;
      paintMinimapItem(ctx, item, colors, textColor, imageColor);
    }
  }
  ctx.globalAlpha = 1;
}
