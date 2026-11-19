import { clampAspectScale, clampCornerResize } from './item-size-limits.js';
export function resizeGeometry(initial, corner, dx, dy, aspectLock, bounds) {
  if (aspectLock) {
    // Convert raw deltas into "growth" along each axis (positive = larger).
    // signX/signY map a corner's outward direction onto +growth.
    const signX = (corner === 'nw' || corner === 'sw') ? -1 : 1;
    const signY = (corner === 'nw' || corner === 'ne') ? -1 : 1;
    const sx = (initial.w + signX * dx) / initial.w;
    const sy = (initial.h + signY * dy) / initial.h;
    // Drive by whichever axis deviated more from 1.0 (proportional drag).
    const scale = clampAspectScale(Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy, initial, bounds);
    dx = signX * initial.w * (scale - 1);
    dy = signY * initial.h * (scale - 1);
  }
  let { x, y, w, h } = initial;
  if (corner === 'nw') {
    x = initial.x + dx; y = initial.y + dy; w = initial.w - dx; h = initial.h - dy;
  } else if (corner === 'ne') {
    y = initial.y + dy; w = initial.w + dx; h = initial.h - dy;
  } else if (corner === 'sw') {
    x = initial.x + dx; w = initial.w - dx; h = initial.h + dy;
  } else if (corner === 'se') {
    w = initial.w + dx; h = initial.h + dy;
  }
  return clampCornerResize(initial, corner, { x, y, w, h }, bounds);
}
