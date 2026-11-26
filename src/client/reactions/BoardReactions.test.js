import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { BOARD_REACTIONS } from '../../domain/board-reactions.js';
import { reactionEntry } from './reaction-feed.js';

const LANGUAGES = ['th', 'en'];
const NOW_MS = 1_700_000_000_000;
const MOTION = Object.freeze({ reducedMotion: false, now: NOW_MS });
const escapeHtml = (text) => text.replaceAll('&', '&amp;').replaceAll("'", '&#x27;').replaceAll('"', '&quot;');
const fakeChannel = () => ({ sent: [], send(emoji) { this.sent.push(emoji); return true; }, cooldownMs: () => 0, subscribe: () => () => {} });
const buttonsOf = (element) => React.Children.toArray(element.props.children);

test('the reaction button is a compact add-reaction icon with a translated label in Thai and English', async () => {
  await withChromeModule('/src/client/reactions/ReactionPicker.jsx', ({ ReactionPicker }, { t, setLang }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(ReactionPicker, { channel: fakeChannel() }));
      assert.match(html, /class="rb-reaction-dock"/);
      const toggle = html.match(/<button[^>]*rb-reaction-toggle[^>]*>(.*?)<\/button>/)?.[0] ?? '';
      assert.match(toggle, /class="[^"]*rb-btn--icon-sm[^"]*"/, `${lang}: sized like the zoom buttons`);
      assert.ok(toggle.includes(`aria-label="${escapeHtml(t('reaction.open'))}"`), `${lang}: toggle label`);
      assert.ok(toggle.includes(`title="${escapeHtml(t('reaction.open'))}"`), `${lang}: tooltip`);
      assert.match(toggle, /<svg[^>]*lucide-smile-plus[^>]*aria-hidden="true"/, 'the add-reaction icon, hidden from screen readers');
      assert.ok(!toggle.includes('🎉'), 'no emoji glyph on the button');
      assert.match(toggle, /aria-expanded="false"/);
      assert.doesNotMatch(html, /rb-reaction-picker"/, 'the menu starts closed');
      // Clicking the board does not take focus from the button, so it must not switch board shortcuts off.
      assert.doesNotMatch(html, /data-board-shortcuts/, 'board shortcuts keep working after the button is used');
      assert.notEqual(t('reaction.open'), 'reaction.open');
    }
  });
});

test('the menu offers the board reactions with translated labels and sends the clicked one', async () => {
  await withChromeModule('/src/client/reactions/ReactionPicker.jsx', ({ ReactionMenu, ReactionToggle }, { t, setLang }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      const sent = [];
      const menu = ReactionMenu({ cooling: false, onSend: (emoji) => sent.push(emoji) });
      const html = renderToStaticMarkup(menu);
      assert.ok(html.includes(`aria-label="${escapeHtml(t('reaction.picker'))}"`));
      assert.match(html, /^<div[^>]*data-board-shortcuts="off"/, 'keys typed inside the open menu stay out of the board');
      assert.ok(html.includes(`aria-label="${escapeHtml(t('reaction.fireworks'))}"`), `${lang}: fireworks label`);
      for (const emoji of BOARD_REACTIONS.slice(1)) assert.ok(html.includes(escapeHtml(t('reaction.send', { emoji }))));
      buttonsOf(menu).forEach((button) => button.props.onClick());
      assert.deepEqual(sent, [...BOARD_REACTIONS]);
      let toggled = 0;
      const toggle = ReactionToggle({ open: true, onToggle: () => { toggled += 1; } });
      toggle.props.onClick();
      assert.equal(toggled, 1);
      assert.match(renderToStaticMarkup(toggle), /aria-expanded="true"/);
      assert.match(renderToStaticMarkup(toggle), /class="[^"]*rb-btn--active[^"]*"/, 'pressed while the picker is open');
      const closed = renderToStaticMarkup(ReactionToggle({ open: false, onToggle: () => {} }));
      assert.doesNotMatch(closed, /rb-btn--active/, 'not pressed while the picker is closed');
    }
  });
});

test('during the cooldown the emoji look disabled but clicks still reach the rate-limited channel', async () => {
  await withChromeModule('/src/client/reactions/ReactionPicker.jsx', ({ ReactionMenu }) => {
    const sent = [];
    const menu = ReactionMenu({ cooling: true, onSend: (emoji) => sent.push(emoji) });
    assert.equal((renderToStaticMarkup(menu).match(/aria-disabled="true"/g) ?? []).length, BOARD_REACTIONS.length);
    buttonsOf(menu)[0].props.onClick();
    assert.deepEqual(sent, [BOARD_REACTIONS[0]]);
  });
});

test('effects show fireworks on a canvas, floats with the sender name, and still badges for reduced motion', async () => {
  await withChromeModule('/src/client/reactions/ReactionOverlay.jsx', ({ ReactionEffects }, { t, setLang }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      const entries = [
        reactionEntry({ clientId: 1, seq: 1, emoji: '🎆', name: 'Ada' }, MOTION),
        reactionEntry({ clientId: 2, seq: 1, emoji: '👏', name: 'บี' }, MOTION),
        reactionEntry({ clientId: 3, seq: 1, emoji: '❤️', name: '' }, MOTION),
        reactionEntry({ clientId: 4, seq: 1, emoji: '🎆', name: 'Cy' }, { ...MOTION, reducedMotion: true }),
      ];
      const html = renderToStaticMarkup(React.createElement(ReactionEffects, { entries }));
      assert.match(html, /class="rb-reaction-layer" aria-hidden="true"/);
      assert.equal((html.match(/<canvas/g) ?? []).length, 1, 'one canvas for every show');
      assert.match(html, /rb-reaction-badge--float[^>]*>.*👏.*บี/);
      assert.ok(html.includes(escapeHtml(t('reaction.someone'))), `${lang}: a nameless sender gets a translated fallback`);
      assert.match(html, /rb-reaction-badge--still[^>]*>.*🎆.*Cy/);
      assert.equal(renderToStaticMarkup(React.createElement(ReactionEffects, { entries: [] })), '');
    }
  });
});

test('reduced motion alone never builds a canvas', async () => {
  await withChromeModule('/src/client/reactions/ReactionOverlay.jsx', ({ ReactionEffects }) => {
    const entries = [reactionEntry({ clientId: 1, seq: 1, emoji: '🎆', name: 'Ada' }, { ...MOTION, reducedMotion: true })];
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(ReactionEffects, { entries })), /<canvas/);
  });
});

test('without a board channel (Public Wall, server render) nothing is rendered', async () => {
  await withChromeModule('/src/client/reactions/BoardReactions.jsx', ({ BoardReactions }) => {
    assert.equal(renderToStaticMarkup(React.createElement(BoardReactions)), '');
    assert.match(renderToStaticMarkup(React.createElement(BoardReactions, { channel: fakeChannel() })), /rb-reaction-dock/);
  });
});
