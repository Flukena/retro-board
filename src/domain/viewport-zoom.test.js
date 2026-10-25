import test from 'node:test';
import assert from 'node:assert/strict';
import { wheelDeltaForZoomFactor, wheelZoomFactor, viewportNeedsCullRefresh } from './viewport-zoom.js';

test('tiny trackpad deltas produce tiny zoom changes instead of full wheel steps', () => {
  assert.ok(wheelZoomFactor(1, true) > 0.98);
  assert.ok(wheelZoomFactor(-1, true) < 1.02);
  assert.ok(wheelZoomFactor(0.1, true) > wheelZoomFactor(1, true));
});

test('zoom distance is independent of the number of wheel events', () => {
  for (const pinch of [false, true]) {
    const split = Array.from({ length: 20 }, () => wheelZoomFactor(1, pinch)).reduce((a, b) => a * b, 1);
    assert.ok(Math.abs(split - wheelZoomFactor(20, pinch)) < 1e-12);
    assert.ok(Math.abs(wheelZoomFactor(20, pinch) * wheelZoomFactor(-20, pinch) - 1) < 1e-12);
  }
});

test('wheel notches zoom less aggressively than a pinch of the same pixel distance', () => {
  assert.ok(wheelZoomFactor(100, false) > 0.8);
  assert.ok(wheelZoomFactor(100, false) > wheelZoomFactor(100, true));
  assert.equal(wheelZoomFactor(0, true), 1);
  assert.equal(wheelZoomFactor(NaN, true), 1);
  assert.ok(Number.isFinite(wheelZoomFactor(-1e9, true)));
});


test('zoom inside loaded overscan keeps the existing cards mounted', () => {
  const rendered = {x:250,y:180,zoom:.55};
  const center = {x:640,y:360};
  const world = {x:(center.x-rendered.x)/rendered.zoom,y:(center.y-rendered.y)/rendered.zoom};
  const zoom = .45;
  const next = {x:center.x-world.x*zoom,y:center.y-world.y*zoom,zoom};
  assert.equal(viewportNeedsCullRefresh(rendered,next,{w:1280,h:720}),false);
  assert.equal(viewportNeedsCullRefresh(rendered,{...next,zoom:.2},{w:1280,h:720}),true);
});

test('pan refreshes before reaching uncovered space, including low zoom and snapped positions', () => {
  const size = {w:1280,h:720};
  for (const zoom of [.05,.15,.35,1,3]) {
    const rendered = {x:199,y:199,zoom};
    assert.equal(viewportNeedsCullRefresh(rendered,rendered,size),false);
    assert.equal(viewportNeedsCullRefresh(rendered,{...rendered,x:rendered.x-800},size),true);
    assert.equal(viewportNeedsCullRefresh(rendered,{...rendered,y:rendered.y+800},size),true);
  }
});

test('fully rendered boards need no culling refresh during a gesture', () => {
  const rendered = { x: 0, y: 0, zoom: 0.12 };
  const next = { x: -800, y: -800, zoom: 0.06 };
  assert.equal(viewportNeedsCullRefresh(rendered, next, { w: 390, h: 844 }, true), false);
  assert.equal(viewportNeedsCullRefresh(rendered, next, { w: 390, h: 844 }, false), true);
});

test('native pinch factors round-trip through either wheel mode and invalid factors are inert',()=>{
  for(const pinch of [false,true])for(const factor of [0.5,1,1.5,3])assert.ok(Math.abs(wheelZoomFactor(wheelDeltaForZoomFactor(factor,pinch),pinch)-factor)<1e-10);
  for(const invalid of [0,-1,NaN,Infinity])assert.equal(wheelDeltaForZoomFactor(invalid),0);
});
