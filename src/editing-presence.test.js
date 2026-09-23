import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeRemoteEditors, summarizeRemoteSelectors } from './editing-presence.js';

test('summarizes remote editors per item and deduplicates the same player across tabs', () => {
  const editing = new Map([
    ['card-a', new Map([
      [20, { userId: 'bob', name: 'Bob' }],
      [10, { userId: 'alice', name: 'Alice' }],
      [30, { userId: 'alice', name: 'Alice' }],
    ])],
  ]);

  assert.deepEqual(Array.from(summarizeRemoteEditors(editing).entries()), [[
    'card-a',
    { userId: 'alice', name: 'Alice', extraCount: 1 },
  ]]);
});

test('uses a stable guest identity when awareness user data is not ready', () => {
  const editing = new Map([['card-a', new Map([[42, null]])]]);

  assert.deepEqual(summarizeRemoteEditors(editing).get('card-a'), {
    userId: 'client-42',
    name: 'Guest',
    extraCount: 0,
  });
});

test('selection presence uses the same multi-player deduplication', () => {
  const selected = new Map([['card-a', new Map([
    [2, { userId: 'bob', name: 'Bob' }],
    [1, { userId: 'alice', name: 'Alice' }],
    [3, { userId: 'alice', name: 'Alice' }],
  ])]]);

  assert.deepEqual(summarizeRemoteSelectors(selected).get('card-a'), {
    userId: 'alice',
    name: 'Alice',
    extraCount: 1,
  });
});
