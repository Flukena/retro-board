import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMobileGestures, isMobileGestureEvent, pinchViewport, createZoneToolScrollHandlers } from './mobile-gestures.js';
import { VIEWPORT_ZOOM_MAX } from '../../domain/viewport-limits.js';
import { Doc, UndoManager } from 'yjs';

class TestMouseEvent extends Event {
  constructor(type, options) {
    super(type, options);
    Object.assign(this, { clientX: options.clientX, clientY: options.clientY,
      button: options.button, buttons: options.buttons });
  }
}

const pointer = (type, id, x, y, target, pointerType = 'touch') => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: id, clientX: x, clientY: y, pointerType });
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
};

const fixture = (boundaries = {}) => {
  const view = new EventTarget();
  view.MouseEvent = TestMouseEvent;
  const frames = new Map();
  let nextFrameId = 1;
  view.requestAnimationFrame = (callback) => { frames.set(nextFrameId, callback); return nextFrameId++; };
  view.cancelAnimationFrame = (id) => frames.delete(id);
  const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()); };
  const canvas = new EventTarget();
  canvas.ownerDocument = { defaultView: view };
  let rectReads = 0;
  canvas.getBoundingClientRect = () => { rectReads += 1; return { left: 20, top: 30 }; };
  canvas.closest = () => null;
  const events = [];
  let viewport = { x: 0, y: 0, zoom: 1 };
  const dispose = attachMobileGestures(canvas, {
    getViewport: () => viewport,
    beginGesture: () => { events.push('begin'); boundaries.begin?.(); },
    endGesture: () => { events.push('end'); boundaries.end?.(); },
    cancelGesture: () => events.push('cancel'),
    applyViewport: (next) => { viewport = next; events.push('apply'); },
    commitViewport: (next) => { viewport = next; events.push('commit'); },
  });
  canvas.addEventListener('mousedown', (event) => events.push(['down', event.clientX]));
  view.addEventListener('mousemove', (event) => events.push(['move', event.clientX]));
  view.addEventListener('mouseup', () => events.push('up'));
  const down = (id, x, y, target = canvas) => canvas.dispatchEvent(pointer('pointerdown', id, x, y, target));
  const move = (id, x, y) => view.dispatchEvent(pointer('pointermove', id, x, y));
  const up = (id, x, y) => view.dispatchEvent(pointer('pointerup', id, x, y));
  return { canvas, view, events, down, move, up, dispose, frame, viewport: () => viewport,
    pendingFrames: () => frames.size, rectReads: () => rectReads };
};

test('pinch keeps the initial world anchor under the moving midpoint', () => {
  const result = pinchViewport({ x: 10, y: 20, zoom: 1 },
    [{ x: 80, y: 100 }, { x: 120, y: 100 }],
    [{ x: 80, y: 130 }, { x: 160, y: 130 }]);
  assert.deepEqual(result, { x: -60, y: -30, zoom: 2 });
});

