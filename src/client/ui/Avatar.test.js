import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('avatar displays the name initial and preserves crown, ring and small modifiers', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  try {
    const { Avatar } = await server.ssrLoadModule('/src/client/ui/Avatar.jsx');
    const markup = renderToStaticMarkup(React.createElement(Avatar, { id: 'A', name: ' Alice', crown: true, ring: true, small: true }));
    assert.match(markup, /rb-avatar--small/);
    assert.match(markup, /rb-avatar--ring/);
    assert.match(markup, /rb-avatar__crown/);
    assert.match(markup, />A</);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(Avatar, { name: 'Bob' })), /rb-avatar__crown/);
  } finally { await server.close(); }
});
