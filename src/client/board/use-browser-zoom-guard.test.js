import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBrowserZoomGuard } from './use-browser-zoom-guard.js';
import { createFakeClock } from '../../test-support/fake-clock.js';


function fixture() {
  const view = new EventTarget();
  view.visualViewport = new EventTarget();
  view.devicePixelRatio = 2;
  const ownerDocument = { body: { style: { zoom: '' } } };
  return { view, ownerDocument };
}
function input(view, type, props) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, props);
  view.dispatchEvent(event);
  return event.defaultPrevented;
}

test('zoom guard blocks only modified zoom inputs, counters DPR and removes listeners on dispose', () => {
  const clock = createFakeClock();
  const f = fixture();
  const guard = attachBrowserZoomGuard(f);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    assert.equal(input(f.view, 'wheel', { [modifier]: true }), true);
    for (const key of ['+', '-', '=', '0']) assert.equal(input(f.view, 'keydown', { [modifier]: true, key }), true);
    assert.equal(input(f.view, 'keydown', { [modifier]: true, key: 'a' }), false);
  }
  assert.equal(input(f.view, 'wheel', {}), false);
  f.view.devicePixelRatio = 4;
  f.view.visualViewport.dispatchEvent(new Event('resize'));
  assert.equal(f.ownerDocument.body.style.zoom, '0.5');
  guard.dispose();
  clock.advance(1000);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(f.ownerDocument.body.style.zoom, '');
  assert.equal(input(f.view, 'wheel', { ctrlKey: true }), false);
  f.view.dispatchEvent(new Event('resize'));
  assert.equal(f.ownerDocument.body.style.zoom, '');
});

test('zoom guard tolerates an absent visualViewport', () => {
  const f = fixture();
  f.view.visualViewport = null;
  const guard = attachBrowserZoomGuard(f);
  guard.dispose();
  assert.equal(f.ownerDocument.body.style.zoom, '');
});

test('Landing gesture mode blocks all gestures and removes every listener on dispose', () => {
  const f = fixture();
  const guard = attachBrowserZoomGuard({ ...f, blockGestures: true });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) assert.equal(input(f.view, type, {}), true);
  guard.dispose();
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) assert.equal(input(f.view, type, {}), false);
});
