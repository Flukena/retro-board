import test from 'node:test';
import assert from 'node:assert/strict';

import { POKER_CARD_BREAK, POKER_CARD_UNKNOWN, POKER_DECK_ID, deckById } from './poker-deck.js';
import { POKER_SPREAD, pokerTableSeats, summarizeRound, visibleVotes } from './poker-round.js';

const fibonacci = deckById(POKER_DECK_ID.FIBONACCI);
const tshirt = deckById(POKER_DECK_ID.TSHIRT);
const votes = (entries) => new Map(Object.entries(entries));

test('average and median use only numeric cards, never "?" or the break card', () => {
  const summary = summarizeRound(votes({ a: '3', b: '5', c: '8', d: POKER_CARD_UNKNOWN, e: POKER_CARD_BREAK }), fibonacci);
  assert.equal(summary.voterCount, 5);
  assert.equal(summary.numericCount, 3);
  assert.equal(summary.average, 16 / 3);
  assert.equal(summary.median, 5);
});

test('median of an even number of numeric votes is the mean of the middle two', () => {
  const summary = summarizeRound(votes({ a: '2', b: '3', c: '5', d: '13' }), fibonacci);
  assert.equal(summary.median, 4);
});

test('votes for cards outside the room deck are ignored', () => {
  const summary = summarizeRound(votes({ a: '5', b: '7', c: 'XL' }), fibonacci);
  assert.equal(summary.voterCount, 1);
  assert.equal(summary.average, 5);
});

test('an empty round has no statistics, no consensus and no suggestion', () => {
  const summary = summarizeRound(new Map(), fibonacci);
  assert.deepEqual(
    [summary.voterCount, summary.average, summary.median, summary.consensus, summary.spread, summary.suggestedCardId],
    [0, null, null, false, POKER_SPREAD.NONE, null],
  );
});

test('consensus means every voter picked the same ranked card', () => {
  assert.equal(summarizeRound(votes({ a: '5', b: '5' }), fibonacci).consensus, true);
  assert.equal(summarizeRound(votes({ a: '5', b: '8' }), fibonacci).consensus, false);
  assert.equal(summarizeRound(votes({ a: '5', b: POKER_CARD_UNKNOWN }), fibonacci).consensus, false);
  assert.equal(summarizeRound(votes({ a: POKER_CARD_UNKNOWN, b: POKER_CARD_UNKNOWN }), fibonacci).consensus, false);
});

test('spread is close for neighbouring cards and wide beyond one deck step', () => {
  assert.equal(summarizeRound(votes({ a: '5', b: '8' }), fibonacci).spread, POKER_SPREAD.CLOSE);
  assert.equal(summarizeRound(votes({ a: '3', b: '8' }), fibonacci).spread, POKER_SPREAD.WIDE);
  assert.equal(summarizeRound(votes({ a: '3' }), fibonacci).spread, POKER_SPREAD.NONE);
});

test('a wide round names the lowest and highest voters so they can explain', () => {
  const summary = summarizeRound(votes({ ann: '2', bob: '5', cat: '13', dan: '2', eve: POKER_CARD_UNKNOWN }), fibonacci);
  assert.deepEqual(summary.lowVoterIds, ['ann', 'dan']);
  assert.deepEqual(summary.highVoterIds, ['cat']);
  const close = summarizeRound(votes({ ann: '5', bob: '8' }), fibonacci);
  assert.deepEqual([close.lowVoterIds, close.highVoterIds], [[], []]);
});

test('distribution lists picked cards in deck order with counts', () => {
  const summary = summarizeRound(votes({ a: '8', b: '3', c: '8', d: POKER_CARD_UNKNOWN }), fibonacci);
  assert.deepEqual(summary.distribution.map(({ cardId, count }) => [cardId, count]), [['3', 1], ['8', 2], [POKER_CARD_UNKNOWN, 1]]);
});

test('suggestion is the most picked card, not the card nearest the average', () => {
  // Averages 6.3 and 6.3 would point at 5; the majority picked 8 and 3.
  assert.equal(summarizeRound(votes({ a: '3', b: '8', c: '8' }), fibonacci).suggestedCardId, '8');
  assert.equal(summarizeRound(votes({ a: '3', b: '3', c: '13' }), fibonacci).suggestedCardId, '3');
});

test('a tie for the most picked card suggests the larger card', () => {
  assert.equal(summarizeRound(votes({ a: '3', b: '8' }), fibonacci).suggestedCardId, '8');
});

test('? and coffee never become the suggestion, even as the majority', () => {
  const summary = summarizeRound(votes({ a: POKER_CARD_UNKNOWN, b: POKER_CARD_UNKNOWN, c: '5' }), fibonacci);
  assert.equal(summary.suggestedCardId, '5');
});

test('non-numeric decks suggest the most picked size, preferring the larger on ties', () => {
  assert.equal(summarizeRound(votes({ a: 'M', b: 'M', c: 'L' }), tshirt).suggestedCardId, 'M');
  assert.equal(summarizeRound(votes({ a: 'S', b: 'L' }), tshirt).suggestedCardId, 'L');
  assert.equal(summarizeRound(votes({ a: 'S', b: 'L' }), tshirt).average, null);
});

test('table seats list the viewer first, keep voters who left and hide cards before reveal', () => {
  const names = new Map([['me', 'Zed'], ['amy', 'Amy'], ['bo', 'Bo']]);
  const round = votes({ me: '5', amy: '8', gone: '3' });
  const seats = pokerTableSeats(names, round, { revealed: false, viewerId: 'me', fallbackName: 'Guest' });
  assert.deepEqual(seats.map((seat) => [seat.userId, seat.name, seat.online, seat.voted, seat.cardId]), [
    ['me', 'Zed', true, true, '5'],
    ['amy', 'Amy', true, true, null],
    ['bo', 'Bo', true, false, null],
    ['gone', 'Guest', false, true, null],
  ]);
  const shown = pokerTableSeats(names, round, { revealed: true, viewerId: 'me', fallbackName: 'Guest' });
  assert.equal(shown.find((seat) => seat.userId === 'gone').cardId, '3');
});

test('before reveal a viewer sees who voted but only their own card', () => {
  const round = votes({ me: '5', you: '8' });
  const hidden = visibleVotes(round, { revealed: false, viewerId: 'me' });
  assert.deepEqual(Object.fromEntries(hidden), { me: '5', you: null });
  const shown = visibleVotes(round, { revealed: true, viewerId: 'me' });
  assert.deepEqual(Object.fromEntries(shown), { me: '5', you: '8' });
});
