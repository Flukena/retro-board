import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withSsrModule } from '../../test-support/ssr-load.js';

const SUBJECT = '/src/client/session/RemoteCursorLayer.jsx';
test('remote cursor layer preserves world data, render-time viewport reads and escaped names', async () => {
  await withSsrModule(SUBJECT, ({ RemoteCursorLayer }) => {
    const viewportRef = { current: { x: 10, y: 20, zoom: 2 } };
    const cursorLayerRef = { current: null };
    const playerCursors = [{ userId: 'peer', name: '<Peer>', cursor: { x: 30, y: 40 } }];
    const render = (players = playerCursors) => renderToStaticMarkup(React.createElement(RemoteCursorLayer, { viewportRef, cursorLayerRef, playerCursors: players }));
    const html = render();
    assert.match(html, /width="23" height="23"/);
    assert.match(html, /stroke-width="2.6"/);
    assert.match(html, /transform 18ms linear/);
    assert.match(html, /margin-left:-2px;margin-top:17px;max-width:160px/);
    assert.match(html, /font-size:13px;line-height:1.15;font-weight:700/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /position:fixed;inset:0/);
    assert.match(html, /data-cursor-x="30" data-cursor-y="40"/);
    assert.match(html, /translate3d\(70px, 100px, 0\)/);
    assert.match(html, /&lt;Peer&gt;/);
    assert.doesNotMatch(html, /<Peer>/);
    viewportRef.current = { x: 100, y: -20, zoom: 1 };
    assert.match(render(), /translate3d\(130px, 20px, 0\)/);
    assert.doesNotMatch(render([]), /rb-player-cursor/);
  });
});
