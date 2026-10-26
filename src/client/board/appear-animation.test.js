import test from 'node:test';
import assert from 'node:assert/strict';
import { appearAnimation, APPEAR_ANIMATION } from './appear-animation.js';

test('ordinary cards, text and images keep the appear pop', () => {
  for (const size of [{ w: 280, h: 240 }, { w: 400, h: 80 }, { w: 800, h: 600 }]) {
    assert.equal(appearAnimation(size), APPEAR_ANIMATION);
  }
});

test('items whose own CSS size would need a huge animation layer appear without the pop', () => {
  // The public-wall zone and photo that killed iOS Safari at its 2 GB tab limit.
  for (const size of [{ w: 10_031, h: 7_207 }, { w: 9_520, h: 7_140 }, { w: 4_000, h: 3_000 }]) {
    assert.equal(appearAnimation(size), undefined);
  }
});

test('missing or invalid sizes do not skip the animation for ordinary defaults', () => {
  assert.equal(appearAnimation({}), APPEAR_ANIMATION);
  assert.equal(appearAnimation({ w: Number.NaN, h: 100 }), APPEAR_ANIMATION);
});
