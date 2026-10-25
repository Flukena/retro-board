import test from 'node:test';
import assert from 'node:assert/strict';
import { observeContentSize } from './observe-content-size.js';

test('observing a newly mounted card defers size reads until the browser has laid it out', () => {
  const calls = [], node = {};
  const frames = new Map(); let nextFrameId = 0;
  const view = { requestAnimationFrame: callback => { frames.set(++nextFrameId, callback); return nextFrameId; },
    cancelAnimationFrame: id => frames.delete(id) };
  let deliver, disconnected = false;
  class Observer {
    constructor(callback) { deliver = callback; }
    observe(target) { assert.equal(target, node); }
    disconnect() { disconnected = true; }
  }
  const cleanup = observeContentSize(node, () => calls.push('measured'), Observer, view);
  assert.deepEqual(calls, [], 'Mounting must not force a synchronous layout read');
  deliver(); deliver();
  assert.deepEqual(calls, [], 'Resizing in the observer callback can restart the browser delivery loop');
  assert.equal(frames.size, 1, 'Repeated notifications share the next frame');
  [...frames.values()][0](); frames.clear(); assert.deepEqual(calls, ['measured']);
  deliver();
  cleanup(); assert.equal(disconnected, true);
  assert.equal(frames.size, 0, 'Unmounting cancels the pending size update');
});
test('browsers without ResizeObserver retain the synchronous measurement fallback', () => {
  let measured = false;
  const cleanup = observeContentSize({}, () => { measured = true; }, null);
  assert.equal(measured, true); assert.doesNotThrow(cleanup);
});
