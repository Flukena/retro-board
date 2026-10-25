import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

function buttonClasses(markup, attribute) {
  const button = [...markup.matchAll(/<button\b[^>]*>/g)]
    .map((match) => match[0]).find((tag) => tag.includes(attribute));
  assert.ok(button, `Missing button with ${attribute}`);
  return button.match(/class="([^"]*)"/)[1].split(/\s+/);
}

test('top bar preserves undo, admin, claim and follow contracts', async (context) => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  try {
    const { TopBar, TopBarButton } = await server.ssrLoadModule('/src/client/chrome/TopBar.jsx');
    const { PlayersPopover } = await server.ssrLoadModule('/src/client/chrome/TopBarPopovers.jsx');
    const props = {
      players: [],
      themePref: 'auto',
      lang: 'en',
      admin: { name: 'Fallback', isOnline: false },
    };
    const markup = renderToStaticMarkup(React.createElement(TopBar, props));
    assert.match(markup, /Fallback/);
    const own = renderToStaticMarkup(React.createElement(TopBar, {
      ...props, isAdmin: true, admin: { name: 'Owner', isOnline: true }, userName: 'Owner',
    }));
    assert.doesNotMatch(own, /rb-topbar-admin/);
    const titled = renderToStaticMarkup(React.createElement(TopBar, { ...props, code: 'Room1234', title: 'Sprint 42 Retro' }));
    assert.match(titled, /<span class="rb-topbar-title" title="Sprint 42 Retro">Sprint 42 Retro<\/span>/);
    assert.doesNotMatch(markup, /rb-topbar-title/);
    assert.match(markup, /rb-topbar-admin/);
    assert.doesNotMatch(markup, /data-action="claim"/);
    const claim = renderToStaticMarkup(React.createElement(TopBar, {
      ...props,
      canClaim: true,
    }));
    assert.match(claim, /data-action="claim"/);
    let clicks = 0;
    const undo = TopBarButton({
      enabled: false,
      onClick: () => { clicks += 1; },
    });
    const renderedUndo = renderToStaticMarkup(undo);
    assert.match(renderedUndo, /aria-disabled="true"/);
    assert.doesNotMatch(renderedUndo, /\sdisabled=/);
    undo.props.onClick();
    assert.equal(clicks, 1);
    const players = renderToStaticMarkup(React.createElement(PlayersPopover, {
      players: [{ userId: 'other', name: 'Other', isFollowing: true, used: 1, limit: 3 }],
      onClose() {},
      onFollow() {},
      onStopFollowing() {},
    }));
    assert.match(players, /aria-pressed="true"/);
    await context.test('F1 claim button uses PRIMARY regardless of stylesheet order', () => {
      assert.ok(
        buttonClasses(claim, 'data-action="claim"').includes('rb-btn--primary'),
        'claim button must render PRIMARY class',
      );
    });
    await context.test('F1 followed player button uses PRIMARY regardless of stylesheet order', () => {
      assert.ok(
        buttonClasses(players, 'aria-pressed="true"').includes('rb-btn--primary'),
        'following button must render PRIMARY class',
      );
    });
    await context.test('F1 presence trigger is independent of Button styles', () => {
      assert.equal(
        buttonClasses(markup, 'rb-topbar-presence').includes('rb-btn'),
        false,
        'presence trigger must not render rb-btn class',
      );
    });
    for (const file of ['./TopBar.jsx', './TopBarPopovers.jsx', '../ui/Avatar.jsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const signature of source.matchAll(/function \w+\(\{([^}]+)\}/g)) {
        assert.doesNotMatch(
          signature[1],
          /\b(?:board|setBoard)\b/,
          'presentational components must not read board or setBoard',
        );
      }
    }
  } finally {
    await server.close();
  }
});
