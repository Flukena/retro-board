export function paintMinimapItems(ctx, items, colors, textColor) {
  // Preserve zones behind cards independently of the board's z-order.
  for (const zonesOnly of [true, false]) {
    for (const item of items) {
      const isZone = item.type === 'zone';
      if (isZone !== zonesOnly) continue;
      const palette = colors[item.color] || colors[3];
      ctx.globalAlpha = item.type === 'text' ? 0.72 : 0.9;
      ctx.fillStyle = isZone ? palette.zoneBg
        : item.type === 'sticky' ? palette.bg
          : item.type === 'image' ? '#a78bfa' : textColor;
      const width = Math.max(item.w, isZone ? 2 : 3);
      const height = Math.max(item.h, isZone ? 2 : 3);
      ctx.fillRect(item.x, item.y, width, height);
      if (isZone) {
        ctx.strokeStyle = palette.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(item.x + 0.5, item.y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1));
      }
    }
  }
  ctx.globalAlpha = 1;
}
