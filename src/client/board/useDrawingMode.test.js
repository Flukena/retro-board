import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
test('changing tools waits for the drawing checkpoint and retains its mode after a failed save', async () => {
  await withChromeModule('/src/client/board/useDrawingMode.js', async ({ useDrawingMode }) => {
    let mode;
    function Harness() { mode = useDrawingMode(); return null; }
    renderToStaticMarkup(React.createElement(Harness));
    const requests = [];
    mode[1]('draw'); mode[2].current = () => new Promise(done => requests.push(done));
    mode[1]('select'); mode[1]('zone');
    assert.equal(requests.length, 2, 'Cancel must be able to replace an exit waiting for a failed upload');
    requests[0](false); requests[1](true); await new Promise(done => setImmediate(done));
    mode[1](current => { assert.equal(current, 'zone'); return null; });
  });
});
