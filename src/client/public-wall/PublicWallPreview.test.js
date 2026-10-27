import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { PALETTE } from '../ui/palette.js';
import { publicWallSnapshot } from '../../server/public-wall-snapshot.js';
import { publicWallView } from './public-wall-view.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('hero keeps the masthead and lower content in its scroll pane and a slim Public dock outside it', async () => {
  await withChromeModule('/src/client/public-wall/PublicWallPreview.jsx', ({ PublicWallPreviewContent }, { setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(PublicWallPreviewContent, {
        variant: 'hero', masthead: React.createElement('header', null, 'Brand'),
        belowHero: React.createElement('section', { id: 'landing-recents' }, 'Recent workspace'),
      }, React.createElement('h1', { id: 'landing-hero-title' }, 'Team space')));
      assert.match(html, /class="rb-landing__scroll"/);
      assert.match(html, /aria-labelledby="landing-hero-title"><header>Brand<\/header><div class="rb-landing__hero-layout">/);
      assert.match(html, /<\/section><section id="landing-recents">Recent workspace<\/section><\/div><div class="rb-landing__public-bar">/);
      assert.doesNotMatch(html, /rb-landing__scroll-cue/);
      // The empty wall window and the dock both lead into the room.
      assert.equal((html.match(/href="\/public"/g) || []).length, 2);
    }
  });
});

test('hero shows the live Public Wall beside the start panel so visitors see it before joining', async () => {
  await withChromeModule('/src/client/public-wall/PublicWallPreview.jsx', ({ PublicWallPreviewContent }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(PublicWallPreviewContent, {
        variant: 'hero', snapshot: { items: [{ id: 'real-note', type: 'sticky', x: 0, y: 0, w: 280, h: 240, color: 3, text: 'From the actual room' }] },
      }, React.createElement('h1', { id: 'landing-hero-title' }, 'Team space')));
      const layout = html.slice(html.indexOf('rb-landing__hero-layout'), html.indexOf('rb-landing__public-bar'));
      assert.match(layout, /<h1 id="landing-hero-title">Team space<\/h1>/);
      const wall = layout.slice(layout.indexOf('class="rb-landing__wall"'));
      assert.match(wall, /aria-labelledby="landing-wall-title"/);
      assert.ok(wall.includes(`<h2 id="landing-wall-title">${t('public.title')}</h2>`));
      assert.ok(wall.includes(t('public.live')));
      assert.match(wall, /From the actual room/);
      assert.doesNotMatch(wall, /aria-hidden="true"[^>]*class="rb-public-wall__preview"|class="rb-public-wall__preview"[^>]*aria-hidden/);
      assert.match(wall, new RegExp(`<a class="rb-public-wall__preview" href="/public" aria-label="${t('public.join')}"`));
      assert.match(html, /<a class="rb-btn rb-public-wall__join" href="\/public"/);
    }
  });
});

test('empty and unavailable Public backgrounds preserve the landing actions and explain their state', async () => {
  await withChromeModule('/src/client/public-wall/PublicWallPreview.jsx', ({ PublicWallPreviewContent }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      for (const [status, key] of [['ready', 'public.empty'], ['unavailable', 'public.unavailable']]) {
        const html = renderToStaticMarkup(React.createElement(PublicWallPreviewContent, { variant: 'hero', status },
          React.createElement('button', null, t('landing.create.btn'))));
        assert.ok(html.includes(t(key))); assert.match(html, /<button/); assert.match(html, /href="\/public"/);
        assert.doesNotMatch(html, /<img/);
      }
    }
  });
});

test('public preview renders escaped read-only items and a localized join link', async () => {
  await withChromeModule('/src/client/public-wall/PublicWallPreview.jsx', ({ PublicWallPreviewContent }, { t, setLang }) => {
    for (const lang of ['en', 'th']) {
      setLang(lang);
      const markup = renderToStaticMarkup(React.createElement(PublicWallPreviewContent, {
        snapshot: { items: [{ id: 'a', type: 'text', x: -10, y: 0, text: '<script>alert(1)</script>' }] },
      }));
      assert.match(markup, /href="\/public"/);
      assert.equal(markup.includes(t('public.join')), true);
      assert.doesNotMatch(markup, /<script>|contenteditable|<textarea|<input/);
      assert.match(markup, /&lt;script&gt;/);
    }
  });
});

