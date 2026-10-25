import test from 'node:test';
import assert from 'node:assert/strict';
import { imageFitsPaintLayer } from './image-paint.js';

test('image paint layers fit within the current projected viewport area', () => {
  const image = { w: 940, h: 1670 };
  for (const viewport of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
    assert.equal(imageFitsPaintLayer(image, 1, viewport), false);
    assert.equal(imageFitsPaintLayer(image, 0.1, viewport), true);
    assert.equal(imageFitsPaintLayer(viewport, 1, viewport), true);
  }
});

test('missing viewport and invalid geometry do not allocate explicit image layers', () => {
  assert.equal(imageFitsPaintLayer({ w: 1, h: 1 }, 1), false);
  for (const value of [0, -1, NaN, Infinity]) {
    assert.equal(imageFitsPaintLayer({ w: value, h: 1 }, 1, { w: 1, h: 1 }), false);
    assert.equal(imageFitsPaintLayer({ w: 1, h: 1 }, value, { w: 1, h: 1 }), false);
  }
});
