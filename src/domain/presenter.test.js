import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESENTER_ACTION, PRESENTER_BANNER, presenterAvailable, presenterBanner, presenterFollowStep } from './presenter.js';

const base = { presenter: 'p', prevPresenter: 'p', prevFollowed: null, followed: null, optedOutFor: null, userId: 'me', presenterOnline: true };
const step = (patch) => presenterFollowStep({ ...base, ...patch });

test('a viewer starts following an online presenter', () => {
  assert.deepEqual(step({ prevPresenter: null }), { action: PRESENTER_ACTION.FOLLOW, optedOutFor: null });
  assert.equal(step({ presenterOnline: false }).action, PRESENTER_ACTION.NONE);
});

test('the presenter never follows themselves', () => {
  assert.equal(step({ userId: 'p' }).action, PRESENTER_ACTION.NONE);
});

test('panning away opts out, and the viewer is not pulled back', () => {
  const left = step({ prevFollowed: 'p', followed: null });
  assert.deepEqual(left, { action: PRESENTER_ACTION.NONE, optedOutFor: 'p' });
  assert.equal(step({ optedOutFor: 'p' }).action, PRESENTER_ACTION.NONE);
});

test('losing the presenter because they went offline is not an opt-out', () => {
  assert.equal(step({ prevFollowed: 'p', followed: null, presenterOnline: false }).optedOutFor, null);
});

test('a new presenter clears the old opt-out and is followed', () => {
  assert.deepEqual(step({ presenter: 'q', prevPresenter: 'p', optedOutFor: 'p', followed: null }),
    { action: PRESENTER_ACTION.FOLLOW, optedOutFor: null });
});

test('ending presenter mode stops only a follow that the presenter started', () => {
  assert.equal(step({ presenter: null, followed: 'p' }).action, PRESENTER_ACTION.STOP);
  assert.equal(step({ presenter: null, followed: 'someone-else' }).action, PRESENTER_ACTION.NONE);
  assert.equal(step({ presenter: null, prevPresenter: null, followed: 'p' }).action, PRESENTER_ACTION.NONE);
});

test('banners: the presenter sees "presenting"; an opted-out viewer is invited back', () => {
  const banner = (patch) => presenterBanner({ presenter: 'p', userId: 'me', followed: null, optedOutFor: null, presenterOnline: true, ...patch });
  assert.equal(banner({ userId: 'p' }), PRESENTER_BANNER.PRESENTING);
  assert.equal(banner({ optedOutFor: 'p' }), PRESENTER_BANNER.INVITE);
  assert.equal(banner({ optedOutFor: 'p', presenterOnline: false }), null);
  assert.equal(banner({ followed: 'p' }), null);
  assert.equal(banner({ presenter: null }), null);
});

test('presenter mode is not offered on public boards', () => {
  assert.equal(presenterAvailable('public'), false);
  assert.equal(presenterAvailable('private'), true);
});
