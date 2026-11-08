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

const MAINTAINER_NOW = Date.UTC(2026, 10, 8);
const maintainerRoom = (handle, extra = {}) => ({
  handle, createdAt: null, lastSessionAt: null, lastActiveAt: null, trackedSinceAt: null, connections: 0, resident: false,
  blockedUntil: null, documentBytesUpperBound: null, uploadBytes: 0, uploadFiles: 0, collections: null, encrypted: false, ...extra,
});

test('an encrypted room shows the Encrypted badge and no room-open button, in every language', async () => {
  await withChromeModule('/src/client/maintainer/Maintainer.jsx', ({ Rooms }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(Rooms, {
        rooms: [maintainerRoom('E'.repeat(32), { encrypted: true }), maintainerRoom('P'.repeat(32))], now: MAINTAINER_NOW,
      }));
      assert.equal(html.split(`<span class="maintainer-badge">${t('maintainer.encrypted')}</span>`).length - 1, 1, 'one badge, only on the encrypted room');
      assert.ok(html.includes(t('maintainer.encryptedHint')));
      assert.equal(html.split(`>${t('maintainer.openRoom')}</button>`).length - 1, 1, 'the open button stays on the normal room only');
      assert.doesNotMatch(html, /maintainer\.\w+/);
    }
  });
});
