import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSafariGestures } from './safari-gestures.js';
import { wheelZoomFactor } from '../../domain/viewport-zoom.js';
class FixtureWheelEvent extends Event {
  constructor(type, options) { super(type, options); Object.assign(this, { deltaX: options.deltaX, deltaY: options.deltaY,
    ctrlKey: options.ctrlKey, clientX: options.clientX, clientY: options.clientY }); }
}
function fixture({ fine = true, wheelZoom = false } = {}) {
  const surface = new EventTarget(), view = new EventTarget(), wheels = [];
  Object.assign(view, { matchMedia: () => ({ matches: fine }), WheelEvent: FixtureWheelEvent });
  Object.assign(surface, { ownerDocument: { defaultView: view, elementFromPoint: () => surface }, getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }) });
  surface.addEventListener('wheel', event => wheels.push(event));
  const dispose = attachSafariGestures(surface, { wheelZoomEnabled: () => wheelZoom });
  const gesture = (type, scale, point = {}) => { const event = new Event(type, { cancelable: true }); Object.assign(event, { scale, ...point }); view.dispatchEvent(event); return event; };
  return { gesture, view, surface, wheels, dispose };
}
test('Safari cumulative scale becomes incremental wheel input in either wheel mode without changing pan behaviour', () => {
  for (const wheelZoom of [false, true]) {
    const f = fixture({ wheelZoom });
    try {
      assert.equal(f.gesture('gesturestart', 1).defaultPrevented, true);
      f.gesture('gesturechange', 1.2, { clientX: 200, clientY: 300 }); f.gesture('gesturechange', 1.5);
      f.gesture('gestureend', 1.5); assert.equal(f.wheels.length, 2);
      const factor = f.wheels.reduce((value, event) => value * wheelZoomFactor(event.deltaY, event.ctrlKey), 1);
      assert.ok(Math.abs(factor - 1.5) < 1e-10);
      assert.equal(f.wheels[0].clientX, 200); assert.equal(f.wheels[0].deltaX, 0);
      assert.equal(f.wheels[1].clientX, 410); assert.equal(f.wheels[1].clientY, 320);
      assert.equal(f.wheels[0].ctrlKey !== wheelZoom, true);
    } finally { f.dispose(); }
  }
});
test('touchscreen gestures, incomplete/invalid sequences, blur and disposed listeners never produce a second or nonfinite zoom', () => {
  const touch = fixture({ fine: false }); touch.gesture('gesturestart', 1); touch.gesture('gesturechange', 2); assert.equal(touch.wheels.length, 0); touch.dispose();
  const f = fixture();
  f.gesture('gesturechange', 2); f.gesture('gesturestart', 1); f.gesture('gesturechange', Infinity); f.gesture('gesturechange', 0);
  assert.equal(f.wheels.length, 0); f.view.dispatchEvent(new Event('blur')); f.gesture('gesturechange', 2); assert.equal(f.wheels.length, 0);
  f.dispose(); f.gesture('gesturestart', 1); f.gesture('gesturechange', 2); assert.equal(f.wheels.length, 0);
});

test('document-targeted Safari events use hit testing and controls never zoom the board',()=>{
  const f=fixture();
  const send=(type,scale)=>{const event=new Event(type,{cancelable:true});Object.defineProperties(event,{target:{value:{nodeType:9}},scale:{value:scale}});f.view.dispatchEvent(event);};
  try {
    send('gesturestart',1);send('gesturechange',1.25);assert.equal(f.wheels.length,1);send('gestureend',1.25);
    f.surface.contains=()=>true;
    const control={nodeType:1,closest:()=>({})},event=new Event('gesturestart',{cancelable:true});
    Object.defineProperties(event,{target:{value:control},scale:{value:1}});f.view.dispatchEvent(event);
    assert.equal(event.defaultPrevented,true);send('gesturechange',2);assert.equal(f.wheels.length,1);
  }
  finally{f.dispose();}
});
