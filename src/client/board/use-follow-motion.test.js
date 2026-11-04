import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER_CURSOR_STALE_MS } from '../session/player-cursors.js';
import { followMotionSignature, followMotionViewport } from './use-follow-motion.js';

const VIEWPORT = { x: 0, y: 0, zoom: 1 };
const SIZE = { w: 1000, h: 800 };
const NOW = 1_000_000;

test('the view centre wins over the cursor and changes the signature per update', () => {
  const player = { view: { x: 10, y: 20, zoom: 2, updatedAt: 5 }, cursor: { x: 0, y: 0, updatedAt: 9 } };
  assert.equal(followMotionSignature('u', player), 'u:view:5');
  assert.equal(followMotionSignature('u', { cursor: { x: 1, y: 1, updatedAt: 3 } }), 'u:cursor:3');
  assert.equal(followMotionSignature('u', {}), null);
  assert.equal(followMotionSignature('u', null), null);
});

test('following centres the world point and adopts the target zoom', () => {
  const next = followMotionViewport({ view: { x: 100, y: 50, zoom: 2 } }, VIEWPORT, SIZE, NOW);
  assert.equal(next.zoom, 2);
  assert.equal(next.x + 100 * next.zoom, SIZE.w / 2);
  assert.equal(next.y + 50 * next.zoom, SIZE.h / 2);
});

test('an old client is followed by its cursor only while the cursor is fresh', () => {
  const fresh = { cursor: { x: 0, y: 0, updatedAt: NOW - 1 } };
  const stale = { cursor: { x: 0, y: 0, updatedAt: NOW - PLAYER_CURSOR_STALE_MS } };
  assert.equal(followMotionViewport(fresh, VIEWPORT, SIZE, NOW).zoom, VIEWPORT.zoom);
  assert.equal(followMotionViewport(stale, VIEWPORT, SIZE, NOW), null);
  assert.equal(followMotionViewport({}, VIEWPORT, SIZE, NOW), null);
});
