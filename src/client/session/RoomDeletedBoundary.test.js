import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const MODULE = '/src/client/session/RoomDeletedBoundary.jsx';
const LANGUAGES = ['th', 'en'];
const CODE = 'Ab3dEf7h';
const TOKEN = 'tok12345tok12345';
// Stand-ins for the three private room views main.jsx wraps; the boundary never looks inside them.
const VIEWS = Object.freeze([
  { kind: 'board', marker: 'plain-board-view', titleKey: 'roomDeleted.title.board' },
  { kind: 'board', marker: 'locked-board-view', titleKey: 'roomDeleted.title.board' },
  { kind: 'poker', marker: 'poker-view', titleKey: 'roomDeleted.title.poker' },
]);
const noop = () => {};

const render = ({ default: RoomDeletedBoundary }, { kind, marker }, roomDeleted) => renderToStaticMarkup(
  React.createElement(RoomDeletedBoundary, { code: CODE, token: TOKEN, kind, roomDeleted, forget: noop },
    React.createElement('div', null, marker)),
);

test('a live room renders its own view', async () => {
  await withChromeModule(MODULE, async (mod) => {
    const { createRoomDeletedState } = await import('./room-deleted.js');
    for (const view of VIEWS) assert.ok(render(mod, view, createRoomDeletedState()).includes(view.marker));
  });
});

test('a deleted room replaces the plain board, the locked board and Poker in Thai and English', async () => {
  await withChromeModule(MODULE, async (mod, { t, setLang }) => {
    const { createRoomDeletedState } = await import('./room-deleted.js');
    const deleted = createRoomDeletedState();
    deleted.mark();
    for (const language of LANGUAGES) {
      setLang(language);
      for (const view of VIEWS) {
        const html = render(mod, view, deleted);
        assert.ok(!html.includes(view.marker), `${view.marker} is replaced`);
        assert.ok(html.includes(t(view.titleKey)));
        assert.ok(html.includes(t('roomDeleted.body')));
        const homeLinks = html.match(/<a [^>]*href="\/"[^>]*>/g) || [];
        assert.equal(homeLinks.length, 1, 'exactly one link home');
        assert.match(homeLinks[0], /class="rb-btn rb-btn--primary"/, 'the home link uses the primary button style');
        assert.doesNotMatch(html, /roomDeleted\./, 'every string is translated');
      }
    }
    setLang('en');
    assert.ok(render(mod, VIEWS[0], deleted).includes('This board was deleted'));
  });
});
