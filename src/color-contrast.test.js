import test from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, relativeLuminance, contrastRatio, compositeOver } from './color-contrast.js';

test('parses supported hex and whitespace-tolerant functional colors', () => {
  assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor(' #AABBCC '), parseColor('#abc'));
  assert.deepEqual(parseColor('rgb( 0, 127, 255 )'), { r: 0, g: 127, b: 255, a: 1 });
  assert.deepEqual(parseColor('rgba( 0, 127, 255, .5 )'), { r: 0, g: 127, b: 255, a: 0.5 });
});

test('WCAG luminance and contrast satisfy endpoints, symmetry and boundary pair', () => {
  assert.equal(relativeLuminance(parseColor('#000')), 0);
  assert.equal(relativeLuminance(parseColor('#fff')), 1);
  assert.equal(contrastRatio('#000', '#fff'), 21);
  assert.equal(contrastRatio('#abc', '#abc'), 1);
  assert.equal(contrastRatio('#123456', '#abcdef'), contrastRatio('#abcdef', '#123456'));
  assert.ok(contrastRatio('#777777', '#ffffff') < 4.5);
  assert.ok(contrastRatio('#767676', '#ffffff') >= 4.5);
});

test('source-over compositing preserves endpoints and blends half alpha', () => {
  const blended = compositeOver('rgba(0,0,0,0.5)', '#fff');
  for (const channel of [blended.r, blended.g, blended.b]) assert.ok(Math.abs(channel - 127.5) <= 0.5);
  assert.equal(blended.a, 1);
  assert.deepEqual(compositeOver('rgba(0,0,0,0)', '#abc'), parseColor('#abc'));
  assert.deepEqual(compositeOver('#123', '#abc'), parseColor('#123'));
  assert.equal(contrastRatio(parseColor('#000'), parseColor('#fff')), 21);
});

test('invalid syntax, ranges and translucent contrast/background throw', () => {
  for (const invalid of ['red', '#ab', '#gggggg', '#abcd', 'rgb(256,0,0)', 'rgb(-1,0,0)', 'rgba(0,0,0,2)', 'rgb(0,0,0,1)', null]) {
    assert.throws(() => parseColor(invalid), Error);
  }
  assert.throws(() => contrastRatio('rgba(0,0,0,.5)', '#fff'), Error);
  assert.throws(() => contrastRatio('#fff', 'rgba(0,0,0,.5)'), Error);
  assert.throws(() => compositeOver('#fff', 'rgba(0,0,0,.5)'), Error);
});
