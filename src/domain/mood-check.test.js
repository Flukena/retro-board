import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOOD_PREFIX, MOOD_SCALE, isMoodCheckState, isMoodScore, moodCheckAvailable, moodKey, moodSummary, parseMoodKey,
} from './mood-check.js';

test('a mood key round-trips and rejects unsafe or foreign keys', () => {
  assert.deepEqual(parseMoodKey(moodKey('round1', 'user-1')), { roundId: 'round1', userId: 'user-1' });
  assert.ok(moodKey('r', 'u').startsWith(MOOD_PREFIX));
  for (const bad of ['s||vote:a:b', `${MOOD_PREFIX}nosep`, `${MOOD_PREFIX}:user`, `${MOOD_PREFIX}round:`,
    `${MOOD_PREFIX}round:has space`, 7]) {
    assert.equal(parseMoodKey(bad), null, String(bad));
  }
});

test('scores are whole numbers from 1 to 5', () => {
  assert.deepEqual(MOOD_SCALE.map((entry) => entry.score), [1, 2, 3, 4, 5]);
  for (const good of [1, 3, 5]) assert.equal(isMoodScore(good), true);
  for (const bad of [0, 6, 2.5, '3', null, Number.NaN]) assert.equal(isMoodScore(bad), false, String(bad));
});

test('a round state needs a safe id, a start time and an open flag', () => {
  assert.equal(isMoodCheckState(null), true);
  assert.equal(isMoodCheckState({ id: 'r1', startedAt: 1, open: false }), true);
  for (const bad of [{ id: 'has space', startedAt: 1, open: true }, { id: 'r1', startedAt: -1, open: true },
    { id: 'r1', startedAt: 1 }, { id: 'r1', startedAt: 1, open: 'yes' }, [], 'r1']) {
    assert.equal(isMoodCheckState(bad), false, JSON.stringify(bad));
  }
});

test('the summary counts only the asked round, with a histogram and a one-decimal average', () => {
  const answers = [
    { roundId: 'r2', userId: 'a', score: 5 }, { roundId: 'r2', userId: 'b', score: 4 },
    { roundId: 'r2', userId: 'c', score: 4 }, { roundId: 'r1', userId: 'd', score: 1 },
  ];
  assert.deepEqual(moodSummary(answers, 'r2'), { count: 3, histogram: [0, 0, 0, 2, 1], average: 4.3 });
  assert.deepEqual(moodSummary(answers, 'none'), { count: 0, histogram: [0, 0, 0, 0, 0], average: null });
});

test('resultShownAt is optional, but an explicit invalid value is rejected', () => {
  const round = { id: 'r1', startedAt: 1, open: false };
  for (const good of [undefined, null, 0, 1_700_000_000_000]) {
    assert.equal(isMoodCheckState({ ...round, resultShownAt: good }), true, String(good));
  }
  for (const bad of [-1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, true, {}]) {
    assert.equal(isMoodCheckState({ ...round, resultShownAt: bad }), false, String(bad));
  }
});

test('mood checks are not offered on public boards', () => {
  assert.equal(moodCheckAvailable('public'), false);
  assert.equal(moodCheckAvailable('private'), true);
});
