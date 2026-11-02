import test from 'node:test';
import assert from 'node:assert/strict';

import { POKER_DECK_ID } from './poker-deck.js';
import { pokerCsv } from './poker-export.js';
import { decodePokerRoom, pokerVoteKey } from './poker-schema.js';

const LABELS = { story: 'Story', estimate: 'Estimate', votes: 'Votes', average: 'Average' };
const story = (title, order, extra = {}) => ({ title, order, createdAt: 1, revealedAt: null, finalEstimate: null, ...extra });

test('each story becomes a row with its final estimate, revealed vote count and average', () => {
  const room = decodePokerRoom({
    poker: { deckId: POKER_DECK_ID.MODIFIED_FIBONACCI },
    stories: { a: story('Login', 1, { revealedAt: 5, finalEstimate: '½' }), b: story('=cmd', 2) },
    votes: { [pokerVoteKey('a', 'u1')]: '½', [pokerVoteKey('a', 'u2')]: '1', [pokerVoteKey('b', 'u1')]: '8' },
  });
  const lines = pokerCsv(room, LABELS).replace(/^﻿/, '').split('\r\n');
  assert.deepEqual(lines, ['Story,Estimate,Votes,Average', 'Login,½,2,0.8', "'=cmd,,,"]);
});

test('votes of a round that was never revealed are not exported', () => {
  const room = decodePokerRoom({
    stories: { a: story('Hidden', 1) },
    votes: { [pokerVoteKey('a', 'u1')]: '13' },
  });
  assert.equal(pokerCsv(room, LABELS).includes('13'), false);
});
