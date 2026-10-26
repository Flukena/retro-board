import test from 'node:test';
import assert from 'node:assert/strict';
import { webkitCompositing } from './webkit-compositing.js';

test('only browsers that expose GestureEvent use the WebKit compositing path', () => {
  assert.equal(webkitCompositing({ GestureEvent: class {} }), true);
  assert.equal(webkitCompositing({}), false);
  assert.equal(webkitCompositing(undefined), false);
});
