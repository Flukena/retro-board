import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('Draw has an accessible compact toolbar in both languages, has no Done button and keeps cancellation available', async () => {
  await withChromeModule('/src/client/board/DrawingTool.jsx', ({ DrawingTool }, { t, setLang, getLang }) => {
    const previous = getLang();
    try {
      for (const lang of ['th', 'en']) {
        setLang(lang);
        const markup = renderToStaticMarkup(React.createElement(DrawingTool, { active: true, editingAllowed: true, lang }));
        for (const key of ['draw.canvas', 'draw.color', 'draw.width', 'draw.cancel', 'draw.hint']) {
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
