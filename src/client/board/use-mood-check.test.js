import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moodCheckView, useMoodCheck } from './use-mood-check.js';

const OPEN_ROUND = { id: 'round1', startedAt: 1, open: true };

function renderMood({ answers = [], ...props } = {}) {
  const calls = [];
  const storage = {
    snapshotMoods: () => answers, onMoodsChange() {}, offMoodsChange() {},
    clearAllMoods: () => calls.push(['clear']), setMood: (...args) => calls.push(['setMood', ...args]),
  };
  let api = null;
  function Probe() {
    api = useMoodCheck({ mode: 'private', isAdmin: true, userId: 'me', moodCheck: OPEN_ROUND, storage,
      patchMeta: (...args) => calls.push(['patchMeta', ...args]), newRoundId: () => 'round2', ...props });
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return { api, calls };
}

test('starting a round clears old answers, then opens a new round silently', () => {
  const { api, calls } = renderMood({ moodCheck: null });
  api.start();
  assert.deepEqual(calls[0], ['clear']);
  assert.equal(calls[1][0], 'patchMeta');
  assert.deepEqual({ ...calls[1][1].moodCheck, startedAt: 0 }, { id: 'round2', startedAt: 0, open: true });
  assert.deepEqual(calls[1][2], { silent: true });
});

test('an open round asks someone who has not answered, and records their answer', () => {
  const { api, calls } = renderMood({ answers: [{ roundId: 'round1', userId: 'other', score: 2 }] });
  assert.equal(api.dialogOpen, true);
  assert.deepEqual(api.banner, { count: 1, answered: false, canClose: true });
  assert.equal(api.result, null);
  api.answer(4);
  api.close();
  assert.deepEqual(calls, [['setMood', 'round1', 'me', 4], ['patchMeta', { moodCheck: { ...OPEN_ROUND, open: false } }, { silent: true }]]);
});

test('someone who answered, or a non-admin, is not asked again and cannot close', () => {
  const answered = renderMood({ isAdmin: false, answers: [{ roundId: 'round1', userId: 'me', score: 5 }] }).api;
  assert.equal(answered.dialogOpen, false);
  assert.deepEqual(answered.banner, { count: 1, answered: true, canClose: false });
  const oldRound = renderMood({ answers: [{ roundId: 'old', userId: 'me', score: 5 }] }).api;
  assert.equal(oldRound.dialogOpen, true, 'an answer from an earlier round does not count');
});

test('a closed round shows its anonymous result and ignores late answers', () => {
  const answers = [{ roundId: 'round1', userId: 'a', score: 4 }, { roundId: 'round1', userId: 'b', score: 2 }];
  const { api, calls } = renderMood({ answers, moodCheck: { ...OPEN_ROUND, open: false } });
  assert.deepEqual(api.result, { count: 2, histogram: [0, 1, 0, 1, 0], average: 3 });
  assert.equal(api.banner, null);
  assert.equal(api.dialogOpen, false);
  api.answer(5);
  assert.deepEqual(calls, []);
  assert.equal(renderMood({ moodCheck: { ...OPEN_ROUND, open: false } }).api.result, null, 'no answers, no card');
});

test('a public room offers no mood check even if one was stored', () => {
  const { api } = renderMood({ mode: 'public' });
  assert.equal(api.available, false);
  assert.equal(api.dialogOpen, false);
  assert.equal(api.banner, null);
});

test('skipping hides the question for that round only, and a dismissed result stays hidden for that round only', () => {
  const base = { answers: [{ roundId: 'round1', userId: 'a', score: 3 }], userId: 'me', isAdmin: false };
  assert.equal(moodCheckView({ ...base, round: OPEN_ROUND, skippedRound: 'round1' }).dialogOpen, false);
  assert.equal(moodCheckView({ ...base, round: OPEN_ROUND, skippedRound: 'old' }).dialogOpen, true);
  const closed = { ...OPEN_ROUND, open: false };
  assert.equal(moodCheckView({ ...base, round: closed, dismissedRound: 'round1' }).result, null);
  assert.equal(moodCheckView({ ...base, round: closed, dismissedRound: 'old' }).result.count, 1);
});
