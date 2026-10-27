import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('maintainer restores its session before showing the login form in both languages', async () => {
  await withChromeModule('/src/client/maintainer/Maintainer.jsx', ({ Maintainer }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(Maintainer));
      assert.ok(html.includes(t('maintainer.loading')));
      assert.match(html, /role="status"/);
      assert.doesNotMatch(html, /type="password"/);
      assert.doesNotMatch(html, /maintainer\.\w+|<table/);
    }
  });
});
