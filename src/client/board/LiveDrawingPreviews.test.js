import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
test('room-less server rendering has no bitmap, browser or socket side effects', async () => {
  await withChromeModule('/src/client/board/LiveDrawingPreviews.jsx', ({ LiveDrawingPreviews }) => {
    assert.equal(renderToStaticMarkup(React.createElement(LiveDrawingPreviews)), '');
  });
});
