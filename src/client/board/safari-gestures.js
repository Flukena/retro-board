import { wheelDeltaForZoomFactor } from '../../domain/viewport-zoom.js';

const NATIVE_GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'];
const EDITABLE_CONTROL_SELECTOR = 'button, input, textarea, select, a, [contenteditable="true"], [role="button"]';
const DRAWING_SURFACE_SELECTOR = '.rb-drawing-canvas';
const DEFAULT_GESTURE_SCALE = 1;
const ELEMENT_NODE_TYPE = 1;
const VIEW_CENTER_FRACTION = 0.5;
const finePointer = view => view.matchMedia?.('(pointer: fine)').matches === true;
const validScale = value => Number.isFinite(value) && value > 0;
function gesturePoint(event, surface) {
  const bounds = surface.getBoundingClientRect();
  return {
    x: Number.isFinite(event.clientX) ? event.clientX : bounds.left + bounds.width * VIEW_CENTER_FRACTION,
    y: Number.isFinite(event.clientY) ? event.clientY : bounds.top + bounds.height * VIEW_CENTER_FRACTION,
  };
}

function wheelSurface(surface, target) {
  if (!target || target.closest?.(EDITABLE_CONTROL_SELECTOR)) return null;
  const drawing = target.closest?.(DRAWING_SURFACE_SELECTOR);
  if (drawing) return drawing;
  return target === surface || surface.contains?.(target) ? surface : null;
}

// Safari desktop reports pinch scale separately from wheel scrolling. Route it
// through the existing wheel queue; the touchscreen pointer adapter stays owner
// on coarse-pointer devices, preventing a second pinch update there.
export function attachSafariGestures(surface, { wheelZoomEnabled = () => false } = {}) {
  if (!surface) return () => {};
  const view = surface.ownerDocument.defaultView;
  let previousScale = null, wheelTarget = null;
  const start = event => {
    event.preventDefault(); previousScale = null; wheelTarget = null;
    if (!finePointer(view)) return;
    const point = gesturePoint(event, surface), document = surface.ownerDocument;
    const direct = event.target?.nodeType === ELEMENT_NODE_TYPE && event.target !== document.body && event.target !== document.documentElement;
    const target = direct ? event.target : document.elementFromPoint?.(point.x, point.y);
    wheelTarget = wheelSurface(surface, target);
    if (wheelTarget) previousScale = validScale(event.scale) ? event.scale : DEFAULT_GESTURE_SCALE;
  };
  const change = event => {
    event.preventDefault();
    if (previousScale === null) return;
    if (!validScale(event.scale)) return;
    const factor = event.scale / previousScale; previousScale = event.scale;
    if (factor === DEFAULT_GESTURE_SCALE) return;
    const pinch = !wheelZoomEnabled(), point = gesturePoint(event, surface);
    wheelTarget.dispatchEvent(new view.WheelEvent('wheel', { bubbles: true, cancelable: true,
      deltaX: 0, deltaY: wheelDeltaForZoomFactor(factor, pinch), ctrlKey: pinch,
      clientX: point.x, clientY: point.y }));
  };
  const end = event => { event.preventDefault(); previousScale = null; wheelTarget = null; };
  const blur = () => { previousScale = null; wheelTarget = null; };
  const handlers = [start, change, end];
  NATIVE_GESTURE_EVENTS.forEach((type, index) => view.addEventListener(type, handlers[index], { passive: false }));
  view.addEventListener('blur', blur);
  return () => {
    NATIVE_GESTURE_EVENTS.forEach((type, index) => view.removeEventListener(type, handlers[index]));
    view.removeEventListener('blur', blur); previousScale = null; wheelTarget = null;
  };
}
