import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteEditingFrameStyle } from './editing-presence-look.js';

const item = { id: 'card', type: 'sticky', x: 500.25, y: 300.625, w: 280.5, h: 240.25 };
const colors = { color: 'currentColor', glow: 'transparent' };
const radii = { sticky: 'var(--radius-sticky)', text: 'var(--radius-text-card)', zone: 'var(--radius-zone)', image: 'var(--radius-image-card)' };

test('remote editor corners follow the same world-space radius token as each card at every zoom', () => {
  for (const [type, radius] of Object.entries(radii)) {
    for (const zoom of [0.05, 0.12, 0.25, 0.5, 1, 2, 3]) {
      assert.equal(remoteEditingFrameStyle({ ...item, type }, { ...colors, zoom }).borderRadius, radius);
    }
  }
});

test('fractional canonical bounds stay exact while only stroke and glow keep their screen size', () => {
  for (const zoom of [0.05, 0.12, 0.25, 0.5, 1, 2, 3]) {
    const style = remoteEditingFrameStyle(item, { ...colors, zoom });
    assert.equal(style.left, item.x); assert.equal(style.top, item.y);
    assert.equal(style.width, item.w); assert.equal(style.height, item.h);
    assert.equal(style.boxSizing, 'border-box');
    assert.equal(style.border, `${2 / zoom}px solid currentColor`);
    assert.equal(style.boxShadow, `0 0 0 ${3 / zoom}px transparent`);
    assert.equal(style.pointerEvents, 'none');
  }
});
