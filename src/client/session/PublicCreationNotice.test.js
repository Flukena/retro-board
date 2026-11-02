import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('Public creation warnings explain cooldown and oversized selections in both languages', async () => {
  await withChromeModule('/src/client/session/PublicCreationNotice.jsx', ({ PublicCreationMessage }, { setLang, t }) => {
    for (const language of ['th', 'en']) {
      setLang(language);
      const wait = renderToStaticMarkup(React.createElement(PublicCreationMessage, { oversized: false, seconds: 12 }));
      assert.ok(wait.includes(t('public.creationLimit.wait', { seconds: 12 })));
      const batch = renderToStaticMarkup(React.createElement(PublicCreationMessage, { oversized: true, seconds: 1 }));
      assert.ok(batch.includes(t('public.creationLimit.batch')));
    }
  });
});
