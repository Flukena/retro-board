import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2);
const room = (createdAt, extra = {}) => ({ handle: 'A'.repeat(32), createdAt, lastSessionAt: null, lastActiveAt: null, connections: 0, resident: false, ...extra });
const ROOMS = [room(NOW - 90 * DAY_MS), room(NOW - 70 * DAY_MS), room(NOW - 3 * DAY_MS), room(null), room(NOW - 90 * DAY_MS, { connections: 1 })];
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('idle panel previews the relay rule and asks before deleting, in Thai and English', async () => {
  await withChromeModule('/src/client/maintainer/IdleRooms.jsx', ({ IdleRooms, IdleRoomsView, IDLE_STEP }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const ready = render(IdleRooms, { rooms: ROOMS, now: NOW, publicWall: false });
      assert.ok(ready.includes(t('maintainer.idle.summary', { n: 2, unknown: 1, days: 60 })));
      assert.ok(ready.includes(t('maintainer.idle.delete', { n: 2 })));
      assert.ok(!ready.includes(t('maintainer.idle.warning')), 'nothing is deleted on the first click');
      const confirm = render(IdleRoomsView, { idle: 2, unknownAge: 1, step: IDLE_STEP.CONFIRM });
      assert.ok(confirm.includes(t('maintainer.idle.warning')));
      assert.ok(confirm.includes(t('maintainer.idle.confirm', { n: 2 })));
      assert.ok(confirm.includes(t('maintainer.idle.cancel')));
      const done = render(IdleRoomsView, { idle: 0, unknownAge: 1, result: { retired: 2, files: 5 } });
      assert.ok(done.includes(t('maintainer.idle.done', { n: 2, files: 5 })));
      assert.ok(done.includes(t('maintainer.idle.none', { days: 60 })));
      assert.ok(!done.includes('<button'));
      assert.doesNotMatch(ready + confirm + done, /maintainer\.\w+/);
    }
  });
});

test('the Public Wall console shows no idle-room action', async () => {
  await withChromeModule('/src/client/maintainer/IdleRooms.jsx', ({ IdleRooms }) => {
    assert.equal(render(IdleRooms, { rooms: ROOMS, now: NOW, publicWall: true }), '');
  });
});
