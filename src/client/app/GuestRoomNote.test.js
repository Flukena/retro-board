import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const MODULE = '/src/client/app/GuestRoomNote.jsx';
const ACCOUNT = { name: 'Ada', email: 'ada@example.com', plan: 'free' };

test('the guest note shows when signed out, with the retention hours, in Thai and English', async () => {
  await withChromeModule(MODULE, ({ GuestRoomNoteView }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      for (const status of ['signed-out']) {
        const html = renderToStaticMarkup(React.createElement(GuestRoomNoteView, { session: { status } }));
        assert.ok(html.includes(t('landing.guestNote', { hours: 24 })), `${lang} ${status}`);
        assert.ok(html.includes('24'), `${lang} ${status}`);
      }
    }
  });
});

test('the guest note stays hidden unless the account is definitely signed out', async () => {
  await withChromeModule(MODULE, ({ GuestRoomNoteView }) => {
    for (const session of [null, { status: 'signed-in', account: ACCOUNT }, { status: 'unavailable' }, { status: 'disabled' }]) {
      assert.equal(renderToStaticMarkup(React.createElement(GuestRoomNoteView, { session })), '', JSON.stringify(session));
    }
  });
});

test('the landing page does not flash the guest note before the account is known', async () => {
  await withChromeModule('/src/client/app/Landing.jsx', ({ default: Landing }, { t, setLang }) => {
    setLang('en');
    const html = renderToStaticMarkup(React.createElement(Landing));
    assert.ok(!html.includes(t('landing.guestNote', { hours: 24 })));
  });
});
