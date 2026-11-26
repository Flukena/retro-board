import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voteKey, commentKey, moodKey, parseStoredVoteKey, parseStoredCommentKey, parseCanonicalVoteKey, parseMoodKey } from './vote-comment-keys.js';
import { readCanonicalVotes } from './canonical-votes.js';
import { moodKey as publicMoodKey, parseMoodKey as publicParseMoodKey } from './mood-check.js';

const fixtureBytes = readFileSync(new URL('./fixtures/vote-comment-keys.json', import.meta.url), 'utf8');
const fixtures = JSON.parse(fixtureBytes);
test('builders and parser variants preserve every byte of the unmoved key fixtures', () => {
  const actual = fixtures.map(({ first, second }) => {
    const vote = voteKey(first, second), comment = commentKey(first, second), mood = moodKey(first, second);
    return { first, second, vote, comment, mood, storedVote: parseStoredVoteKey(vote), storedComment: parseStoredCommentKey(comment), canonicalVote: parseCanonicalVoteKey(vote), parsedMood: parseMoodKey(mood) };
  });
  assert.equal(JSON.stringify(actual, null, 2) + '\n', fixtureBytes);
});
test('canonical reader consumes both built and literal legacy vote keys', () => {
  for (const key of [voteKey('card', 'alice'), 's||vote:card:alice']) {
    assert.deepEqual([...readCanonicalVotes(new Map([[key, true]]))].map(([id, users]) => [id, [...users]]), [['card', ['alice']]]);
  }
});
test('public mood API consumes both built and literal legacy mood keys', () => {
  assert.equal(publicMoodKey('round', 'alice'), 's||mood:round:alice');
  for (const key of [moodKey('round', 'alice'), 's||mood:round:alice']) {
    assert.deepEqual(publicParseMoodKey(key), { roundId: 'round', userId: 'alice' });
  }
});
test('legacy bridge parsers and strict canonical parser retain distinct rejection policies', () => {
  assert.deepEqual(parseStoredVoteKey('s||vote::a:b'), { itemId: '', userId: 'a:b' });
  assert.deepEqual(parseStoredCommentKey('s||comment:card:'), { itemId: 'card', commentId: '' });
  for (const key of ['s||vote::alice', 's||vote:card:', 's||vote:card:alice:extra', 's||comment:card:alice', 'other']) assert.equal(parseCanonicalVoteKey(key), null);
  for (const key of ['other', 's||vote:missing-separator']) assert.equal(parseStoredVoteKey(key), null);
  for (const key of ['other', 's||comment:missing-separator']) assert.equal(parseStoredCommentKey(key), null);
  for (const key of [undefined, 42, 's||mood:r:__proto__', 's||mood:r:u:extra']) assert.equal(parseMoodKey(key), null);
});
