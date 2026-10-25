import test from 'node:test';
import assert from 'node:assert/strict';
import { paintMinimapItems } from './minimap-paint.js';

test('minimap paints zones behind cards with the same bounds, colors and minimum visible size', () => {
  const fills = [], borders = [];
  const ctx = {
    fillRect(...rect) { fills.push({ rect, color: this.fillStyle, alpha: this.globalAlpha }); },
    strokeRect(...rect) { borders.push({ rect, color: this.strokeStyle }); },
  };
  const colors = Array.from({ length: 6 }, (_, index) => ({ bg: `card-${index}`, zoneBg: `zone-${index}`, border: `border-${index}` }));
  paintMinimapItems(ctx, [
    { type: 'sticky', color: 1, x: 10, y: 20, w: 1, h: 2 },
    { type: 'image', x: 30, y: 40, w: 4, h: 5 },
    { type: 'zone', color: 2, x: 5, y: 8, w: 100, h: 80 },
    { type: 'text', x: 20, y: 30, w: 8, h: 3 },
  ], colors, '#64748b');
  assert.deepEqual(fills, [
    { rect: [5, 8, 100, 80], color: 'zone-2', alpha: 0.9 },
    { rect: [10, 20, 3, 3], color: 'card-1', alpha: 0.9 },
    { rect: [30, 40, 4, 5], color: '#a78bfa', alpha: 0.9 },
    { rect: [20, 30, 8, 3], color: '#64748b', alpha: 0.72 },
  ]);
  assert.deepEqual(borders, [{ rect: [5.5, 8.5, 99, 79], color: 'border-2' }]);
  assert.equal(ctx.globalAlpha, 1);
});
