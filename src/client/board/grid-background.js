import { GRID_PITCH_PX } from '../chrome/chrome-layout.js';
import { GRID_DOTS_MIN_ZOOM } from '../../domain/viewport-limits.js';

const GRID_DOT_RADIUS_PX = 1;
const GRID_DOTS_IMAGE = `radial-gradient(circle, var(--grid-dot) ${GRID_DOT_RADIUS_PX}px, transparent ${GRID_DOT_RADIUS_PX}px)`;

export function gridBackgroundForZoom(zoom) {
  if (zoom < GRID_DOTS_MIN_ZOOM) return { backgroundImage: 'none', backgroundSize: 'auto' };
  const pitchPx = GRID_PITCH_PX * zoom;
  return { backgroundImage: GRID_DOTS_IMAGE, backgroundSize: `${pitchPx}px ${pitchPx}px` };
}

// A live gesture scales the cached dot texture instead of re-rasterizing it
// every frame; drifting this far from the texture zoom re-textures once.
export const GRID_LIVE_SCALE_LIMIT = 2;
const PERCENT = 100;
const textureZooms = new WeakMap();

const positiveModulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

/**
 * Screen-space grid geometry. The layer starts one tile before the viewport and
 * spans GRID_LIVE_SCALE_LIMIT viewports plus a tile, so it still covers the
 * screen when a live gesture shrinks it by the full limit.
 */
export function gridLayout({ x, y, zoom }, textureZoom = zoom) {
  const scale = zoom / textureZoom;
  const pitchPx = GRID_PITCH_PX * zoom;
  return { texturePitchPx: GRID_PITCH_PX * textureZoom, scale,
    offsetX: positiveModulo(x, pitchPx) - pitchPx, offsetY: positiveModulo(y, pitchPx) - pitchPx };
}

export function gridStyleForViewport(viewport, textureZoom = viewport.zoom) {
  if (viewport.zoom < GRID_DOTS_MIN_ZOOM) {
    return { ...gridBackgroundForZoom(viewport.zoom), backgroundPosition: '0px 0px',
      inset: 0, width: 'auto', height: 'auto', transform: 'none', willChange: 'auto' };
  }
  const { texturePitchPx, scale, offsetX, offsetY } = gridLayout(viewport, textureZoom);
  const extentCss = `calc(${GRID_LIVE_SCALE_LIMIT * PERCENT}% + ${texturePitchPx}px)`;
  return { ...gridBackgroundForZoom(textureZoom), backgroundPosition: '0px 0px',
    inset: '0px auto auto 0px', width: extentCss, height: extentCss,
    transformOrigin: '0 0', willChange: 'transform',
    transform: `translate3d(${offsetX}px, ${offsetY}px, 0) scale(${scale})` };
}

// A texture cached while the dots were hidden has no dots to scale.
export function liveTextureZoom(previousTextureZoom, zoom) {
  if (!previousTextureZoom || previousTextureZoom < GRID_DOTS_MIN_ZOOM) return zoom;
  const scale = zoom / previousTextureZoom;
  return scale >= 1 / GRID_LIVE_SCALE_LIMIT && scale <= GRID_LIVE_SCALE_LIMIT ? previousTextureZoom : zoom;
}

export function paintGrid(grid, viewport, live) {
  const textureZoom = live ? liveTextureZoom(textureZooms.get(grid), viewport.zoom) : viewport.zoom;
  textureZooms.set(grid, textureZoom);
  Object.assign(grid.style, gridStyleForViewport(viewport, textureZoom));
}
