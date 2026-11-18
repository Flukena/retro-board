import test from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE_MS, TIMER_MAX_MINUTES } from './countdown.js';
import {
  TIMES_UP_SHOW_MS, WRITING_TIMER_PHASE, WRITING_TIMER_PRESET_MINUTES, WritingTimerClock, decodeWritingTimer,
  startedWritingTimer, writingTimer, writingTimerTickMs,
} from './writing-timer.js';

// The admin's wall clock when it starts the timer; other pages' clocks are this plus their skew.
const ADMIN_NOW_MS = 1_800_000_000_000;
const ID = 'timer-1';
const SECOND_MS = 1000;
const THREE_MINUTES_MS = 3 * MINUTE_MS;
const AHEAD_MS = 2 * MINUTE_MS;
const BEHIND_MS = 11 * SECOND_MS;
const LIVE = true;
const SYNCED_LATER = false;

const started = () => startedWritingTimer(ID, 3, ADMIN_NOW_MS);
/** A page whose clock reads `now` when it receives `timer`, live or from the initial sync. */
function pageWith(timer, now, live) {
  const clock = new WritingTimerClock();
  clock.apply(timer, { live, now });
  return clock;
}

test('the presets are 3, 5 and 10 minutes', () => {
  assert.deepEqual([...WRITING_TIMER_PRESET_MINUTES], [3, 5, 10]);
});

test('starting publishes the run on the admin clock; custom minutes clamp to the timer range', () => {
  assert.deepEqual({ ...started() }, { id: ID, writtenAt: ADMIN_NOW_MS, endsAt: ADMIN_NOW_MS + THREE_MINUTES_MS });
  assert.equal(startedWritingTimer(ID, 0, ADMIN_NOW_MS).endsAt, ADMIN_NOW_MS + MINUTE_MS);
  assert.equal(startedWritingTimer(ID, 500, ADMIN_NOW_MS).endsAt, ADMIN_NOW_MS + TIMER_MAX_MINUTES * MINUTE_MS);
  assert.ok(Object.isFrozen(started()));
});

test('a page receiving the start live counts the full run whatever its own clock says', () => {
  for (const skew of [0, AHEAD_MS, -BEHIND_MS]) {
    const view = pageWith(started(), ADMIN_NOW_MS + skew, LIVE).view(ADMIN_NOW_MS + skew);
    assert.equal(view.phase, WRITING_TIMER_PHASE.RUNNING, `skew ${skew}`);
    assert.equal(view.label, '03:00', `skew ${skew}`);
  }
});

test('a late joiner (state from the initial sync) counts against its own clock', () => {
  const joinedAt = ADMIN_NOW_MS + 30 * SECOND_MS;
  const view = pageWith(started(), joinedAt, SYNCED_LATER).view(joinedAt);
  assert.equal(view.label, '02:30');
});

test('+1 adds a minute to what this page has left and publishes it on this page clock', () => {
  const adminNow = ADMIN_NOW_MS + AHEAD_MS;
  const admin = pageWith(started(), adminNow, LIVE);
  const later = adminNow + MINUTE_MS;
  const extended = admin.extended(later);
  assert.deepEqual({ ...extended }, { id: ID, writtenAt: later, endsAt: later + THREE_MINUTES_MS });
  const reader = pageWith(extended, ADMIN_NOW_MS + 5 * SECOND_MS, LIVE);
  assert.equal(reader.view(ADMIN_NOW_MS + 5 * SECOND_MS).label, '03:00', 'a reader with another clock sees 2:00 + 1:00');
});

test('+1 is refused past the longest run, when nothing runs, and after the end', () => {
  const longest = pageWith(startedWritingTimer(ID, TIMER_MAX_MINUTES, ADMIN_NOW_MS), ADMIN_NOW_MS, LIVE);
  assert.equal(longest.extended(ADMIN_NOW_MS + SECOND_MS), null);
  assert.equal(new WritingTimerClock().extended(ADMIN_NOW_MS), null);
  assert.equal(pageWith(started(), ADMIN_NOW_MS, LIVE).extended(ADMIN_NOW_MS + THREE_MINUTES_MS), null);
});

test('stopping (no timer) hides it at once', () => {
  const page = pageWith(started(), ADMIN_NOW_MS, LIVE);
  page.apply(null, { live: LIVE, now: ADMIN_NOW_MS + SECOND_MS });
  assert.equal(page.view(ADMIN_NOW_MS + SECOND_MS).phase, WRITING_TIMER_PHASE.IDLE);
});

test("at the end the page shows Time's up briefly and reports the expiry exactly once", () => {
  const page = pageWith(started(), ADMIN_NOW_MS, LIVE);
  const end = ADMIN_NOW_MS + THREE_MINUTES_MS;
  assert.equal(page.takeExpiry(end - 1), false, 'not yet');
  assert.equal(page.view(end - 1).urgent, true, 'the last stretch is urgent');
  assert.equal(page.takeExpiry(end), true);
  assert.equal(page.takeExpiry(end + SECOND_MS), false, 'only once');
  assert.equal(page.view(end + SECOND_MS).phase, WRITING_TIMER_PHASE.TIMES_UP);
  assert.equal(page.view(end + TIMES_UP_SHOW_MS).phase, WRITING_TIMER_PHASE.IDLE, 'then it goes');
  page.apply(started(), { live: LIVE, now: end + TIMES_UP_SHOW_MS });
  assert.equal(page.view(end + TIMES_UP_SHOW_MS).phase, WRITING_TIMER_PHASE.IDLE, 'the same timer seen again is not restarted');
});

