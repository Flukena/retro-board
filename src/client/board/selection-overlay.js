import { sizeForPlacement } from '../../domain/board-geometry.js';
import { selectionToolbarAnchor, groupSelectionToolbarAnchor, selectionToolbarBounds } from './selection-toolbar-model.js';

const GROUP_KIND = 'group';
const HANDLE_SELECTOR = '[data-selection-corner]';
const BOUNDS_SELECTOR = '[data-selection-bounds]';
const TOOLBAR_SELECTOR = '.rb-selection-toolbar';
const CORNER_OFFSETS = Object.freeze({ nw: [0, 0], ne: [1, 0], sw: [0, 1], se: [1, 1] });

export function selectionLayerAttributes({ item, groupBBox, selectedCount, stackHeightPx, editing }) {
  const group = selectedCount > 1;
  const target = group ? groupBBox : item;
  if (editing || !target) return {};
  const { w, h } = group ? target : sizeForPlacement(target);
  return {
    'data-selection-kind': group ? GROUP_KIND : item.type,
    'data-selection-x': target.x, 'data-selection-y': target.y,
    'data-selection-w': w, 'data-selection-h': h,
    'data-selection-stack-px': stackHeightPx,
  };
}

export function cacheSelectionToolbarBounds(element, { anchorXPx, railRightPx, viewportWidthPx }) {
  const liveAnchorX = Number(element.dataset.selectionLiveAnchorXPx ?? anchorXPx);
  const boundsFor = toolbarWidthPx => selectionToolbarBounds({ anchorXPx: liveAnchorX, railRightPx, toolbarWidthPx, viewportWidthPx });
  element.style.setProperty('--rb-selection-max-width-px', `${boundsFor(element.getBoundingClientRect().width).maxWidth}px`);
  const width = element.getBoundingClientRect().width;
  Object.assign(element.dataset, { selectionToolbarWidthPx: String(width), selectionRailRightPx: String(railRightPx),
    selectionViewportWidthPx: String(viewportWidthPx), selectionToolbarMobile: 'false' });
  element.style.setProperty('--rb-selection-anchor-x-px', `${boundsFor(width).x}px`);
  element.dataset.toolbarOverflow = String(element.scrollWidth > element.clientWidth);
}

function paintToolbar(viewport, model, toolbar) {
  if (!toolbar || toolbar.dataset.selectionToolbarMobile === 'true') return;
  const anchor = model.type === GROUP_KIND
    ? groupSelectionToolbarAnchor(model, viewport, model.stackHeightPx)
    : selectionToolbarAnchor(model, viewport, model.stackHeightPx);
  const data = toolbar.dataset;
  const x = data.selectionToolbarWidthPx === undefined ? anchor.x : selectionToolbarBounds({ anchorXPx: anchor.x,
    railRightPx: Number(data.selectionRailRightPx), toolbarWidthPx: Number(data.selectionToolbarWidthPx),
    viewportWidthPx: Number(data.selectionViewportWidthPx) }).x;
  data.selectionLiveAnchorXPx = String(anchor.x);
  toolbar.style.setProperty('--rb-selection-anchor-x-px', `${x}px`);
  toolbar.style.setProperty('--rb-selection-anchor-y-px', `${anchor.y}px`);
}

export function paintSelectionOverlay(viewport, layer) {
  if (!layer?.dataset.selectionKind) return;
  const data = layer.dataset;
  const model = { type: data.selectionKind, x: Number(data.selectionX), y: Number(data.selectionY),
    w: Number(data.selectionW), h: Number(data.selectionH), stackHeightPx: Number(data.selectionStackPx) };
  const left = model.x * viewport.zoom + viewport.x, top = model.y * viewport.zoom + viewport.y;
  const width = model.w * viewport.zoom, height = model.h * viewport.zoom;
  for (const handle of layer.querySelectorAll(HANDLE_SELECTOR)) {
    const offset = CORNER_OFFSETS[handle.dataset.selectionCorner];
    if (offset) Object.assign(handle.style, { left: `${left + width * offset[0]}px`, top: `${top + height * offset[1]}px` });
  }
  const bounds = layer.querySelector(BOUNDS_SELECTOR);
  if (bounds) Object.assign(bounds.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  paintToolbar(viewport, model, layer.querySelector(TOOLBAR_SELECTOR));
}
