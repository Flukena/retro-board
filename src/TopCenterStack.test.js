import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('TopCenterStack preserves presentation and event contracts', async () => {
  await withChromeModule('/src/TopCenterStack.jsx', async ({ TopCenterStack }) => {
    const markup = renderToStaticMarkup(React.createElement(TopCenterStack, {
      follow: { name: 'Alice', hue: 40, waiting: true },
      timers: [{ zoneId: 'z', title: 'Vote', label: '00:30', remainingMs: 30000 }],
    }));
    assert.ok(markup.indexOf('role="status"') < markup.indexOf('rb-timer-dock'));
    assert.match(markup, /Alice/);
    assert.match(markup, /aria-label=/);
  });
});
