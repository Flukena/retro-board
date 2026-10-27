import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('room entry explains collaborator access without embedding a capability in the room list', async () => {
  await withChromeModule('/src/client/maintainer/RoomAccess.jsx', ({RoomAccess}, {t,setLang}) => {
    for (const lang of ['th','en']) {
      setLang(lang);
      const html=renderToStaticMarkup(React.createElement(RoomAccess,{handle:'A'.repeat(32)}));
      assert.ok(html.includes(t('maintainer.openRoom')));
      assert.ok(html.includes(t('maintainer.joinHint')));
      assert.doesNotMatch(html,/href|\/b\/|maintainer\.\w+/);
    }
  });
});
