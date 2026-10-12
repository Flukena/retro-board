import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';
import { PALETTE } from './palette.js';

test('thumbnail SVG hides decorative rectangles and uses palette fill/border including fallback', async () => {
  await withChromeModule('/src/TemplateThumbnail.jsx', ({ TemplateThumbnail }) => {
    const zones = [2, 999].map((color, index) => ({ x: index * 100, y: 0, w: 100, h: 80, color }));
    const html = renderToStaticMarkup(React.createElement(TemplateThumbnail, { zones }));
    assert.match(html, /<svg[^>]*aria-hidden="true"/);
    const rects = html.match(/<rect[^>]*>/g);
    assert.equal(rects.length, 2);
    for (const [index, color] of [2, 0].entries()) {
      assert.ok(rects[index].includes(`fill="${PALETTE[color].bg}"`));
      assert.ok(rects[index].includes(`stroke="${PALETTE[color].border}"`));
    }
    const empty = renderToStaticMarkup(React.createElement(TemplateThumbnail, { zones: [] }));
    assert.doesNotMatch(empty, /<rect/);
  });
});


const svgAttributes = (tag) => Object.fromEntries(
  [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]),
);

test('thumbnail SVG rectangles have positive numeric dimensions and fit inside the viewBox', async () => {
  await withChromeModule('/src/TemplateThumbnail.jsx', ({ TemplateThumbnail }) => {
    const zones = [
      { x: -200, y: -100, w: 800, h: 400, color: 2 },
      { x: -120, y: -50, w: 120, h: 100, color: 1 },
      { x: 700, y: 300, w: 200, h: 100, color: 0 },
    ];
    const html = renderToStaticMarkup(React.createElement(TemplateThumbnail, { zones }));
    const svg = svgAttributes(html.match(/<svg[^>]*>/)[0]);
    const [boxX, boxY, boxWidth, boxHeight] = svg.viewBox.split(/\s+/).map(Number);
    const rects = [...html.matchAll(/<rect[^>]*>/g)].map(([tag]) => svgAttributes(tag));
    assert.equal(rects.length, zones.length);
    for (const rect of rects) {
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((name) => Number(rect[name]));
      assert.ok(Number.isFinite(width) && width > 0, 'rect width must be numeric and positive');
      assert.ok(Number.isFinite(height) && height > 0, 'rect height must be numeric and positive');
      assert.ok(Number.isFinite(x) && x >= boxX);
      assert.ok(Number.isFinite(y) && y >= boxY);
      assert.ok(x + width <= boxX + boxWidth);
      assert.ok(y + height <= boxY + boxHeight);
      assert.equal(rect.w, undefined);
      assert.equal(rect.h, undefined);
    }
  });
});
