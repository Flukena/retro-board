import { zoomViewportAt } from '../../domain/viewport-framing.js';

const TOUCH_POINTER_TYPE = 'touch';
const PINCH_POINTER_COUNT = 2;
const MIDPOINT_DIVISOR = 2;
const MIN_PINCH_DISTANCE_PX = 1;
const PRIMARY_MOUSE_BUTTON = 0;
const PRIMARY_MOUSE_BUTTONS = 1;
const RELEASED_MOUSE_BUTTONS = 0;
const COMPATIBILITY_MOUSE_DELAY_MS = 800;
const NATIVE_CONTROL_SELECTOR = 'button, input, textarea, select, a, [contenteditable="true"], '
  + '[role="button"], [data-mobile-gesture="native"]';
const COMPATIBILITY_MOUSE_EVENTS = ['mousedown', 'mouseup', 'click', 'dblclick'];
const RESIZE_HANDLE_SELECTOR = '[data-mobile-resize="true"]';
const mobileGestureEvents = new WeakSet();

export const isMobileGestureEvent = (event) => mobileGestureEvents.has(event.nativeEvent ?? event);

const midpoint = ([first, second]) => ({
  x: (first.x + second.x) / MIDPOINT_DIVISOR,
  y: (first.y + second.y) / MIDPOINT_DIVISOR,
});

const distance = ([first, second]) => Math.max(MIN_PINCH_DISTANCE_PX,
  Math.hypot(second.x - first.x, second.y - first.y));

export const pinchViewport = (viewport, initialPoints, currentPoints) => {
  const initialCenter = midpoint(initialPoints);
  const currentCenter = midpoint(currentPoints);
  const zoomed = zoomViewportAt(viewport,
    viewport.zoom * distance(currentPoints) / distance(initialPoints), initialCenter);
  return { ...zoomed, x: zoomed.x + currentCenter.x - initialCenter.x,
    y: zoomed.y + currentCenter.y - initialCenter.y };
};

/**
 * The adapter owns touch lifecycle only. Its lower-layer interface delegates to
 * the board's existing interaction finalizers and viewport operations, preserving
 * their ownership checks, local optimism and undo transactions.
 *
 * @typedef {object} MobileGestureOperations
 * @property {() => {x:number, y:number, zoom:number}} getViewport
 * @property {() => void} beginGesture
 * @property {() => void} [endGesture] End the undo boundary after the final interaction commit.
 * @property {() => void} cancelGesture Finalize an existing mouse gesture without selecting on release.
 * @property {(viewport:{x:number, y:number, zoom:number}) => void} applyViewport
 * @property {(viewport:{x:number, y:number, zoom:number}) => void} commitViewport
 */
class MobileGestures {
  /** @param {HTMLElement} canvas @param {MobileGestureOperations} operations */
  constructor(surface, operations, canvas, nativeSurface) {
    this.surface = surface;
    this.nativeSurface = nativeSurface;
    this.canvas = canvas;
    this.operations = operations;
    this.view = canvas.ownerDocument.defaultView;
    this.pointers = new Map();
    this.mouseActive = false;
    this.gestureActive = false;
    this.pinch = null;
    this.pinchFrame = null;
    this.suppressUntil = 0;
    this.listeners = [];
  }

  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  attach() {
    const touchOptions = { passive: false, capture: true };
    this.listen(this.surface, 'pointerdown', (event) => this.down(event), touchOptions);
    this.listen(this.view, 'pointermove', (event) => this.move(event), touchOptions);
    this.listen(this.view, 'pointerup', (event) => this.up(event), touchOptions);
    this.listen(this.view, 'pointercancel', (event) => this.cancelPointer(event), touchOptions);
    this.listen(this.view, 'blur', () => this.cancel());
    for (const type of COMPATIBILITY_MOUSE_EVENTS) {
      this.listen(this.surface, type, (event) => this.suppressMouse(event), true);
    }
    return () => {
      this.cancel();
      this.listeners.forEach((remove) => remove());
      this.listeners = [];
    };
  }

