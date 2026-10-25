import test from 'node:test';
import assert from 'node:assert/strict';
import { arrowHead, drawingEndPoint, drawingExtentPoints } from './drawing-shapes.js';
test('circle constraints keep mirrored drags square without losing fractional anchors', () => {
  const first = { x: 10.25, y: 20.5 };
  for (const end of [{ x: 50, y: 30 }, { x: -10, y: -70 }, { x: 10.25, y: 100 }]) {
    const point = drawingEndPoint('circle', first, end);
    assert.equal(Math.abs(point.x - first.x), Math.abs(point.y - first.y));
  }
  assert.deepEqual(drawingEndPoint('rectangle', first, { x: -1, y: 200 }), { x: -1, y: 200 });
});
test('arrow heads stay attached for every direction and short arrows never reverse past their start', () => {
  for (const end of [{ x: 100, y: 0 }, { x: -100, y: 0 }, { x: 0, y: 100 }, { x: 0, y: -100 }, { x: 2, y: 3 }]) {
    const start = { x: 0, y: 0 }, head = arrowHead(start, end, 8);
    const full = Math.hypot(end.x, end.y);
    assert.ok(Math.hypot(head.base.x, head.base.y) >= full / 2);
    assert.equal((head.left.x + head.right.x) / 2, head.base.x);
    assert.equal((head.left.y + head.right.y) / 2, head.base.y);
    assert.equal(drawingExtentPoints({ tool: 'arrow', width: 8, points: [start, end] }).length, 4);
  }
  assert.equal(arrowHead({ x: 1, y: 2 }, { x: 1, y: 2 }, 4), null);
});
