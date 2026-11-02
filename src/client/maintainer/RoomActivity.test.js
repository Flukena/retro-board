import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('room age, session connection and unknown legacy dates render in both languages', async () => {
  await withChromeModule('/src/client/maintainer/RoomActivity.jsx', ({RoomActivity}, {setLang, t}) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const room = { createdAt: 1000, lastSessionAt: 2000, lastActiveAt: 3000, connections: 1 };
      const html = renderToStaticMarkup(React.createElement(RoomActivity, { room, now: 86_401_000 }));
      assert.ok(html.includes(t('maintainer.days', {n: 1})));
      assert.ok(html.includes(t('maintainer.connectedNow')));
      assert.ok(html.includes(t('maintainer.lastSessionAt')));
      const legacy = renderToStaticMarkup(React.createElement(RoomActivity, {room: {connections: 0}, now: 5000}));
      assert.ok(legacy.includes(t('maintainer.timeUnknown')));
      assert.doesNotMatch(html + legacy, /Invalid Date|maintainer\./);
    }
  });
});
