import test from 'node:test';
import assert from 'node:assert/strict';
import { readCanonicalVotes } from './canonical-votes.js';

test('canonical vote reader preserves truthy vote records and rejects unrelated or malformed keys', () => {
  const votes = readCanonicalVotes(new Map([
    ['s||vote:card:alice', true], ['s||vote:card:bob', false],
    ['s||vote:card:__proto__', true], ['s||vote:card:alice:other', true],
    ['s||other:card:charlie', true], ['s||vote:other:alice', true],
  ]));
  assert.deepEqual([...votes].map(([id, voters]) => [id, [...voters]]), [['card', ['alice', '__proto__']], ['other', ['alice']]]);
});
