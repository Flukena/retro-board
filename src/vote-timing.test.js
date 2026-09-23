import test from 'node:test';
import assert from 'node:assert/strict';

import { voteTimerIsOpen, voteTimerPhaseSignature } from './vote-timing.js';

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
