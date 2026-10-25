import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_LAYER_SETTLE_MS, holdLiveLayer, releaseLiveLayer } from './live-layer-hint.js';

const HALF_SETTLE_MS = LIVE_LAYER_SETTLE_MS / 2;

test('a live layer keeps its raster while input continues and drops the hint once input settles', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const element = { style: {} };
  holdLiveLayer(element);
  assert.equal(element.style.willChange, 'transform');
  context.mock.timers.tick(HALF_SETTLE_MS);
  holdLiveLayer(element);
  context.mock.timers.tick(HALF_SETTLE_MS);
  assert.equal(element.style.willChange, 'transform', 'Continued input extends the live window');
  context.mock.timers.tick(LIVE_LAYER_SETTLE_MS);
  assert.equal(element.style.willChange, '', 'Settled input lets the browser re-raster at full detail');
});

test('releasing a live layer clears the hint at once and cancels the pending settle', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const element = { style: {} };
  holdLiveLayer(element);
  releaseLiveLayer(element);
  assert.equal(element.style.willChange, '');
  holdLiveLayer(element);
  context.mock.timers.tick(HALF_SETTLE_MS);
  assert.equal(element.style.willChange, 'transform', 'An earlier release timer cannot end a newer gesture');
});

test('releasing a layer that was never live leaves its style untouched', () => {
  const element = { style: {} };
  releaseLiveLayer(element);
  assert.equal(Object.hasOwn(element.style, 'willChange'), false);
});