test('pinch clamps zoom while retaining the world anchor; coincident touches stay finite', () => {
  const result = pinchViewport({ x: 0, y: 0, zoom: 1 },
    [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    [{ x: 0, y: 0 }, { x: 1000, y: 0 }]);
  assert.equal(result.zoom, VIEWPORT_ZOOM_MAX);
  assert.equal((500 - result.x) / result.zoom, 0.5);
  const coincident = [{ x: 4, y: 5 }, { x: 4, y: 5 }];
  assert.deepEqual(pinchViewport({ x: 0, y: 0, zoom: 1 }, coincident, coincident),
    { x: 0, y: 0, zoom: 1 });
});

test('single finger reuses mouse down, movement and final release exactly once', () => {
  const f = fixture();
  f.down(1, 100, 110);
  f.move(1, 150, 160);
  f.up(1, 150, 160);
  assert.deepEqual(f.events, ['begin', ['down', 100], ['move', 150], ['move', 150], 'up', 'end']);
  f.dispose();
});

test('second touch ends the single gesture, pinches and never restarts a drag with remaining finger', () => {
  const f = fixture();
  f.down(1, 100, 130);
  f.down(2, 200, 130);
  f.move(2, 300, 130);
  f.frame();
  assert.deepEqual(f.viewport(), { x: -80, y: -100, zoom: 2 });
  f.up(2, 300, 130);
  f.move(1, 140, 130);
  f.up(1, 140, 130);
  assert.equal(f.events.filter((event) => event === 'cancel').length, 1);
  assert.equal(f.events.filter((event) => event === 'commit').length, 1);
  assert.equal(f.events.filter((event) => Array.isArray(event) && event[0] === 'down').length, 1);
  f.dispose();
});

test('pinch applies the latest finger positions once per frame without re-reading layout', () => {
  const f = fixture();
  f.down(1, 100, 130);
  f.down(2, 200, 130);
  const readsAtPinchStart = f.rectReads();
  f.move(1, 90, 130);
  f.move(2, 260, 130);
  f.move(2, 300, 130);
  f.move(1, 100, 130);
  assert.equal(f.events.filter((event) => event === 'apply').length, 0, 'Moves wait for the next frame');
  f.frame();
  assert.equal(f.events.filter((event) => event === 'apply').length, 1);
  assert.deepEqual(f.viewport(), { x: -80, y: -100, zoom: 2 });
  assert.equal(f.rectReads(), readsAtPinchStart, 'Finger moves reuse the rect read at pinch start');
  f.dispose();
});

test('releasing a finger before the next frame commits the latest pinch position', () => {
  const f = fixture();
  f.down(1, 100, 130);
  f.down(2, 200, 130);
  f.move(2, 300, 130);
  f.up(2, 300, 130);
  assert.deepEqual(f.viewport(), { x: -80, y: -100, zoom: 2 });
  assert.equal(f.events.filter((event) => event === 'commit').length, 1);
  assert.equal(f.pendingFrames(), 0, 'No stale frame can apply after the commit');
  f.dispose();
});

test('pointer cancellation and teardown finalize active interactions without a click', () => {
  const f = fixture();
  f.down(1, 100, 100);
  f.view.dispatchEvent(pointer('pointercancel', 1, 100, 100));
  assert.deepEqual(f.events, ['begin', ['down', 100], 'cancel', 'end']);
  f.down(2, 100, 100);
  f.dispose();
  f.move(2, 200, 200);
  assert.equal(f.events.filter((event) => event === 'cancel').length, 2);
  assert.equal(f.events.includes('up'), false);
});

test('native mouse, pen and editable controls retain their native events', () => {
  const f = fixture();
  f.canvas.dispatchEvent(pointer('pointerdown', 1, 10, 10, f.canvas, 'mouse'));
  f.canvas.dispatchEvent(pointer('pointerdown', 2, 10, 10, f.canvas, 'pen'));
  f.down(3, 10, 10, { closest: (selector) => selector.includes('button') ? { tagName: 'BUTTON' } : null });
  assert.deepEqual(f.events, []);
  f.dispose();
});

test('compatibility mouse events are suppressed after touch but bridge events pass', () => {
  const f = fixture();
  f.down(1, 100, 100);
  f.up(1, 100, 100);
  const compatibility = new TestMouseEvent('mousedown', { cancelable: true, clientX: 100 });
  f.canvas.dispatchEvent(compatibility);
  assert.equal(compatibility.defaultPrevented, true);
  assert.equal(f.events.filter((event) => Array.isArray(event) && event[0] === 'down').length, 1);
  f.dispose();
});

test('lifting one of three fingers rebases the remaining pinch without a viewport jump', () => {
  const f = fixture();
  f.down(1, 100, 130);
  f.down(2, 200, 130);
  f.down(3, 300, 130);
  f.up(1, 100, 130);
  f.move(3, 300, 130);
  f.frame();
  assert.deepEqual(f.viewport(), { x: 0, y: 0, zoom: 1 });
  f.dispose();
});

test('a delegation root accepts marked external resize handles and leaves toolbar controls alone', () => {
  const root = new EventTarget();
  const view = new EventTarget();
  view.MouseEvent = TestMouseEvent;
  const canvas = { ownerDocument: { defaultView: view }, contains: () => false };
  const resize = new EventTarget();
  resize.closest = (selector) => selector.includes('data-mobile-resize') ? resize : null;
  const toolbar = new EventTarget();
  toolbar.closest = () => null;
  let starts = 0;
  let resizes = 0;
  resize.addEventListener('mousedown', () => { resizes += 1; });
  const dispose = attachMobileGestures(root, {
    beginGesture: () => { starts += 1; }, cancelGesture: () => {},
  }, { canvas });
  root.dispatchEvent(pointer('pointerdown', 1, 10, 10, toolbar));
  assert.equal(starts, 0);
  root.dispatchEvent(pointer('pointerdown', 2, 10, 10, resize));
  assert.equal(starts, 1);
  assert.equal(resizes, 1);
  dispose();
});

test('only adapter mouse events identify touch origin, including React nativeEvent wrappers', () => {
  const f = fixture();
  const origins = [];
  f.canvas.addEventListener('mousedown', (event) => {
    origins.push(isMobileGestureEvent(event), isMobileGestureEvent({ nativeEvent: event }));
  });
  f.down(1, 100, 100);
  assert.deepEqual(origins, [true, true]);
  assert.equal(isMobileGestureEvent(new TestMouseEvent('mousedown', {})), false);
  assert.equal(isMobileGestureEvent(pointer('pointerdown', 2, 0, 0, f.canvas, 'mouse')), false);
  assert.equal(isMobileGestureEvent(pointer('pointerdown', 3, 0, 0, f.canvas, 'pen')), false);
  assert.equal(isMobileGestureEvent({ nativeEvent: new TestMouseEvent('mousedown', {}) }), false);
  f.dispose();
});

test('gesture boundaries keep rapid drag, resize and subsequent edits in separate undo steps', () => {
  const doc = new Doc();
  const cards = doc.getMap('cards');
  const undo = new UndoManager(cards);
  const f = fixture({ begin: () => undo.stopCapturing(), end: () => undo.stopCapturing() });
  cards.set('card', { x: 0, width: 100 });
  let patch = { x: 20 };
  f.view.addEventListener('mousemove', () => cards.set('card', { ...cards.get('card'), ...patch }));
  f.down(1, 100, 100);
  f.move(1, 120, 100);
  f.up(1, 120, 100);
  patch = { width: 140 };
  f.down(2, 120, 100);
  f.move(2, 160, 100);
  f.up(2, 160, 100);
  cards.set('another-card', { x: 40, width: 100 });
  undo.undo();
  assert.equal(cards.has('another-card'), false);
  assert.deepEqual(cards.get('card'), { x: 20, width: 140 });
  undo.undo();
  assert.deepEqual(cards.get('card'), { x: 20, width: 100 });
  undo.undo();
  assert.deepEqual(cards.get('card'), { x: 0, width: 100 });
  undo.undo();
  assert.equal(cards.has('card'), false);
  f.dispose();
  undo.destroy();
  doc.destroy();
});

test('a pinch transition remains one gesture until every finger is released', () => {
  const f = fixture();
  f.down(1, 100, 100);
  f.down(2, 200, 100);
  f.down(3, 300, 100);
  f.up(3, 300, 100);
  f.up(2, 200, 100);
  assert.equal(f.events.filter((event) => event === 'end').length, 0);
  f.up(1, 100, 100);
  assert.equal(f.events.filter((event) => event === 'begin').length, 1);
  assert.equal(f.events.filter((event) => event === 'end').length, 1);
  assert.equal(f.events.at(-1), 'end');
  f.dispose();
  assert.equal(f.events.filter((event) => event === 'end').length, 1);
});

test('cancellation, blur and detach each close an active boundary once after finalizing', () => {
  for (const ending of ['cancel', 'blur', 'detach']) {
    const f = fixture();
    f.down(1, 100, 100);
    if (ending === 'cancel') f.view.dispatchEvent(pointer('pointercancel', 1, 100, 100));
    else if (ending === 'blur') f.view.dispatchEvent(new Event('blur'));
    else f.dispose();
    f.up(1, 100, 100);
    f.view.dispatchEvent(new Event('blur'));
    f.dispose();
    assert.deepEqual(f.events, ['begin', ['down', 100], 'cancel', 'end'], ending);
  }
});

test('cancelling a pinch commits its viewport before ending the shared gesture boundary', () => {
  const f = fixture();
  f.down(1, 100, 100);
  f.down(2, 200, 100);
  f.move(2, 240, 100);
  f.view.dispatchEvent(pointer('pointercancel', 2, 240, 100));
  f.up(1, 100, 100);
  f.dispose();
  assert.deepEqual(f.events.slice(-2), ['commit', 'end']);
  assert.equal(f.events.filter((event) => event === 'begin').length, 1);
  assert.equal(f.events.filter((event) => event === 'end').length, 1);
});


test('zone tool swipe follows world scale, stays bounded and leaves ordinary taps intact', () => {
  const captured = new Set();
  const element = { scrollLeft: 40, clientWidth: 100, scrollWidth: 400,
    getBoundingClientRect: () => ({ width: 50 }),
    hasPointerCapture: (id) => captured.has(id), setPointerCapture: (id) => captured.add(id),
    releasePointerCapture: (id) => captured.delete(id) };
  let prevented = 0;
  const event = (clientX, extras = {}) => ({ pointerType: 'touch', isPrimary: true, pointerId: 1,
    clientX, currentTarget: element, preventDefault: () => prevented++, stopPropagation() {}, ...extras });
  const handlers = createZoneToolScrollHandlers();
  handlers.onPointerDown(event(100));
  handlers.onPointerMove(event(97));
  assert.equal(element.scrollLeft, 40);
  handlers.onPointerMove(event(80));
  assert.equal(element.scrollLeft, 80);
  assert.ok(captured.has(1));
  handlers.onPointerMove(event(-1000));
  assert.equal(element.scrollLeft, 300);
  handlers.onPointerMove(event(1000));
  assert.equal(element.scrollLeft, 0);
  handlers.onPointerUp(event(1000));
  assert.equal(captured.size, 0);
  const beforeClick = prevented;
  handlers.onClickCapture(event(1000));
  assert.equal(prevented, beforeClick + 1);
  handlers.onPointerDown(event(100));
  handlers.onPointerUp(event(100));
  handlers.onClickCapture(event(100));
  assert.equal(prevented, beforeClick + 1, 'A fresh tap must still reach its tool');
  handlers.onPointerDown(event(100, { pointerType: 'mouse' }));
  handlers.onPointerMove(event(80));
  assert.equal(element.scrollLeft, 0);
});
