import test from 'node:test';
import assert from 'node:assert/strict';
import { reuseSnapshotMap, reuseBoardReferences } from './snapshot-references.js';

test('unchanged indexed vote/comment values preserve the outer snapshot map while replacements remain observable', () => {
  const voters = new Set(['first']), comments = [{ id: 'comment' }];
  for (const value of [voters, comments]) {
    const previous = new Map([['card', value]]);
    assert.equal(reuseSnapshotMap(previous, new Map([['card', value]])), previous);
    const replacement = new Map([['card', value === voters ? new Set(['second']) : [...comments, { id: 'second' }]]]);
    assert.equal(reuseSnapshotMap(previous, replacement), replacement);
    const removed = new Map(); assert.equal(reuseSnapshotMap(previous, removed), removed);
  }
});
test('structural sharing compares every own field and preserves canonical array order', () => {
  const item = { id: 'card', text: 'original', voteTimer: { endsAt: 10 } }, previous = { items: [item], allRevealed: false };
  assert.equal(reuseBoardReferences(previous, { allRevealed: false, items: [{ voteTimer: item.voteTimer, text: 'original', id: 'card' }] }), previous);
  const changed = { items: [{ ...item, voteTimer: { endsAt: 20 } }], allRevealed: true };
  assert.notEqual(reuseBoardReferences(previous, changed), previous);
  assert.equal(reuseBoardReferences(previous, changed).items[0].voteTimer.endsAt, 20);
  const removed = { items: [{ id: 'card', text: 'original' }], allRevealed: false };
  assert.notEqual(reuseBoardReferences(previous, removed).items[0], item);
  assert.equal(item.voteTimer.endsAt, 10);
});
