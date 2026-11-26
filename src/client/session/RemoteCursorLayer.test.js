import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withSsrModule } from '../../test-support/ssr-load.js';

const SUBJECT = '/src/client/session/RemoteCursorLayer.jsx';
test('the cursor camera clips to the viewport while each escaped peer label stays anchored in world coordinates', async () => {
  await withSsrModule(SUBJECT, ({ RemoteCursorLayer }) => {
    const cursorLayerRef = { current: null };
    const playerCursors = [{ userId: 'peer', name: '<Peer>', cursor: { x: 30, y: 40 } }];
    const render = (players = playerCursors) => renderToStaticMarkup(React.createElement(RemoteCursorLayer, {
      cursorLayerRef, playerCursors: players,
    }));
    const html = render();
    assert.match(html, /aria-hidden="true"[^>]*style="position:fixed;inset:0;[^";]*;overflow:hidden;pointer-events:none"/);
    assert.match(html, /class="rb-player-cursor-camera"[^>]*style="position:absolute;inset:0;transform-origin:0 0"/);
    const cursor = html.match(/<div class="rb-player-cursor"[^>]*>/)?.[0];
    assert.ok(cursor);
    assert.match(cursor, /data-cursor-x="30" data-cursor-y="40"/);
    assert.match(cursor, /translate:30px 40px;/);
    assert.match(cursor, /transform:scale\(var\(--rb-presence-world-scale, 1\)\);transform-origin:0 0;/);
    assert.match(cursor, /transition:translate 18ms linear/);
    assert.match(html, /width="23" height="23"/);
    assert.match(html, /stroke-width="2.6"/);
    assert.match(html, /margin-left:-2px;margin-top:17px;max-width:160px/);
    assert.match(html, /font-size:13px;line-height:1.15;font-weight:700/);
    assert.match(html, /&lt;Peer&gt;/);
    assert.doesNotMatch(html, /<Peer>/);
    assert.doesNotMatch(render([]), /class="rb-player-cursor"/);
  });
});
