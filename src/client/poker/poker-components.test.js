import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { POKER_DECK_ID, deckById } from '../../domain/poker-deck.js';
import { pokerTableSeats, summarizeRound } from '../../domain/poker-round.js';

const deck = deckById(POKER_DECK_ID.FIBONACCI);
const LANGUAGES = ['th', 'en'];
const noop = () => {};
const story = (overrides = {}) => ({ id: 's1', title: 'Checkout flow', order: 1, createdAt: 1, revealedAt: null, finalEstimate: null, ...overrides });
const names = new Map([['me', 'Mia'], ['amy', 'Amy']]);

test('the hand marks the picked card and locks every card after reveal', async () => {
  await withChromeModule('/src/client/poker/CardHand.jsx', async ({ CardHand }, { setLang, t }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      const open = renderToStaticMarkup(React.createElement(CardHand, { deck, selectedCardId: '5', locked: false, onPick: noop }));
      assert.equal((open.match(/aria-pressed="true"/g) || []).length, 1);
      assert.match(open, new RegExp(`aria-label="${t('poker.card.unknown')}"`));
      assert.doesNotMatch(open, /disabled/);
      const locked = renderToStaticMarkup(React.createElement(CardHand, { deck, selectedCardId: '5', locked: true, onPick: noop }));
      assert.equal((locked.match(/disabled=""/g) || []).length, deck.cards.length);
      assert.ok(locked.includes(t('poker.hand.locked').replaceAll('"', '&quot;')));
    }
  });
});

test('before reveal the table shows only the viewer card value, after reveal every card', async () => {
  await withChromeModule('/src/client/poker/PokerTable.jsx', async ({ PokerTable }, { setLang, t }) => {
    setLang('en');
    const votes = new Map([['me', '3'], ['amy', '13']]);
    const render = (revealed) => renderToStaticMarkup(React.createElement(PokerTable, {
      seats: pokerTableSeats(names, votes, { revealed, viewerId: 'me', fallbackName: 'Guest' }),
      deck, story: story({ revealedAt: revealed ? 1 : null }), onReveal: noop, onReset: noop, onNext: noop, canNext: false,
    }));
    const hidden = render(false);
    assert.match(hidden, /rb-poker-seat__card--down/);
    assert.doesNotMatch(hidden, />13</);
    assert.match(hidden, />3</);
    assert.ok(hidden.includes(t('poker.reveal')));
    const shown = render(true);
    assert.match(shown, />13</);
    assert.ok(shown.includes(t('poker.reset')));
  });
});

test('reveal is disabled until someone votes, and an empty room asks for a story', async () => {
  await withChromeModule('/src/client/poker/PokerTable.jsx', async ({ PokerTable }, { setLang, t }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      const seats = pokerTableSeats(names, new Map(), { revealed: false, viewerId: 'me', fallbackName: 'Guest' });
      const markup = renderToStaticMarkup(React.createElement(PokerTable, { seats, deck, story: story(), onReveal: noop, onReset: noop, onNext: noop, canNext: true }));
      assert.match(markup, /<button[^>]*disabled=""[^>]*>[^<]*<\/button>/);
      assert.ok(markup.includes(t('poker.next')));
      const idle = renderToStaticMarkup(React.createElement(PokerTable, { seats, deck, story: null, onReveal: noop, onReset: noop, onNext: noop }));
      assert.ok(idle.includes(t('poker.table.pick')));
    }
  });
});

test('a wide round names who should explain and offers the suggested estimate', async () => {
  await withChromeModule('/src/client/poker/RoundSummary.jsx', async ({ RoundSummary }, { setLang, t }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      const summary = summarizeRound(new Map([['me', '2'], ['amy', '13']]), deck);
      const markup = renderToStaticMarkup(React.createElement(RoundSummary, { summary, deck, names, finalEstimate: null, onAccept: noop }));
      assert.ok(markup.includes(t('poker.summary.wide', { low: 'Mia', high: 'Amy' })));
      assert.ok(markup.includes(t('poker.summary.accept', { value: '8' })));
      const accepted = renderToStaticMarkup(React.createElement(RoundSummary, { summary, deck, names, finalEstimate: '8', onAccept: noop }));
      assert.ok(accepted.includes(t('poker.summary.accepted', { value: '8' })));
      assert.doesNotMatch(accepted, /rb-choice-chip/);
    }
  });
});

test('the story list shows final estimates, the active story and an empty state', async () => {
  await withChromeModule('/src/client/poker/StoryList.jsx', async ({ StoryList }, { setLang, t }) => {
    for (const lang of LANGUAGES) {
      setLang(lang);
      const props = { deck, onSelect: noop, onAdd: noop, onRename: noop, onRemove: noop };
      const empty = renderToStaticMarkup(React.createElement(StoryList, { ...props, stories: [], activeStoryId: null }));
      assert.ok(empty.includes(t('poker.stories.empty')));
      const stories = [story({ finalEstimate: '5' }), story({ id: 's2', title: 'Search', order: 2 })];
      const list = renderToStaticMarkup(React.createElement(StoryList, { ...props, stories, activeStoryId: 's2' }));
      assert.match(list, /rb-poker-story__final[^>]*>5</);
      assert.match(list, /aria-current="true"[^>]*>Search</);
    }
  });
});
