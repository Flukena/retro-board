import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POKER_DECK_ID, POKER_CARD_BREAK, POKER_CARD_UNKNOWN, POKER_DECKS, POKER_DECK_ID,
  cardInDeck, deckById, isCardInDeck, isPokerDeckId, rankedCards,
} from './poker-deck.js';

test('the default deck is Fibonacci, the most common Planning Poker scale', () => {
  assert.equal(DEFAULT_POKER_DECK_ID, POKER_DECK_ID.FIBONACCI);
  assert.deepEqual(rankedCards(deckById(DEFAULT_POKER_DECK_ID)).map((card) => card.value), [0, 1, 2, 3, 5, 8, 13, 21]);
});

test('every deck offers "?" and a break card that are not ranked', () => {
  for (const entry of POKER_DECKS) {
    for (const special of [POKER_CARD_UNKNOWN, POKER_CARD_BREAK]) {
      const card = cardInDeck(entry, special);
      assert.ok(card, `${entry.id} has ${special}`);
      assert.equal(card.ranked, false);
      assert.equal(card.value, null);
    }
  }
});

test('card ids are unique within a deck so a stored vote is unambiguous', () => {
  for (const entry of POKER_DECKS) {
    const ids = entry.cards.map((card) => card.id);
    assert.equal(new Set(ids).size, ids.length, entry.id);
  }
});

test('ranked numeric cards are in strictly increasing order', () => {
  for (const entry of POKER_DECKS) {
    const values = rankedCards(entry).map((card) => card.value).filter((value) => value !== null);
    values.slice(1).forEach((value, index) => assert.ok(value > values[index], entry.id));
  }
});

test('modified Fibonacci includes a half point card', () => {
  assert.equal(cardInDeck(deckById(POKER_DECK_ID.MODIFIED_FIBONACCI), '½').value, 0.5);
});

test('unknown deck ids fall back to the default deck and are reported invalid', () => {
  assert.equal(isPokerDeckId('made-up'), false);
  assert.equal(isPokerDeckId(POKER_DECK_ID.TSHIRT), true);
  assert.equal(deckById('made-up').id, DEFAULT_POKER_DECK_ID);
});

test('card membership is checked against the given deck only', () => {
  assert.equal(isCardInDeck(deckById(POKER_DECK_ID.TSHIRT), 'XL'), true);
  assert.equal(isCardInDeck(deckById(POKER_DECK_ID.FIBONACCI), 'XL'), false);
});
