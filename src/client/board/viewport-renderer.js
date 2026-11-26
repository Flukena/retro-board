import { paintSelectionOverlay } from './selection-overlay.js';
import { paintGrid } from './grid-background.js';
import { paintPresenceZoom } from './presence-zoom.js';
import { minimapViewportRect } from '../../domain/minimap.js';
import { holdLiveLayer, releaseLiveLayer } from './live-layer-hint.js';
import { webkitCompositing as nativeGestureBrowser } from './webkit-compositing.js';

function worldTransform(viewport, nativeGestures) {
  // WebKit's forced 3D layer allocates a backing surface across the whole board.
  const translation = nativeGestures
    ? `translate(${viewport.x}px, ${viewport.y}px)`
    : `translate3d(${viewport.x}px, ${viewport.y}px, 0)`;
  return `${translation} scale(${viewport.zoom})`;
}

// While raster is held, the world and grid reuse their current raster. When
// input settles the world drops its hint and the grid re-textures at full detail.
function paintWorld(world, transform, viewport, holdRaster, grid) {
  world.style.transform = transform;
  if (!holdRaster) releaseLiveLayer(world);
  else holdLiveLayer(world, () => { if (grid) paintGrid(grid, viewport, false); });
}

export function paintViewport(viewport, { world, grid, cursorLayer, labelLayer, minimapViewport, minimapModel, selectionLayer }, { live = false } = {}) {
  // WebKit keeps its uncomposited world for the backing-memory reason above.
  const nativeGestures = nativeGestureBrowser((world ?? grid ?? cursorLayer)?.ownerDocument?.defaultView);
  const transform = worldTransform(viewport, nativeGestures);
  const holdRaster = live && !nativeGestures;
  if (world) paintWorld(world, transform, viewport, holdRaster, grid);
  if (grid) paintGrid(grid, viewport, holdRaster);
  if (cursorLayer) cursorLayer.style.transform = transform;
  paintPresenceZoom(viewport.zoom, cursorLayer, labelLayer);
  if (minimapViewport && minimapModel) {
    const view = minimapViewportRect(viewport, minimapModel.viewportSize, minimapModel);
    Object.assign(minimapViewport.style, { transform: `translate3d(${view.x}px, ${view.y}px, 0)`, width: `${view.w}px`, height: `${view.h}px` });
  }
  paintSelectionOverlay(viewport, selectionLayer);
}