test('a board reopened after the end shows nothing and plays nothing', () => {
  const reopenedAt = ADMIN_NOW_MS + THREE_MINUTES_MS + SECOND_MS;
  const page = pageWith(started(), reopenedAt, SYNCED_LATER);
  assert.equal(page.view(reopenedAt).phase, WRITING_TIMER_PHASE.IDLE);
  assert.equal(page.takeExpiry(reopenedAt), false);
});

test("a page that wakes long after the end stays quiet instead of playing a stale Time's up", () => {
  const page = pageWith(started(), ADMIN_NOW_MS, LIVE);
  const woke = ADMIN_NOW_MS + THREE_MINUTES_MS + TIMES_UP_SHOW_MS;
  assert.equal(page.takeExpiry(woke), false);
  assert.equal(page.view(woke).phase, WRITING_TIMER_PHASE.IDLE);
});

test('a peer rewriting the timer over and over never reaches an end, so nothing plays', () => {
  const page = new WritingTimerClock();
  let expiries = 0;
  for (let index = 0; index < 50; index += 1) {
    const now = ADMIN_NOW_MS + index * 100;
    page.apply(writingTimer(`spam-${index}`, now, now + MINUTE_MS), { live: LIVE, now });
    if (page.takeExpiry(now)) expiries += 1;
  }
  assert.equal(expiries, 0);
});

test('untrusted state decodes only as a well-formed timer of 1 to 120 minutes', () => {
  const valid = { id: ID, writtenAt: ADMIN_NOW_MS, endsAt: ADMIN_NOW_MS + THREE_MINUTES_MS };
  assert.deepEqual({ ...decodeWritingTimer({ ...valid, extra: 'ignored' }) }, valid);
  assert.ok(decodeWritingTimer({ ...valid, endsAt: ADMIN_NOW_MS + TIMER_MAX_MINUTES * MINUTE_MS }), 'the longest run');
  const invalid = [
    null, 'timer', [valid], 42,
    { ...valid, id: '' }, { ...valid, id: 'has space' }, { ...valid, id: 7 },
    { ...valid, writtenAt: 0 }, { ...valid, writtenAt: Number.NaN }, { ...valid, writtenAt: '1' },
    { ...valid, endsAt: Number.POSITIVE_INFINITY },
    { ...valid, endsAt: ADMIN_NOW_MS + MINUTE_MS - 1 },
    { ...valid, endsAt: ADMIN_NOW_MS + TIMER_MAX_MINUTES * MINUTE_MS + 1 },
  ];
  for (const raw of invalid) assert.equal(decodeWritingTimer(raw), null, JSON.stringify(raw));
});

test('the page re-renders when the shown second changes, each second of Time\'s up, and not at all when idle', () => {
  const page = pageWith(started(), ADMIN_NOW_MS, LIVE);
  assert.equal(writingTimerTickMs(page.view(ADMIN_NOW_MS)), SECOND_MS, '03:00 turns to 02:59 a second later');
  assert.equal(writingTimerTickMs(page.view(ADMIN_NOW_MS + 300)), SECOND_MS - 300);
  assert.equal(writingTimerTickMs(page.view(ADMIN_NOW_MS + THREE_MINUTES_MS)), SECOND_MS);
  assert.equal(writingTimerTickMs(new WritingTimerClock().view(ADMIN_NOW_MS)), null);
});

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * MINUTE_MS;

test('a late joiner never counts longer than the run, whatever the stored stamps say', () => {
  const writtenAt = ADMIN_NOW_MS + TEN_YEARS_MS;
  const hostile = decodeWritingTimer({ id: 'evil', writtenAt, endsAt: writtenAt + THREE_MINUTES_MS });
  assert.ok(hostile, 'the decoder only bounds the run');
  const lateJoiner = pageWith(hostile, ADMIN_NOW_MS, SYNCED_LATER);
  assert.equal(lateJoiner.view(ADMIN_NOW_MS).label, '03:00');
  assert.equal(pageWith(hostile, ADMIN_NOW_MS, LIVE).view(ADMIN_NOW_MS).label, '03:00');
});

test('a late joiner shows nothing, and no chime, for a deadline long past', () => {
  const writtenAt = ADMIN_NOW_MS - TEN_YEARS_MS;
  const stale = decodeWritingTimer({ id: 'old', writtenAt, endsAt: writtenAt + THREE_MINUTES_MS });
  const lateJoiner = pageWith(stale, ADMIN_NOW_MS, SYNCED_LATER);
  assert.equal(lateJoiner.view(ADMIN_NOW_MS).phase, WRITING_TIMER_PHASE.IDLE);
  assert.equal(lateJoiner.takeExpiry(ADMIN_NOW_MS), false);
});
