import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSafariGestures } from './safari-gestures.js';
import { DrawingController } from './DrawingController.js';
import { DrawingDraft } from '../../domain/freehand-drawing.js';
import { wheelZoomFactor } from '../../domain/viewport-zoom.js';
import { VIEWPORT_ZOOM_MAX } from '../../domain/viewport-limits.js';

class HostMouseEvent extends Event {
  constructor(type, options = {}) {
    super(type, options);
    Object.assign(this, { clientX: options.clientX, clientY: options.clientY, button: options.button, deltaX: options.deltaX, deltaY: options.deltaY, ctrlKey: options.ctrlKey });
  }
}
function fixture(extraOperations = {}) {
  const view = new EventTarget(), canvas = new EventTarget(), board = new EventTarget();
  const frames = new Map(), events = [];
  let frameId = 0, viewport = { x: 10, y: 20, zoom: 2 };
  Object.assign(view, { MouseEvent: HostMouseEvent, WheelEvent: HostMouseEvent,
    innerWidth: 800, innerHeight: 600, devicePixelRatio: 2,
    getComputedStyle: () => ({ getPropertyValue: () => '#112233' }),
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  Object.assign(canvas, { ownerDocument: { defaultView: view }, style: {},
    closest: () => canvas, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    getContext: () => ({ setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} }),
  });
  const draft = new DrawingDraft();
  const controller = new DrawingController(canvas, draft, {
    viewport: () => viewport, settings: () => ({ color: null, width: 4 }), canDraw: () => true, busy: () => false,
    changed: () => events.push('change'), limitReached: () => events.push('limit'), cancel: () => events.push('cancel'),
    stopFollowing: () => events.push('unfollow'), beginGesture: () => events.push('begin'), boardCanvas: () => board,
    applyViewport: next => { viewport = next; }, commitViewport: next => { viewport = next; events.push('commit'); },
    ...extraOperations,
  });
  const dispose = controller.attach();
  const mouse = (target, type, x, y, extras = {}) => target.dispatchEvent(new HostMouseEvent(type,
    { cancelable: true, button: 0, clientX: x, clientY: y, ...extras }));
  const touch = (target, type, id, x, y) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y });
    target.dispatchEvent(event);
  };
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  return { view, canvas, board, controller, draft, events, mouse, touch, flush, frames, dispose, viewport: () => viewport };
}

test('mouse drawing uses live world coordinates, screen brush width, draft history and bounded RAF cleanup', () => {
  const f = fixture();
  f.mouse(f.canvas, 'mousedown', 30, 60); f.mouse(f.view, 'mousemove', 50, 80); f.mouse(f.view, 'mouseup', 70, 100);
  assert.deepEqual(f.draft.strokes, [{ color: '#112233', width: 2, points: [{ x: 10, y: 20 }, { x: 20, y: 30 }, { x: 30, y: 40 }] }]);
  assert.equal(f.frames.size, 1, 'Pointer events coalesce into one pending frame');
  f.flush(); assert.equal(f.frames.size, 0);
  const undo = new Event('keydown', { cancelable: true }); Object.assign(undo, { key: 'z', metaKey: true });
  f.view.dispatchEvent(undo); assert.equal(f.draft.empty, true); assert.equal(undo.defaultPrevented, true);
  const redo = new Event('keydown', { cancelable: true }); Object.assign(redo, { key: 'Z', ctrlKey: true, shiftKey: true });
  f.view.dispatchEvent(redo); assert.equal(f.draft.strokes.length, 1);
  f.dispose(); assert.equal(f.frames.size, 0); assert.equal(f.canvas.width, 0);
  f.mouse(f.canvas, 'mousedown', 100, 100); assert.equal(f.draft.strokes.length, 1);
});

test('own native drawing surface accepts touch, cancels the first stroke on pinch and never resumes with the remaining finger', () => {
  const f = fixture();
  f.touch(f.canvas, 'pointerdown', 1, 100, 100); assert.equal(f.draft.empty, false);
  f.touch(f.canvas, 'pointerdown', 2, 200, 100); assert.equal(f.draft.empty, true);
  f.touch(f.view, 'pointermove', 2, 300, 100); f.flush(); assert.equal(f.viewport().zoom, VIEWPORT_ZOOM_MAX);
  f.touch(f.view, 'pointerup', 2, 300, 100); f.touch(f.view, 'pointermove', 1, 120, 110);
  f.touch(f.view, 'pointerup', 1, 120, 110);
  assert.equal(f.draft.empty, true); assert.equal(f.events.filter(event => event === 'commit').length, 1);
  f.dispose();
});

test('pan never creates a stroke and blur cancels only unfinished ink', () => {
  const f = fixture();
  f.mouse(f.canvas, 'mousedown', 30, 60); f.mouse(f.view, 'mouseup', 50, 80);
  f.mouse(f.canvas, 'mousedown', 100, 100, { button: 1 }); f.mouse(f.view, 'mouseup', 140, 150, { button: 1 });
  assert.deepEqual(f.viewport(), { x: 50, y: 70, zoom: 2 }); assert.equal(f.draft.strokes.length, 1);
  f.mouse(f.canvas, 'mousedown', 150, 150); f.view.dispatchEvent(new Event('blur'));
  assert.equal(f.draft.strokes.length, 1); f.dispose();
});

test('live preview publishes before mouseup and distinguishes committed ink from cancelled gestures', () => {
  const seen=[];const f=fixture({previewChanged:()=>seen.push(f.draft.strokes)});
  f.mouse(f.canvas,'mousedown',30,60);f.mouse(f.view,'mousemove',50,80);
  assert.ok(seen.length>=2,'Peers need a preview while the pointer is still down');
  assert.equal(seen.at(-1)[0].points.length,2);assert.equal(f.draft.completedStrokes.length,0);
  f.mouse(f.view,'mouseup',70,100);assert.equal(f.draft.completedStrokes.length,1);
  f.mouse(f.canvas,'mousedown',100,100);f.view.dispatchEvent(new Event('blur'));
  assert.equal(seen.at(-1).length,1,'Blur removes unfinished ink on peers too');f.dispose();
});

test('Safari native pinch over the drawing surface reaches the board wheel pipeline and schedules ink repaint',()=>{
  const f=fixture(),wheels=[];f.canvas.closest=selector=>selector==='.rb-drawing-canvas'?f.canvas:null;f.canvas.ownerDocument.elementFromPoint=()=>f.canvas;f.view.matchMedia=()=>({matches:true});
  const detach=attachSafariGestures({ownerDocument:f.canvas.ownerDocument,getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}),contains:()=>false});
  f.board.addEventListener('wheel',event=>wheels.push(event));
  try {
    for(const[type,scale]of [['gesturestart',1],['gesturechange',1.5],['gestureend',1.5]]){
      const event=new Event(type,{cancelable:true});Object.assign(event,{scale,clientX:300,clientY:400});f.view.dispatchEvent(event);
    }
    assert.equal(wheels.length,1);assert.ok(Math.abs(wheelZoomFactor(wheels[0].deltaY,wheels[0].ctrlKey)-1.5)<1e-10);assert.equal(f.frames.size,1);
  }finally{detach();f.dispose();}
});
