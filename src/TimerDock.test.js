import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('TimerDock preserves presentation and event contracts', async () => {
  await withChromeModule('/src/TimerDock.jsx', async ({ TimerDock }) => {
    const timer = { zoneId: 'z', title: 'Vote', label: '00:30', remainingMs: 30000, voteLimit: 3 };
    const props = { timer, votesUsed: 1, isAdmin: false };
    const viewer = renderToStaticMarkup(React.createElement(TimerDock, props));
    assert.doesNotMatch(viewer, /title="\+1m"|rb-btn--danger/);
    const admin = renderToStaticMarkup(React.createElement(TimerDock, { ...props, isAdmin: true }));
    assert.match(admin, /title="\+1m"/);
    assert.doesNotMatch(admin, /\{n\}/);
    assert.match(admin, /rb-btn--danger/);
  });
});