test('real public document preserves palette colors through snapshot, view and preview without leaking private content', async () => {
  const doc = new Y.Doc();
  try {
    for (let color = 0; color < PALETTE.length; color += 1) {
      const id = `zone-${color}`;
      doc.getMap('items').set(id, new Y.Map(Object.entries({ type: 'zone', x: color * 300,
        y: 0, w: 280, h: 300, color, title: new Y.Text(`Zone ${color}`), authorId: 'private-author' })));
    }
    doc.getMap('items').set('sticky', new Y.Map(Object.entries({ type: 'sticky', x: 20, y: 60,
      color: 3, text: new Y.Text('Visible sticky') })));
    doc.getMap('items').set('hidden', new Y.Map(Object.entries({ type: 'sticky', x: 30, y: 90,
      color: 2, private: true, text: new Y.Text('PRIVATE-CONTENT') })));
    doc.getMap('items').set('invalid', new Y.Map(Object.entries({ type: 'sticky', x: 40, y: 120,
      color: 'url(INVALID-COLOR)', text: new Y.Text('Safe text') })));
    const snapshot = publicWallSnapshot(doc);
    assert.equal(snapshot.items.find((item) => item.id === 'zone-4').color, 4);
    assert.equal(snapshot.items.find((item) => item.id === 'invalid').color, undefined);
    const view = publicWallView(snapshot);
    assert.equal(view.items.find((item) => item.id === 'zone-4').color, 4);
    assert.equal(view.items.find((item) => item.id === 'invalid').color, 0);
    await withChromeModule('/src/client/public-wall/PublicWallPreview.jsx', ({ PublicWallPreviewContent }) => {
      const html = renderToStaticMarkup(React.createElement(PublicWallPreviewContent, { snapshot }));
      for (const color of PALETTE) {
        assert.ok(html.includes(`--rb-zone-bg:${color.bg}`));
        assert.ok(html.includes(`--rb-zone-rgb:${color.rgb}`));
      }
      assert.ok(html.includes(`--rb-card-bg:${PALETTE[3].bg}`));
      assert.match(html, /Zone 4|Visible sticky/);
      assert.doesNotMatch(html, /PRIVATE-CONTENT|private-author|INVALID-COLOR/);
    });
  } finally {
    doc.destroy();
  }
});

test('ready snapshots display a PNG image link while keeping an unhidden offscreen actual scene mounted', async () => {
  await withChromeModule('/src/client/public-wall/PublicWallPreview.jsx', ({ PublicWallPreviewFrame }, { t, setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const props = { snapshot: { items: [{ id: 'zone', type: 'zone', x: 0, y: 0,
        w: 1200, h: 800, color: 3, text: 'Actual zone' }] }, lang };
      const ready = renderToStaticMarkup(React.createElement(PublicWallPreviewFrame, {
        ...props, imageUrl: 'blob:board-snapshot',
      }));
      assert.match(ready, /<img class="rb-public-wall__image" src="blob:board-snapshot"/);
      assert.ok(ready.includes(`alt="${t('public.title')}"`));
      assert.match(ready, /rb-public-wall__capture--offscreen/);
      assert.match(ready, /class="rb-zone"/);
      assert.match(ready, /href="\/public"/);
      const fallback = renderToStaticMarkup(React.createElement(PublicWallPreviewFrame, props));
      assert.match(fallback, /class="rb-zone"/);
      assert.doesNotMatch(fallback, /<img|capture--offscreen|data-preview-kind|foreignObject/);
    }
    const css = readFileSync(new URL('../board/public-wall.css', import.meta.url), 'utf8');
    const offscreen = css.match(/\.rb-public-wall__capture--offscreen\s*\{([^}]*)\}/)[1];
    assert.doesNotMatch(offscreen, /opacity|visibility|display/);
    assert.match(offscreen, /left:\s*calc\(-1/);
    assert.match(css, /\.rb-public-wall__scene\s*\{[^}]*pointer-events:\s*none/);
  });
});