  suppressMouse(event) {
    if (isMobileGestureEvent(event) || Date.now() > this.suppressUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  mouse(type, point, target = this.view) {
    const event = new this.view.MouseEvent(type, {
      bubbles: true, cancelable: true, view: this.view,
      clientX: point.clientX, clientY: point.clientY, button: PRIMARY_MOUSE_BUTTON,
      buttons: type === 'mouseup' ? RELEASED_MOUSE_BUTTONS : PRIMARY_MOUSE_BUTTONS,
    });
    mobileGestureEvents.add(event);
    target.dispatchEvent(event);
  }

  consume(event) {
    event.preventDefault();
    event.stopPropagation();
    this.suppressUntil = Date.now() + COMPATIBILITY_MOUSE_DELAY_MS;
  }

  down(event) {
    if (event.pointerType !== TOUCH_POINTER_TYPE) {
      this.suppressUntil = 0;
      return;
    }
    if (!this.handlesTarget(event.target)) {
      if (!this.pointers.size) this.suppressUntil = 0;
      return;
    }
    this.consume(event);
    this.pointers.set(event.pointerId, event);
    if (this.pointers.size === 1) {
      this.gestureActive = true;
      this.operations.beginGesture();
      this.mouseActive = true;
      this.mouse('mousedown', event, event.target);
    } else if (this.pointers.size === PINCH_POINTER_COUNT) {
      this.finishMouse();
      this.startPinch();
    }
  }

  handlesTarget(target) {
    if (target.closest?.(RESIZE_HANDLE_SELECTOR)) return true;
    const control = target.closest?.(NATIVE_CONTROL_SELECTOR);
    if (control && !(this.nativeSurface && control === this.surface)) return false;
    return this.surface === this.canvas || this.canvas.contains(target);
  }

  // The canvas rect is read once per pinch: reading it on every move after a
  // viewport write would force a synchronous layout for each finger event.
  startPinch() {
    const rect = this.canvas.getBoundingClientRect();
    this.pinch = { viewport: this.operations.getViewport(), rect, points: this.localPoints(rect) };
  }

  localPoints(rect) {
    return [...this.pointers.values()].slice(0, PINCH_POINTER_COUNT)
      .map((point) => ({ x: point.clientX - rect.left, y: point.clientY - rect.top }));
  }

  move(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.consume(event);
    this.pointers.set(event.pointerId, event);
    if (this.pinch) this.schedulePinchFrame();
    else if (this.mouseActive) this.mouse('mousemove', event);
  }

  // Both fingers report moves every frame; apply their latest positions once.
  // Callers flush before removing a pointer, so a frame never sees one finger.
  schedulePinchFrame() {
    if (this.pinchFrame !== null) return;
    this.pinchFrame = this.view.requestAnimationFrame(() => {
      this.pinchFrame = null;
      this.applyPinch();
    });
  }

  flushPinchFrame() {
    if (this.pinchFrame === null) return;
    this.view.cancelAnimationFrame(this.pinchFrame);
    this.pinchFrame = null;
    this.applyPinch();
  }

  applyPinch() {
    if (!this.pinch) return;
    const { viewport, points, rect } = this.pinch;
    this.operations.applyViewport(pinchViewport(viewport, points, this.localPoints(rect)));
  }

  up(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.move(event);
    this.flushPinchFrame();
    if (this.mouseActive) {
      this.mouse('mouseup', event);
      this.mouseActive = false;
    }
    this.pointers.delete(event.pointerId);
    this.finishPinch();
    this.finishGesture();
  }

  finishGesture() {
    if (!this.gestureActive || this.pointers.size) return;
    this.gestureActive = false;
    this.operations.endGesture?.();
  }

  finishMouse() {
    if (!this.mouseActive) return;
    this.mouseActive = false;
    this.operations.cancelGesture();
  }

  finishPinch() {
    if (!this.pinch) return;
    if (this.pointers.size >= PINCH_POINTER_COUNT) {
      this.startPinch();
      return;
    }
    this.pinch = null;
    this.operations.commitViewport(this.operations.getViewport());
  }

  cancelPointer(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.consume(event);
    this.cancel();
  }

  cancel() {
    this.finishMouse();
    this.flushPinchFrame();
    this.pointers.clear();
    this.finishPinch();
    this.finishGesture();
  }
}

/**
 * @param {HTMLElement} surface Event-delegation root, including external resize handles.
 * @param {MobileGestureOperations} operations
 * @param {{canvas?:HTMLElement}} options Canvas used for pinch coordinates and target filtering.
 */
export const attachMobileGestures = (surface, operations, { canvas = surface, nativeSurface = false } = {}) => (
  new MobileGestures(surface, operations, canvas, nativeSurface).attach()
);

const TOOL_SCROLL_DRAG_THRESHOLD_PX = 6;

export function createZoneToolScrollHandlers() {
  let gesture = null;
  let suppressClick = false;
  const end = (event) => {
    if (gesture?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gesture = null;
  };
  return {
    onPointerDown(event) {
      if (event.pointerType !== TOUCH_POINTER_TYPE || event.isPrimary === false) return;
      suppressClick = false;
      const element = event.currentTarget;
      gesture = { pointerId: event.pointerId, x: event.clientX, scrollLeft: element.scrollLeft,
        scale: element.getBoundingClientRect().width / element.clientWidth };
    },
    onPointerMove(event) {
      if (gesture?.pointerId !== event.pointerId) return;
      const deltaPx = event.clientX - gesture.x;
      if (!suppressClick && Math.abs(deltaPx) < TOOL_SCROLL_DRAG_THRESHOLD_PX) return;
      suppressClick = true;
      const element = event.currentTarget;
      if (!element.hasPointerCapture(event.pointerId)) element.setPointerCapture(event.pointerId);
      const maxScrollLeftPx = Math.max(0, element.scrollWidth - element.clientWidth);
      element.scrollLeft = Math.min(maxScrollLeftPx, Math.max(0, gesture.scrollLeft - deltaPx / gesture.scale));
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture(event) {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
