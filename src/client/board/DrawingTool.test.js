import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { FONT_COLORS } from '../ui/palette.js';
import { DRAWING_WIDTHS_SCREEN_PX } from '../../domain/freehand-drawing.js';

const buttonsIn = (markup, groupLabel) => {
  const start = markup.indexOf(`aria-label="${groupLabel}"`);
  assert.ok(start >= 0, `missing group ${groupLabel}`);
  const group = markup.slice(start, markup.indexOf('</div>', start));
  return group.match(/<button[^>]*>/g) ?? [];
};

test('Draw has an accessible compact toolbar in both languages, has no Done button and keeps cancellation available', async () => {
  await withChromeModule('/src/client/board/DrawingTool.jsx', ({ DrawingTool }, { t, setLang, getLang }) => {
    const previous = getLang();
    try {
      for (const lang of ['th', 'en']) {
        setLang(lang);
        const markup = renderToStaticMarkup(React.createElement(DrawingTool, { active: true, editingAllowed: true, lang }));
        for (const key of ['draw.canvas', 'draw.color', 'draw.width', 'draw.cancel']) {
          assert.notEqual(t(key), key); assert.ok(markup.includes(t(key)));
        }
        assert.doesNotMatch(markup, /role="dialog"/);
        const save = markup.match(/<button[^>]*>[\s\S]*?<\/button>/g).find(button => button.includes('lucide-check'));
        assert.equal(save, undefined, 'Automatic drawing must not display a Done button');
        assert.ok(!markup.includes('>Done<') && !markup.includes('>เสร็จสิ้น<'));
        const cancel = markup.match(new RegExp(`<button[^>]*aria-label="${t('draw.cancel')}"[^>]*>`))?.[0];
        assert.ok(cancel); assert.doesNotMatch(cancel, /disabled/);
        assert.equal(renderToStaticMarkup(React.createElement(DrawingTool, { active: false, lang })), '');
      }
    } finally { setLang(previous); }
  });
});

test('Draw shows every colour and stroke size as one-tap buttons instead of dropdowns', async () => {
  await withChromeModule('/src/client/board/DrawingTool.jsx', ({ DrawingTool }, { t }) => {
    const markup = renderToStaticMarkup(React.createElement(DrawingTool, { active: true, editingAllowed: true }));
    assert.doesNotMatch(markup, /<select/);
    const colours = buttonsIn(markup, t('draw.color'));
    assert.equal(colours.length, FONT_COLORS.length);
    for (const colour of FONT_COLORS) assert.ok(colours.some(b => b.includes(`aria-label="${t(`font.color.${colour.label}`)}"`)));
    assert.equal(colours.filter(b => b.includes('aria-pressed="true"')).length, 1);
    const sizes = buttonsIn(markup, t('draw.width'));
    assert.equal(sizes.length, DRAWING_WIDTHS_SCREEN_PX.length);
    assert.equal(sizes.filter(b => b.includes('aria-pressed="true"')).length, 1);
  });
});

test('Draw keeps the status line empty while idle so no permanent hint covers the board', async () => {
  await withChromeModule('/src/client/board/DrawingTool.jsx', ({ DrawingTool }) => {
    const markup = renderToStaticMarkup(React.createElement(DrawingTool, { active: true, editingAllowed: true }));
    assert.doesNotMatch(markup, /rb-drawing-status/);
  });
});
