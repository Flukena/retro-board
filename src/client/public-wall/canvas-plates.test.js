import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBoxShadows, imageDrawRect, paintScene } from './canvas-plates.js';

const CHAR_WIDTH_PX = 10;
function recorder() {
  const calls = [];
  const ctx = { calls, measureText: text => ({ width: [...text].length * CHAR_WIDTH_PX }) };
  for (const name of ['save', 'restore', 'beginPath', 'rect', 'roundRect', 'clip', 'fill', 'stroke', 'fillRect',
    'fillText', 'drawImage', 'arc']) ctx[name] = (...args) => calls.push([name, ...args]);
  for (const name of ['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'font', 'shadowColor', 'shadowBlur',
    'shadowOffsetX', 'shadowOffsetY', 'textBaseline', 'textAlign']) {
    let value;
    Object.defineProperty(ctx, name, { get: () => value, set: next => { value = next; calls.push([`set:${name}`, next]); } });
  }
  return ctx;
}
const plate = (overrides = {}) => ({ x: 10, y: 20, w: 100, h: 80, alpha: 1, radius: 0, background: null,
  border: null, shadows: [], text: null, image: null, clip: null, ...overrides });
const scene = (plates, overrides = {}) => ({ width: 1200, height: 720, background: 'rgb(250, 248, 244)',
  grid: null, plates, ...overrides });
const fills = ctx => ctx.calls.filter(([name]) => name === 'set:fillStyle').map(([, value]) => value);

test('computed box-shadow lists become canvas shadow layers in CSS order, ignoring inset shadows', () => {
  assert.deepEqual(parseBoxShadows('none', 1), []);
  assert.deepEqual(parseBoxShadows('rgba(110, 80, 40, 0.12) 0px 1px 1px 0px, rgba(110, 80, 40, 0.55) 0px 16px 18px -14px', 2), [
    { color: 'rgba(110, 80, 40, 0.12)', offsetX: 0, offsetY: 2, blur: 2, spread: 0 },
    { color: 'rgba(110, 80, 40, 0.55)', offsetX: 0, offsetY: 32, blur: 36, spread: -28 },
  ]);
  assert.deepEqual(parseBoxShadows('rgb(0, 0, 0) 1px 2px 3px 4px inset', 1), []);
});

test('images keep their aspect ratio for cover and contain and stretch for fill', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };
  const image = { width: 100, height: 100 };
  assert.deepEqual(imageDrawRect(box, image, 'fill'), { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(imageDrawRect(box, image, 'contain'), { x: 50, y: 0, w: 100, h: 100 });
  assert.deepEqual(imageDrawRect(box, image, 'cover'), { x: 0, y: -50, w: 200, h: 200 });
});

test('scene paints the board background first and every card in DOM order', () => {
  const ctx = recorder();
  paintScene(ctx, scene([plate({ background: 'red' }), plate({ background: 'blue' })]), new Map());
  assert.deepEqual(ctx.calls.find(([name]) => name === 'fillRect'), ['fillRect', 0, 0, 1200, 720]);
  assert.deepEqual(fills(ctx), ['rgb(250, 248, 244)', 'red', 'blue']);
});

test('a card shadow is cast without drawing the card twice in its shadow position', () => {
  const ctx = recorder();
  const color = 'rgba(110, 80, 40, 0.55)';
  paintScene(ctx, scene([plate({ background: 'green', shadows: [{ color, offsetX: 0, offsetY: 4, blur: 6, spread: -2 }] })]), new Map());
  assert.ok(ctx.calls.some(([name, value]) => name === 'set:shadowColor' && value === color));
  // Canvas multiplies the shadow colour by the caster's own alpha, so the caster must be opaque.
  const casterFill = fills(ctx)[1];
  assert.doesNotMatch(casterFill, /rgba|hsla|transparent/, 'shadow keeps exactly its CSS opacity');
  const shapes = ctx.calls.filter(([name]) => name === 'rect');
  // The shadow caster is shrunk by the spread and moved off-canvas; its shadow is offset back onto the card.
  const caster = shapes[0];
  assert.equal(caster[3], 96); assert.equal(caster[4], 76);
  const offsetX = ctx.calls.find(([name]) => name === 'set:shadowOffsetX')[1];
  assert.equal(caster[1] + offsetX, 12, 'shadow lands where the shrunk card is');
  assert.equal(ctx.calls.find(([name]) => name === 'set:shadowOffsetY')[1], 4);
  assert.equal(ctx.calls.find(([name]) => name === 'set:shadowBlur')[1], 6);
  assert.deepEqual(shapes[1], ['rect', 10, 20, 100, 80], 'card face drawn in place');
});

