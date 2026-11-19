import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moodCheckView, useMoodCheck } from './use-mood-check.js';

const OPEN_ROUND = { id: 'round1', startedAt: 1, open: true };
const SHOWN_AT_MS = 5_000;
const CLOSED_ROUND = { ...OPEN_ROUND, open: false };
const SHOWN_ROUND = { ...CLOSED_ROUND, resultShownAt: SHOWN_AT_MS };
const ONE_ANSWER = [{ roundId: 'round1', userId: 'a', score: 3 }];
const patches = (calls) => calls.filter((call) => call[0] === 'patchMeta');

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
  assert.deepEqual(calls, [['setMood', 'round1', 'me', 4]]);
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
  const { api, calls } = renderMood({ answers, moodCheck: SHOWN_ROUND });
  assert.deepEqual(api.result, { count: 2, histogram: [0, 1, 0, 1, 0], average: 3 });
  assert.equal(api.banner, null);
  assert.equal(api.dialogOpen, false);
  api.answer(5);
  assert.deepEqual(calls, []);
  assert.equal(renderMood({ moodCheck: SHOWN_ROUND }).api.result, null, 'no answers, no card');
});

test('a public room offers no mood check even if one was stored', () => {
  const { api } = renderMood({ mode: 'public' });
  assert.equal(api.available, false);
  assert.equal(api.dialogOpen, false);
  assert.equal(api.banner, null);
});

test('skipping hides the question for that round only', () => {
  const base = { answers: ONE_ANSWER, userId: 'me', isAdmin: false };
  assert.equal(moodCheckView({ ...base, round: OPEN_ROUND, skippedRound: 'round1' }).dialogOpen, false);
  assert.equal(moodCheckView({ ...base, round: OPEN_ROUND, skippedRound: 'old' }).dialogOpen, true);
});

test('a closed round shows its result only after the admin shows it', () => {
  const base = { answers: ONE_ANSWER, userId: 'me', isAdmin: false };
  assert.equal(moodCheckView({ ...base, round: CLOSED_ROUND }).result, null, 'legacy closed round');
  assert.equal(moodCheckView({ ...base, round: { ...CLOSED_ROUND, resultShownAt: null } }).result, null);
  assert.equal(moodCheckView({ ...base, round: SHOWN_ROUND }).result.count, 1);
  assert.equal(moodCheckView({ ...base, round: { ...SHOWN_ROUND, resultShownAt: 0 } }).result.count, 1);
  assert.equal(moodCheckView({ ...base, answers: [], round: SHOWN_ROUND }).result, null, 'no answers');
  const open = moodCheckView({ ...base, round: { ...OPEN_ROUND, resultShownAt: SHOWN_AT_MS } });
  assert.equal(open.result, null);
  assert.deepEqual(open.banner, { count: 1, answered: false, canClose: false });
});

test('a member dismissal hides one showing, and a later showing appears again', () => {
  const base = { answers: ONE_ANSWER, userId: 'me', isAdmin: false, round: SHOWN_ROUND };
  assert.equal(moodCheckView({ ...base, dismissedShowing: `round1:${SHOWN_AT_MS}` }).result, null);
  assert.equal(moodCheckView({ ...base, dismissedShowing: `round1:${SHOWN_AT_MS - 1}` }).result.count, 1);
  assert.equal(moodCheckView({ ...base, dismissedShowing: `old:${SHOWN_AT_MS}` }).result.count, 1);
});

test('only the admin is offered Show result, for a closed round with answers and no showing', () => {
  const view = (overrides) => moodCheckView({ answers: ONE_ANSWER, userId: 'me', isAdmin: true, round: CLOSED_ROUND, ...overrides }).canShowResult;
  assert.equal(view({}), true);
  assert.equal(view({ isAdmin: false }), false);
  assert.equal(view({ round: OPEN_ROUND }), false);
  assert.equal(view({ answers: [] }), false);
  assert.equal(view({ round: SHOWN_ROUND }), false);
  assert.equal(view({ round: null }), false);
});

test('closing stamps resultShownAt, which is the admin show press', () => {
  const before = Date.now();
  const { api, calls } = renderMood();
  api.close();
  const [, patch, options] = patches(calls)[0];
  assert.deepEqual(options, { silent: true });
  assert.deepEqual({ ...patch.moodCheck, resultShownAt: 0 }, { ...CLOSED_ROUND, resultShownAt: 0 });
  assert.ok(patch.moodCheck.resultShownAt >= before && Number.isSafeInteger(patch.moodCheck.resultShownAt));
});

test('showResult stamps a silent meta write only for an admin on a closed round with answers', () => {
  const closed = { moodCheck: CLOSED_ROUND, answers: ONE_ANSWER };
  const shown = renderMood(closed);
  shown.api.showResult();
  const [, patch, options] = patches(shown.calls)[0];
  assert.deepEqual(options, { silent: true });
  assert.equal(patch.moodCheck.open, false);
  assert.ok(Number.isSafeInteger(patch.moodCheck.resultShownAt));
  for (const blocked of [{ ...closed, isAdmin: false }, { ...closed, answers: [] }, { ...closed, moodCheck: OPEN_ROUND },
    { ...closed, moodCheck: SHOWN_ROUND }, { ...closed, moodCheck: null }]) {
    const run = renderMood(blocked);
    run.api.showResult();
    assert.deepEqual(run.calls, []);
  }
});

test('the admin dismissing the card hides it for everyone; a member writes nothing shared', () => {
  const admin = renderMood({ moodCheck: SHOWN_ROUND, answers: ONE_ANSWER });
  admin.api.dismissResult();
  assert.deepEqual(patches(admin.calls), [['patchMeta', { moodCheck: { ...CLOSED_ROUND, resultShownAt: null } }, { silent: true }]]);
  const member = renderMood({ moodCheck: SHOWN_ROUND, answers: ONE_ANSWER, isAdmin: false });
  member.api.dismissResult();
  assert.deepEqual(member.calls, []);
});
