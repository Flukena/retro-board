import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('boundary preserves a healthy board and offers translated reload after a render error', async () => {
  await withChromeModule('/src/BoardErrorBoundary.jsx', ({ BoardErrorBoundary }, { setLang, t }) => {
    const child = React.createElement('p', null, 'Healthy board');
    const boundary = new BoardErrorBoundary({ children: child });
    assert.equal(boundary.render(), child);
    boundary.state = BoardErrorBoundary.getDerivedStateFromError(new Error('broken child'));
    for (const language of ['en', 'th']) {
      setLang(language);
      const markup = renderToStaticMarkup(boundary.render());
      assert.ok(markup.includes(t('resilience.error.title')));
      assert.ok(markup.includes(t('resilience.reload')));
      assert.ok(markup.includes('role="alert"'));
      assert.ok(!markup.includes('Healthy board'));
    }
  });
});
