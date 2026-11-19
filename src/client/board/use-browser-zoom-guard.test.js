import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBrowserZoomGuard } from './use-browser-zoom-guard.js';
import { createFakeClock } from '../../test-support/fake-clock.js';


function fixture() {
  const view = new EventTarget();
  view.visualViewport = new EventTarget();
  view.devicePixelRatio = 2;
  let content = 'previous viewport';
  const document = {
    body: { style: { zoom: '' } },
    querySelector: () => ({ getAttribute: () => content, setAttribute: (_name, value) => { content = value; } }),
  };
  return { view, document, content: () => content };
}
function input(view, type, props) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, props);
  view.dispatchEvent(event);
  return event.defaultPrevented;
}

test('zoom guard blocks only modified zoom inputs, counters DPR, restores metadata and listeners on dispose', () => {
  const clock = createFakeClock();
  const f = fixture();
  const guard = attachBrowserZoomGuard(f);
  assert.notEqual(f.content(), 'previous viewport');
  for (const modifier of ['ctrlKey', 'metaKey']) {
    assert.equal(input(f.view, 'wheel', { [modifier]: true }), true);
    for (const key of ['+', '-', '=', '0']) assert.equal(input(f.view, 'keydown', { [modifier]: true, key }), true);
    assert.equal(input(f.view, 'keydown', { [modifier]: true, key: 'a' }), false);
  }
  assert.equal(input(f.view, 'wheel', {}), false);
  f.view.devicePixelRatio = 4;
  f.view.visualViewport.dispatchEvent(new Event('resize'));
  assert.equal(f.document.body.style.zoom, '0.5');
  guard.dispose();
  clock.advance(1000);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(f.content(), 'previous viewport');
  assert.equal(f.document.body.style.zoom, '');
  assert.equal(input(f.view, 'wheel', { ctrlKey: true }), false);
  f.view.dispatchEvent(new Event('resize'));
  assert.equal(f.document.body.style.zoom, '');
});

test('zoom guard tolerates absent viewport metadata and visualViewport', () => {
  const f = fixture();
  f.view.visualViewport = null;
  f.document.querySelector = () => null;
  const guard = attachBrowserZoomGuard(f);
  guard.dispose();
  assert.equal(f.document.body.style.zoom, '');
});
