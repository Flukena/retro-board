import test from 'node:test';
import assert from 'node:assert/strict';
import { readDrawingPreview } from './drawing-preview.js';
const value = { id: 'drawing', targetId: null, base: null, strokes: [{ color: '#112233', width: 4, points: [{ x: 10.25, y: 20.5 }] }] };
test('live preview retains exact world coordinates and rejects malformed or excessive network input', () => {
  assert.equal(readDrawingPreview(value).strokes[0].points[0].x, 10.25);
  for (const changes of [{ width: '4' }, { width: Infinity }, { tool: 'script' }, { color: 'url(invalid)' }, { points: [{ x: NaN, y: 0 }] },
    { points: Array.from({ length: 8193 }, () => ({ x: 1, y: 2 })) }]) {
    assert.equal(readDrawingPreview({ ...value, strokes: [{ ...value.strokes[0], ...changes }] }), null);
  }
  assert.equal(readDrawingPreview({ ...value, targetId: '__proto__' }), null);
});