test('rounded cards use roundRect and borders stay inside the card edge', () => {
  const ctx = recorder();
  paintScene(ctx, scene([plate({ radius: 6, background: 'white', border: { width: 2, color: 'orange' } })]), new Map());
  const rounded = ctx.calls.filter(([name]) => name === 'roundRect');
  assert.deepEqual(rounded[0], ['roundRect', 10, 20, 100, 80, 6]);
  assert.deepEqual(rounded[1], ['roundRect', 11, 21, 98, 78, 5]);
  assert.ok(ctx.calls.some(([name, value]) => name === 'set:strokeStyle' && value === 'orange'));
});

const clipRects = ctx => ctx.calls.filter(([name]) => name === 'rect').map(([, ...rect]) => rect);

test('card text wraps inside its box and keeps the card font and colour', () => {
  const ctx = recorder();
  const text = { content: 'one two three', font: 'normal 400 20px Sarabun', color: 'rgb(31, 41, 55)',
    lineHeight: 30, align: 'left', box: { x: 10, y: 20, w: 80, h: 50 }, clip: null };
  paintScene(ctx, scene([plate({ text })]), new Map());
  assert.ok(ctx.calls.some(([name, value]) => name === 'set:font' && value === 'normal 400 20px Sarabun'));
  assert.ok(ctx.calls.some(([name, value]) => name === 'set:fillStyle' && value === 'rgb(31, 41, 55)'));
  const lines = ctx.calls.filter(([name]) => name === 'fillText').map(([, line, x]) => [line, x]);
  assert.deepEqual(lines, [['one two', 10], ['three', 10]]);
});

test('text is not clipped to its own line box, so Thai marks above the first line stay visible', () => {
  const ctx = recorder();
  const text = { content: 'สั้น', font: '20px Sarabun', color: 'black', lineHeight: 30, align: 'left',
    box: { x: 10, y: 20, w: 80, h: 50 }, clip: null };
  paintScene(ctx, scene([plate({ text })]), new Map());
  assert.deepEqual(clipRects(ctx), [], 'no clip unless the page clips this text');
});

test('text is clipped only to the box its page clips it to, such as an overflow-hidden card body', () => {
  const ctx = recorder();
  const clip = { x: 0, y: 0, w: 60, h: 40 };
  const text = { content: 'a', font: '20px a', color: 'black', lineHeight: 30, align: 'left', box: { x: 10, y: 20, w: 80, h: 50 }, clip };
  paintScene(ctx, scene([plate({ text })]), new Map());
  assert.deepEqual(clipRects(ctx), [[0, 0, 60, 40]]);
});

test('each line sits in its line box like CSS: half the extra leading above the font ascent', () => {
  const ctx = recorder();
  ctx.measureText = text => ({ width: [...text].length * CHAR_WIDTH_PX, fontBoundingBoxAscent: 18, fontBoundingBoxDescent: 6 });
  const text = { content: 'a\nb', font: '20px a', color: 'black', lineHeight: 30, align: 'left', box: { x: 0, y: 100, w: 80, h: 90 }, clip: null };
  paintScene(ctx, scene([plate({ text })]), new Map());
  assert.ok(ctx.calls.some(([name, value]) => name === 'set:textBaseline' && value === 'alphabetic'));
  // Content area 18 + 6 = 24 in a 30px line: 3px leading on top, then the 18px ascent.
  assert.deepEqual(ctx.calls.filter(([name]) => name === 'fillText').map(([, line, , y]) => [line, y]), [['a', 121], ['b', 151]]);
});

test('without font metrics each line is centred in its line box', () => {
  const ctx = recorder();
  const text = { content: 'a', font: '20px a', color: 'black', lineHeight: 30, align: 'left', box: { x: 0, y: 100, w: 80, h: 90 }, clip: null };
  paintScene(ctx, scene([plate({ text })]), new Map());
  assert.ok(ctx.calls.some(([name, value]) => name === 'set:textBaseline' && value === 'middle'));
  assert.equal(ctx.calls.find(([name]) => name === 'fillText')[3], 115);
});

