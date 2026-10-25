import { VIEWPORT_ZOOM_MAX } from '../../domain/viewport-limits.js';

export const MOBILE_EDITOR_VISIBILITY_EVENT = 'rb:mobile-editor-visibility';
export const MOBILE_EDITOR_CLEARANCE_PX = 12;
// A card narrower than this on screen is zoomed in when editing starts.
export const MOBILE_EDITOR_MIN_READABLE_WIDTH_PX = 200;
// Share of the free width the card should fill after zooming in.
const MOBILE_EDITOR_FOCUS_WIDTH_SHARE = 0.85;
const CLEARANCE_SIDES = 2;
const CENTER_DIVISOR = 2;

export function editorContentOverflowPx(node) {
  const viewportBounded = node.dataset.mobileHeightBounded === 'true' || node.dataset.mobileWidthBounded === 'true';
  return viewportBounded ? 0 : node.scrollHeight - node.clientHeight;
}

function axisPanDelta(start, end, visibleStart, visibleEnd) {
  if (end - start > visibleEnd - visibleStart || start < visibleStart) return visibleStart - start;
  return end > visibleEnd ? visibleEnd - end : 0;
}

export function mobileEditorPanDelta(editor, viewport, insets = {}) {
  const left = viewport.left + (insets.left ?? 0) + MOBILE_EDITOR_CLEARANCE_PX;
  const top = viewport.top + (insets.top ?? 0) + MOBILE_EDITOR_CLEARANCE_PX;
  const right = Math.max(left, viewport.right - (insets.right ?? 0) - MOBILE_EDITOR_CLEARANCE_PX);
  const bottom = Math.max(top, viewport.bottom - (insets.bottom ?? 0) - MOBILE_EDITOR_CLEARANCE_PX);
  return {
    x: axisPanDelta(editor.left, editor.right, left, right),
    y: axisPanDelta(editor.top, editor.bottom, top, bottom),
  };
}

const scaleAbout = (value, anchor, scale) => anchor + (value - anchor) * scale;

/**
 * Viewport that zooms a too-small card up to a readable width, or (with `fitWide`)
 * a card wider than the free area back down to fit, and pans it into the free area.
 * Returns null when the card already fits readably or zoom cannot change.
 * `origin` is the canvas element's client position.
 */
export function mobileEditorFocusViewport({ editor, visible, insets, viewport, origin, fitWide = false }) {
  const width = editor.right - editor.left;
  const freeWidth = visible.width - (insets.left ?? 0) - (insets.right ?? 0) - MOBILE_EDITOR_CLEARANCE_PX * CLEARANCE_SIDES;
  const tooSmall = width < MOBILE_EDITOR_MIN_READABLE_WIDTH_PX;
  if (width <= 0 || (!tooSmall && (!fitWide || width <= freeWidth))) return null;
  const scale = Math.min(freeWidth * MOBILE_EDITOR_FOCUS_WIDTH_SHARE / width, VIEWPORT_ZOOM_MAX / viewport.zoom);
  if (tooSmall && scale <= 1) return null;
  const anchor = { x: (editor.left + editor.right) / CENTER_DIVISOR, y: (editor.top + editor.bottom) / CENTER_DIVISOR };
  const zoomed = {
    left: scaleAbout(editor.left, anchor.x, scale), right: scaleAbout(editor.right, anchor.x, scale),
    top: scaleAbout(editor.top, anchor.y, scale), bottom: scaleAbout(editor.bottom, anchor.y, scale),
  };
  const pan = mobileEditorPanDelta(zoomed, visible, insets);
  return {
    zoom: viewport.zoom * scale,
    x: scaleAbout(viewport.x, anchor.x - origin.left, scale) + pan.x,
    y: scaleAbout(viewport.y, anchor.y - origin.top, scale) + pan.y,
  };
}
