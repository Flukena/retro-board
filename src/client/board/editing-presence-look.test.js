import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteEditingFrameStyle } from './editing-presence-look.js';

const item = { id: 'card', type: 'sticky', x: 500.25, y: 300.625, w: 280.5, h: 240.25 };
const colors = { color: 'currentColor', glow: 'transparent' };
const radii = { sticky: 'var(--radius-sticky)', text: 'var(--radius-text-card)', zone: 'var(--radius-zone)', image: 'var(--radius-image-card)' };

test('remote editor corners follow the same world-space radius token as each card', () => {
  for (const [type, radius] of Object.entries(radii)) {
    assert.equal(remoteEditingFrameStyle({ ...item, type }, colors).borderRadius, radius);
  }
});

test('fractional bounds stay in world space while the live inverse zoom sets stroke and glow', () => {
  const style = remoteEditingFrameStyle(item, colors);
  assert.equal(style.left, item.x);
  assert.equal(style.top, item.y);
  assert.equal(style.width, item.w);
  assert.equal(style.height, item.h);
  assert.equal(style.boxSizing, 'border-box');
  assert.equal(style.border, 'calc(2px * var(--rb-presence-inverse-zoom, 1)) solid currentColor');
  assert.equal(style.boxShadow, '0 0 0 calc(3px * var(--rb-presence-inverse-zoom, 1)) transparent');
  assert.equal(style.pointerEvents, 'none');
});
