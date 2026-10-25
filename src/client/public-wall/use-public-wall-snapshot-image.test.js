import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('snapshot image hook starts without an image and performs no capture or fetch during server rendering', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('Server rendering must not request snapshot assets'); };
  try {
    await withChromeModule('/src/client/public-wall/use-public-wall-snapshot-image.js', ({ usePublicWallSnapshotImage }) => {
      function SnapshotStatus() {
        const state = usePublicWallSnapshotImage({ current: null }, 'initial snapshot', { items: [] });
        return React.createElement('span', { 'data-status': state.status }, state.imageUrl ?? 'No image yet');
      }
      assert.equal(renderToStaticMarkup(React.createElement(SnapshotStatus)),
        '<span data-status="loading">No image yet</span>');
      assert.equal(fetchCalls, 0);
    });
  } finally { globalThis.fetch = previousFetch; }
});
