import test from 'node:test';
import assert from 'node:assert/strict';
import { OverviewRasterPainter, rasterTextLines, overviewFontLoadAffectsPaint } from './overview-raster-paint.js';

function recorder() {
  const calls = [];
  const ctx = { calls, measureText: text => ({ width: [...text].length * 10 }) };
  for (const name of ['save','restore','beginPath','rect','clip','setTransform','fillText','clearRect']) ctx[name] = (...args) => calls.push([name,...args]);
  return ctx;
}
const model = { width: 100, height: 100, scale: 0.4, bounds: { x: -20, y: -40 }, rows: [
  { id: 'note', x: -20, y: -40, w: 200, h: 200, text: 'Hello', fontSize: 20 },
] };
const style = { fontFamily: 'sans-serif', padding: 14, lineHeight: 1.5 };

test('raster text preserves line breaks, word wraps and combining graphemes', () => {
  const ctx = recorder();
  assert.deepEqual(rasterTextLines(ctx, 'one two\nthree', 50), ['one','two','three']);
  assert.deepEqual(rasterTextLines(ctx, 'ก้ข', 20), ['ก้','ข']);
});

test('painter clips each card and clears/restores only the hovered card', () => {
  const ctx = recorder(), canvas = { getContext: () => ctx };
  const painter = new OverviewRasterPainter(canvas, model);
  assert.equal(painter.draw(style), true);
  assert.deepEqual(ctx.calls[0], ['setTransform', 0.4, 0, 0, 0.4, 8, 16]);
  assert.ok(ctx.calls.some(call => call[0] === 'fillText' && call[1] === 'Hello'));
  painter.hover('note'); assert.deepEqual(ctx.calls.at(-1), ['clearRect',-20,-40,200,200]);
  const drawn = ctx.calls.filter(call => call[0] === 'fillText').length;
  painter.hover(null); assert.equal(ctx.calls.filter(call => call[0] === 'fillText').length, drawn + 1);
});

test('unavailable canvas or unresolved style never hides native text', () => {
  assert.equal(new OverviewRasterPainter({ getContext: () => null }, model).draw(style), false);
  const ctx = recorder(), painter = new OverviewRasterPainter({ getContext: () => ctx }, model);
  assert.equal(painter.draw({ ...style, padding: NaN }), false);
  assert.equal(ctx.calls.length, 0);
});


test('native detail masks reuse the atlas and hover never restores text beneath a full card', () => {
  const ctx = recorder(), canvas = { getContext: () => ctx };
  const painter = new OverviewRasterPainter(canvas, model);
  painter.draw(style); const painted = ctx.calls.filter(call => call[0] === 'fillText').length;
  painter.setHidden(new Set(['note']));
  assert.deepEqual(ctx.calls.at(-1), ['clearRect', -20, -40, 200, 200]);
  painter.hover('note'); painter.hover(null);
  assert.equal(ctx.calls.filter(call => call[0] === 'fillText').length, painted);
  painter.setHidden(new Set());
  assert.equal(ctx.calls.filter(call => call[0] === 'fillText').length, painted + 1);
  const operationCount = ctx.calls.length;
  painter.setHidden(new Set());
  assert.equal(ctx.calls.length, operationCount, 'Unchanged coverage performs no bitmap writes');
  assert.equal(canvas.width, model.width); assert.equal(canvas.height, model.height);
});

test('redrawing theme or fonts preserves the current native-detail mask', () => {
  const ctx = recorder(), painter = new OverviewRasterPainter({ getContext: () => ctx }, model);
  painter.setHidden(new Set(['note'])); painter.draw(style);
  assert.equal(ctx.calls.filter(call => call[0] === 'fillText').length, 0);
  painter.draw({ ...style, fontFamily: 'serif' });
  assert.equal(ctx.calls.filter(call => call[0] === 'fillText').length, 0);
  painter.setHidden(null);
  assert.equal(ctx.calls.filter(call => call[0] === 'fillText').length, 1);
});


test('unrelated header fonts never redraw the entire card atlas, while matching normal or variable fonts do', () => {
  const family = '"Sarabun", sans-serif';
  const loaded = (name, weight) => ({ fontfaces: [{ family: name, weight }] });
  assert.equal(overviewFontLoadAffectsPaint(loaded('Mitr', '600'), family), false);
  assert.equal(overviewFontLoadAffectsPaint(loaded('Sarabun', '600'), family), false);
  assert.equal(overviewFontLoadAffectsPaint(loaded('Sarabun', '400'), family), true);
  assert.equal(overviewFontLoadAffectsPaint(loaded('Sarabun', 'normal'), family), true);
  assert.equal(overviewFontLoadAffectsPaint(loaded('Sarabun', '100 900'), family), true);
  assert.equal(overviewFontLoadAffectsPaint(loaded('Sarabun', '500 900'), family), false);
  assert.equal(overviewFontLoadAffectsPaint(loaded('"sarabun"', '400'), family), true);
  assert.equal(overviewFontLoadAffectsPaint({ fontfaces: [] }, family), false);
  assert.equal(overviewFontLoadAffectsPaint({}, family), true, 'Unspecified browser events keep the compatibility redraw');
});
