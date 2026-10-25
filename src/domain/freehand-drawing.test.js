import test from 'node:test';
import assert from 'node:assert/strict';
import { DrawingDraft, drawingBounds, DRAWING_MAX_POINTS, DRAWING_MAX_STROKES } from './freehand-drawing.js';
const style = { color: '#111827', width: 4 };
const point = { x: -10.25, y: 30.5 };
function stroke(draft, x = 0) { assert.ok(draft.begin({ x, y: 0 }, style)); draft.append({ x: x + 10, y: 10 }, 1); draft.end(); }

test('fractional strokes keep their width/color, single dots and padded transparent bounds', () => {
  const draft = new DrawingDraft(); assert.ok(draft.begin(point, style)); draft.end();
  assert.deepEqual(drawingBounds(draft.strokes), { x: -13.25, y: 27.5, w: 6, h: 6 });
  assert.equal(draft.strokes[0].width, 4); assert.equal(draft.strokes[0].color, style.color);
  assert.throws(() => draft.strokes.push({})); assert.throws(() => { draft.strokes[0].points[0].x = 99; });
});
test('undo/redo keep completed strokes while cancelled gestures and new branches do not leak', () => {
  const draft = new DrawingDraft(); stroke(draft); stroke(draft, 20); draft.undo(); assert.equal(draft.strokes.length, 1);
  draft.redo(); assert.equal(draft.strokes.length, 2); draft.undo(); stroke(draft, 30); assert.equal(draft.canRedo, false);
  assert.ok(draft.begin(point, style)); draft.cancelStroke(); assert.equal(draft.strokes.length, 2);
  draft.clear(); assert.equal(draft.empty, true); assert.equal(draft.canUndo, false);
});
test('point and stroke budgets reject excess input without corrupting the existing draft', () => {
  const draft = new DrawingDraft(); assert.equal(draft.begin({ x: Infinity, y: 0 }, style), false);
  assert.equal(draft.begin(point, { ...style, width: NaN }), false);
  assert.equal(draft.begin(point, { ...style, color: 'url(unsafe)' }), false);
  draft.begin({ x: 0, y: 0 }, style);
  for (let x = 1; x < DRAWING_MAX_POINTS; x++) assert.ok(draft.append({ x, y: 0 }, 1));
  assert.equal(draft.append({ x: DRAWING_MAX_POINTS, y: 0 }, 1), false); assert.equal(draft.pointCount, DRAWING_MAX_POINTS);
  draft.clear(); for (let n = 0; n < DRAWING_MAX_STROKES; n++) { draft.begin({ x: n, y: n }, style); draft.end(); }
  assert.equal(draft.begin(point, style), false); assert.equal(draft.strokes.length, DRAWING_MAX_STROKES);
});
test('oversized/cross-boundary drawings are not encoded into invalid canonical geometry', () => {
  assert.equal(drawingBounds([]), null);
  assert.equal(drawingBounds([{ width: 4, points: [{ x: 0, y: 0 }, { x: 200000, y: 0 }] }]), null);
  assert.equal(drawingBounds([{ width: 4, points: [{ x: 10000000, y: 0 }] }]), null);
});

test('shape gestures replace the preview endpoint, constrain circles and keep one undo operation', () => {
  const draft = new DrawingDraft();
  assert.ok(draft.begin({ x: 100, y: 80 }, { ...style, tool: 'rectangle' }));
  for (let n = 0; n < 100; n++) draft.append({ x: 200 + n, y: 180 }, 1);
  assert.equal(draft.pointCount, 2); assert.equal(draft.strokes[0].tool, 'rectangle');
  assert.deepEqual(draft.strokes[0].points.at(-1), { x: 299, y: 180 }); draft.end();
  draft.begin({ x: 100, y: 100 }, { ...style, tool: 'circle' }); draft.append({ x: 50, y: 80 }, 1); draft.end();
  assert.deepEqual(draft.strokes[1].points.at(-1), { x: 50, y: 50 });
  draft.undo(); assert.equal(draft.strokes.length, 1); draft.redo(); assert.equal(draft.strokes.length, 2);
});
test('eraser operations preserve history and never enlarge the visible drawing bounds', () => {
  const draft = new DrawingDraft(); stroke(draft);
  const before = drawingBounds(draft.strokes);
  assert.ok(draft.begin({ x: -1000, y: -1000 }, { ...style, tool: 'eraser', width: 24 }));
  draft.append({ x: 1000, y: 1000 }, 1); draft.end();
  assert.equal(draft.strokes.at(-1).tool, 'eraser'); assert.deepEqual(drawingBounds(draft.strokes), before);
  draft.undo(); assert.equal(draft.strokes.length, 1); draft.redo(); assert.equal(draft.strokes.length, 2);
  assert.equal(draft.begin(point, { ...style, tool: 'unknown' }), false);
});

test('eraser-only edits preserve the exact canonical base geometry including subpixel dimensions', () => {
  const base={x:0.1,y:0.2,w:0.2,h:0.3};
  assert.deepEqual(drawingBounds([{tool:'eraser',width:24,points:[{x:1000,y:1000}]}],base),base);
});
