import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('banner renders outage and unsynced copy in both languages', async () => {
  await withChromeModule('/src/client/session/SyncBanner.jsx', ({ SyncStatusBanner }, { setLang, t }) => {
    for (const language of ['th', 'en']) {
      setLang(language);
      const markup = renderToStaticMarkup(React.createElement(SyncStatusBanner, {
        state: { status: 'disconnected', hasUnsyncedLocalChanges: true },
      }));
      assert.ok(markup.includes(t('resilience.disconnected')));
      assert.ok(markup.includes(t('resilience.pending')));
      assert.ok(markup.includes('role="status"'));
      const healthy = renderToStaticMarkup(React.createElement(SyncStatusBanner, {
        state: { status: 'connected', hasUnsyncedLocalChanges: false },
      }));
      assert.equal(healthy, '');
    }
    const lost = renderToStaticMarkup(React.createElement(SyncStatusBanner, {
      state: { status: 'session-lost', hasUnsyncedLocalChanges: false },
    }));
    assert.ok(lost.includes(t('resilience.reopen')));
  });
});
