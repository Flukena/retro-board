import test from 'node:test';
import assert from 'node:assert/strict';

import { boardVoteIsOpen, voteTimerIsOpen, voteTimerPhaseSignature } from './vote-timing.js';

test('timer phase changes at its deadline even when board data does not change', () => {
  const items = [{
    id: 'zone-1', type: 'zone', voteTimer: { endsAt: 2_000 },
  }];
  assert.equal(voteTimerIsOpen(items[0].voteTimer, 1_999), true);
  assert.equal(voteTimerIsOpen(items[0].voteTimer, 2_000), false);
  assert.notEqual(
    voteTimerPhaseSignature(items, 1_999),
    voteTimerPhaseSignature(items, 2_000),
  );
});

test('timer phase remains stable between ticks before the deadline', () => {
  const items = [{
    id: 'zone-1', type: 'zone', voteTimer: { endsAt: 10_000 },
  }];
  assert.equal(
    voteTimerPhaseSignature(items, 1_000),
    voteTimerPhaseSignature(items, 9_999),
  );
});

test('setup inputs clamp at contract boundaries and invalid numeric input uses the minimum', async () => {
  const { clampTimerMinutes, clampVoteLimit } = await import('./vote-timing.js');
  for (const [clamp, maximum] of [[clampTimerMinutes, 120], [clampVoteLimit, 50]]) {
    for (const [input, expected] of [[0, 1], [1, 1], [3, 3], [maximum, maximum], [maximum + 1, maximum], [NaN, 1]]) {
      assert.equal(clamp(input), expected);
    }
  }
});

const VOTE_NOW_MS = 2_000;
const OPEN_TIMER = { endsAt: VOTE_NOW_MS + 1 };

test('board voting is open only when any zone has an open timer', () => {
  for (const timer of [OPEN_TIMER, { endsAt: null }, { endsAt: 0 }]) {
    assert.equal(boardVoteIsOpen([{ type: 'zone' }, { type: 'zone', voteTimer: timer }], VOTE_NOW_MS), true);
  }
  for (const items of [[], [{ type: 'zone' }], [{ type: 'zone', voteTimer: null }],
    [{ type: 'zone', voteTimer: { endsAt: VOTE_NOW_MS } }],
    [{ type: 'zone', voteTimer: { endsAt: VOTE_NOW_MS - 1 } }],
    [{ type: 'sticky', voteTimer: OPEN_TIMER }]]) {
    assert.equal(boardVoteIsOpen(items, VOTE_NOW_MS), false);
  }
});
