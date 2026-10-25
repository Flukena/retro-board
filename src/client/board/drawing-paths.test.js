import test from 'node:test';
import assert from 'node:assert/strict';
import { paintDrawingPath } from './drawing-paths.js';
function fixture() {
  const calls = [], ctx = {};
  for (const method of ['beginPath','arc','fill','moveTo','lineTo','stroke','rect','closePath']) ctx[method] = (...args) => calls.push([method,...args]);
  return { calls, ctx };
}
test('rectangle, circle and arrow preview and saved painting use their actual geometry', () => {
  for (const [tool, expected] of [['rectangle','rect'],['circle','arc'],['arrow','closePath']]) {
    const f = fixture(); paintDrawingPath(f.ctx, { tool, width: 4, points: [{ x: 100, y: 100 }, { x: 20, y: 20 }] });
    assert.ok(f.calls.some(call => call[0] === expected));
    if (tool === 'rectangle') assert.deepEqual(f.calls.find(call => call[0] === 'rect'), ['rect',20,20,80,80]);
    if (tool === 'circle') assert.deepEqual(f.calls.find(call => call[0] === 'arc').slice(0,4), ['arc',60,60,40]);
  }
});
test('a tap paints a dot for any tool and an empty path does nothing', () => {
  for (const tool of ['rectangle','circle','arrow','eraser','pen']) {
    const f = fixture(); paintDrawingPath(f.ctx, { tool, width: 8, points: [{ x: 1, y: 2 }, { x: 1, y: 2 }] });
    assert.ok(f.calls.some(call => call[0] === 'fill'));
  }
  const f = fixture(); paintDrawingPath(f.ctx, { points: [] }); assert.equal(f.calls.length, 0);
});
