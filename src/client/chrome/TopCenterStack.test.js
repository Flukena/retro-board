import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('TopCenterStack preserves presentation and event contracts', async () => {
  await withChromeModule('/src/client/chrome/TopCenterStack.jsx', async ({ TopCenterStack }) => {
    const markup = renderToStaticMarkup(React.createElement(TopCenterStack, {
      follow: { name: 'Alice', hue: 40, waiting: true },
      timers: [{ zoneId: 'z', title: 'Vote', label: '00:30', remainingMs: 30000 }],
    }));
    assert.ok(markup.indexOf('role="status"') < markup.indexOf('rb-timer-dock'));
    assert.match(markup, /Alice/);
    assert.match(markup, /aria-label=/);
  });
});

test('TopCenterStack renders nothing when all room results are dismissed', async () => {
  await withChromeModule('/src/client/chrome/TopCenterStack.jsx', ({ TopCenterStack }) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const key = JSON.stringify(['room', 'zone:1']);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { getItem: () => JSON.stringify([key]) } } });
    try {
      const board = { items: [{ id: 'zone', type: 'zone', voteResults: { resultId: 'zone:1' } }] };
      const html = renderToStaticMarkup(React.createElement(TopCenterStack, { board, roomHandle: 'room', timers: [] }));
      assert.equal(html, '');
      const follow = renderToStaticMarkup(React.createElement(TopCenterStack, {
        board, roomHandle: 'room', timers: [], follow: { name: 'Still following', hue: 40 },
      }));
      assert.match(follow, /Still following/);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else delete globalThis.window;
    }
  });
});
