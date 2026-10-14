import { GRID_PITCH_PX } from './chrome-layout.js';
import { GRID_DOTS_MIN_ZOOM } from './viewport-limits.js';

const GRID_DOT_RADIUS_PX = 1;
const GRID_DOTS_IMAGE = `radial-gradient(circle, var(--grid-dot) ${GRID_DOT_RADIUS_PX}px, transparent ${GRID_DOT_RADIUS_PX}px)`;

export function gridBackgroundForZoom(zoom) {
  if (zoom < GRID_DOTS_MIN_ZOOM) return { backgroundImage: 'none', backgroundSize: 'auto' };
  const pitchPx = GRID_PITCH_PX * zoom;
  return { backgroundImage: GRID_DOTS_IMAGE, backgroundSize: `${pitchPx}px ${pitchPx}px` };
}
