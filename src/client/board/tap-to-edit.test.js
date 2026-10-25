import test from 'node:test';
import assert from 'node:assert/strict';
import { TAP_MAX_DURATION_MS, TAP_MAX_MOVE_PX, tapEditsCard } from './tap-to-edit.js';

const down = Object.freeze({ pointerType: 'touch', wasSelected: true, x: 100, y: 100, time: 1000 });
const up = (patch = {}) => ({ x: 100, y: 100, time: 1100, ...patch });

test('a quick touch tap on an already selected card starts editing', () => {
  assert.equal(tapEditsCard(down, up()), true);
  assert.equal(tapEditsCard({ ...down, pointerType: 'pen' }, up()), true);
});

test('first tap, mouse clicks, drags and long presses do not start editing', () => {
  assert.equal(tapEditsCard({ ...down, wasSelected: false }, up()), false);
  assert.equal(tapEditsCard({ ...down, pointerType: 'mouse' }, up()), false);
  assert.equal(tapEditsCard(down, up({ x: 100 + TAP_MAX_MOVE_PX + 1 })), false);
  assert.equal(tapEditsCard(down, up({ time: down.time + TAP_MAX_DURATION_MS + 1 })), false);
  assert.equal(tapEditsCard(null, up()), false);
});
