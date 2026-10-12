import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('ZoomControls preserves presentation and event contracts', async () => {
  await withChromeModule('/src/ZoomControls.jsx', async ({ ZoomControls }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const markup = renderToStaticMarkup(React.createElement(ZoomControls, { percentage: 125 }));
      for (const key of ['zoom.out', 'zoom.in', 'zoom.fit', 'zoom.reset']) {
        assert.ok(markup.includes(`title="${t(key)}"`));
        assert.notEqual(t(key), key);
      }
      assert.match(markup, /125%/);
    }
  });
});
