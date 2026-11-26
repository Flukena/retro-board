import { VIEWPORT_ZOOM_MIN } from '../../domain/viewport-limits.js';

const NORMAL_ZOOM = 1;
const OVERVIEW_LABEL_SCREEN_SCALE = 0.6;
const WORLD_SCALE_PROPERTY = '--rb-presence-world-scale';
const INVERSE_ZOOM_PROPERTY = '--rb-presence-inverse-zoom';

export const PRESENCE_LABEL_TRANSFORM = `scale(var(${WORLD_SCALE_PROPERTY}, 1))`;
export const PRESENCE_INVERSE_ZOOM = `var(${INVERSE_ZOOM_PROPERTY}, 1)`;

/** The parent supplies the board zoom. This local scale keeps names readable in the overview. */
export function presenceWorldScale(zoom) {
  const progress = (Math.min(zoom, NORMAL_ZOOM) - VIEWPORT_ZOOM_MIN) / (NORMAL_ZOOM - VIEWPORT_ZOOM_MIN);
  const screenScale = OVERVIEW_LABEL_SCREEN_SCALE + (1 - OVERVIEW_LABEL_SCREEN_SCALE) * progress;
  return screenScale / zoom;
}

export function paintPresenceZoom(zoom, cursorLayer, labelLayer) {
  const scale = String(presenceWorldScale(zoom));
  cursorLayer?.style.setProperty(WORLD_SCALE_PROPERTY, scale);
  labelLayer?.style.setProperty(WORLD_SCALE_PROPERTY, scale);
  labelLayer?.style.setProperty(INVERSE_ZOOM_PROPERTY, String(1 / zoom));
}
