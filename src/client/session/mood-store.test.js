import test from 'node:test';
import assert from 'node:assert/strict';
import { MOOD_MAX_ANSWERS, moodKey } from '../../domain/mood-check.js';
import { isMoodKey, moodImportWrites, moodKeys, readMoods } from './mood-store.js';

const mapOf = (entries) => new Map(entries);

test('reading keeps only well-formed answers', () => {
  const ymap = mapOf([
    [moodKey('r1', 'a'), 4], [moodKey('r1', 'b'), 9], [moodKey('r1', 'c'), '3'],
    ['s||mood:broken', 3], ['s||vote:item:a', 1],
  ]);
  assert.deepEqual(readMoods(ymap), [{ roundId: 'r1', userId: 'a', score: 4 }]);
  assert.deepEqual(moodKeys(ymap).sort(), [moodKey('r1', 'a'), moodKey('r1', 'b'), moodKey('r1', 'c'), 's||mood:broken'].sort());
  assert.equal(isMoodKey('s||vote:item:a'), false);
});

test('reading stops at the per-round cap', () => {
  const ymap = mapOf(Array.from({ length: MOOD_MAX_ANSWERS + 5 }, (_, index) => [moodKey('r', `u${index}`), 3]));
  assert.equal(readMoods(ymap).length, MOOD_MAX_ANSWERS);
});

test('import writes reject invalid, repeated or too many entries', () => {
  const entry = { roundId: 'r1', userId: 'a', score: 5 };
  assert.deepEqual(moodImportWrites([entry]), [{ key: moodKey('r1', 'a'), score: 5 }]);
  assert.deepEqual(moodImportWrites([]), []);
  for (const bad of [[entry, entry], [{ ...entry, score: 0 }], [{ ...entry, userId: 'a b' }], [null], 'nope',
    Array.from({ length: MOOD_MAX_ANSWERS + 1 }, (_, index) => ({ ...entry, userId: `u${index}` }))]) {
    assert.equal(moodImportWrites(bad), null);
  }
});