test('a card inside a clipping parent is clipped to that parent', () => {
  const ctx = recorder();
  paintScene(ctx, scene([plate({ background: 'red', clip: { x: 5, y: 6, w: 7, h: 8 } })]), new Map());
  assert.deepEqual(clipRects(ctx)[0], [5, 6, 7, 8]);
});

test('centered text is anchored at the middle of its box', () => {
  const ctx = recorder();
  const text = { content: 'hi', font: '12px a', color: 'black', lineHeight: 14, align: 'center', box: { x: 0, y: 0, w: 100, h: 20 }, clip: null };
  paintScene(ctx, scene([plate({ text })]), new Map());
  assert.deepEqual(ctx.calls.find(([name]) => name === 'fillText').slice(1, 3), ['hi', 50]);
});

test('uploaded images are drawn only when decoded and fitted with the card object-fit', () => {
  const ctx = recorder();
  const decoded = { width: 100, height: 100 };
  const withImage = plate({ image: { url: 'https://retroroom.party/a.png', fit: 'contain' } });
  const missing = plate({ image: { url: 'https://retroroom.party/missing.png', fit: 'cover' } });
  paintScene(ctx, scene([withImage, missing]), new Map([['https://retroroom.party/a.png', decoded]]));
  const draws = ctx.calls.filter(([name]) => name === 'drawImage');
  assert.deepEqual(draws, [['drawImage', decoded, 20, 20, 80, 80]]);
});

test('grid dots sit at the centre of each background tile and only visible dots are drawn', () => {
  const ctx = recorder();
  // Tiles start at the background offset (5, 0); a dot is the centre of a 20px tile.
  paintScene(ctx, scene([], { width: 50, height: 30, grid: { color: 'gray', pitch: 20, offsetX: 5, offsetY: 0, radius: 1 } }), new Map());
  const dots = ctx.calls.filter(([name]) => name === 'arc').map(([, x, y]) => [x, y]);
  assert.deepEqual(dots, [[15, 10], [35, 10], [15, 30], [35, 30]]);
});

test('plate opacity is applied while painting and restored afterwards', () => {
  const ctx = recorder();
  paintScene(ctx, scene([plate({ alpha: 0.5, background: 'red' })]), new Map());
  assert.ok(ctx.calls.some(([name, value]) => name === 'set:globalAlpha' && value === 0.5));
  assert.equal(ctx.calls.filter(([name]) => name === 'save').length, ctx.calls.filter(([name]) => name === 'restore').length);
});

test('no-wrap text stays on one line and sub-pixel rounding never pushes a word to a new line', () => {
  const ctx = recorder();
  const noWrap = { content: 'Retro team A', font: '20px a', color: 'black', lineHeight: 30, align: 'left',
    box: { x: 0, y: 0, w: 50, h: 30 }, clip: null, wrap: false };
  paintScene(ctx, scene([plate({ text: noWrap })]), new Map());
  assert.deepEqual(ctx.calls.filter(([name]) => name === 'fillText').map(([, line]) => line), ['Retro team A']);
  const rounding = recorder();
  rounding.measureText = text => ({ width: [...text].length * CHAR_WIDTH_PX + 0.04 });
  const exact = { ...noWrap, content: 'abcde', box: { x: 0, y: 0, w: 50, h: 30 }, wrap: true };
  paintScene(rounding, scene([plate({ text: exact })]), new Map());
  assert.deepEqual(rounding.calls.filter(([name]) => name === 'fillText').map(([, line]) => line), ['abcde']);
});

test('dashed and dotted borders keep their pattern', () => {
  const ctx = recorder();
  ctx.setLineDash = pattern => ctx.calls.push(['setLineDash', pattern]);
  paintScene(ctx, scene([plate({ border: { width: 2, color: 'blue', style: 'dashed' } }),
    plate({ border: { width: 2, color: 'blue', style: 'solid' } })]), new Map());
  const dashes = ctx.calls.filter(([name]) => name === 'setLineDash').map(([, pattern]) => pattern);
  assert.equal(dashes.length, 1, 'solid borders draw a plain line');
  assert.ok(dashes[0].length > 0 && dashes[0].every(length => length > 0));
});
