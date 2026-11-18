import { isSafeId } from './comment-schema.js';
import {
  MINUTE_MS, TIMER_MAX_MINUTES, TIMER_MIN_MINUTES, TIMER_URGENT_MS, clampTimerMinutes, countdownLabel, extendedDeadline,
} from './countdown.js';

// The card-writing countdown an admin runs for the whole board. The shared value is `{ id, writtenAt, endsAt }`:
// `endsAt - writtenAt` is the time left when it was written, on the writer's own clock.
// Clock rule (no relay clock):
// - A page that receives the value live counts that run from its own receipt, so clock skew between machines cancels
//   out, whoever wrote it: the admin who started it, or another admin whose +1 republishes the run on its own clock.
// - A page that only finds the value in the initial sync (late join, reopened board) has no receipt to count from and
//   counts to `endsAt` on its own clock, so it is off by its clock's error against the writer's. The next live write
//   puts it right; its deadline is capped at the run length from now, and one already past shows nothing. A +1 it writes meanwhile carries its error to every page until then.

export const WRITING_TIMER_PRESET_MINUTES = Object.freeze([3, 5, 10]);
export const WRITING_TIMER_EXTEND_MINUTES = 1;
// How long "Time's up" stays on screen after the end.
export const TIMES_UP_SHOW_MS = 5000;
export const WRITING_TIMER_PHASE = Object.freeze({ IDLE: 'idle', RUNNING: 'running', TIMES_UP: 'timesUp' });
// Every legitimate write runs at least the shortest start (+1 only adds), and never longer than the longest one.
const MIN_RUN_MS = TIMER_MIN_MINUTES * MINUTE_MS;
const MAX_RUN_MS = TIMER_MAX_MINUTES * MINUTE_MS;
const IDLE_VIEW = Object.freeze({ phase: WRITING_TIMER_PHASE.IDLE });
const SECOND_MS = 1000;

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const isPositiveTime = (value) => Number.isFinite(value) && value > 0;

/** The shared timer value, or null when it is not one. */
export function writingTimer(id, writtenAt, endsAt) {
  const runMs = endsAt - writtenAt;
  if (!isSafeId(id) || !isPositiveTime(writtenAt) || !Number.isFinite(endsAt)) return null;
  if (runMs < MIN_RUN_MS || runMs > MAX_RUN_MS) return null;
  return Object.freeze({ id, writtenAt, endsAt });
}

/** A peer's shared value as a timer, or null. Unknown keys are ignored. */
export function decodeWritingTimer(raw) {
  return isPlainObject(raw) ? writingTimer(raw.id, raw.writtenAt, raw.endsAt) : null;
}

export const startedWritingTimer = (id, minutes, now) => writingTimer(id, now, now + clampTimerMinutes(minutes) * MINUTE_MS);

const sameTimer = (one, other) => one?.id === other?.id && one?.writtenAt === other?.writtenAt
  && one?.endsAt === other?.endsAt;

/** This page's view of the shared timer: where it counts down to on this page's clock, and what to show when. */
export class WritingTimerClock {
  #timer = null;
  #deadline = null;
  // Only a timer this page saw running may end here; one first seen already over stays silent.
  #seenRunning = false;
  #lastExpiredId = null;

  /** Takes the current shared value (or null), received live or found in the initial sync, at this page's `now`. */
  apply(timer, { live, now }) {
    if (sameTimer(timer, this.#timer)) return;
    this.#timer = timer;
    if (!timer) return;
    const runMs = timer.endsAt - timer.writtenAt;
    // Never later than the whole run from now, so a far-future stamp cannot stretch a late joiner's countdown.
    this.#deadline = live ? now + runMs : Math.min(timer.endsAt, now + runMs);
    this.#seenRunning = this.#deadline > now;
  }

  view(now) {
    if (!this.#timer) return IDLE_VIEW;
    const remainingMs = this.#deadline - now;
    if (remainingMs > 0) {
      const label = countdownLabel(remainingMs);
      return { phase: WRITING_TIMER_PHASE.RUNNING, remainingMs, label, urgent: remainingMs < TIMER_URGENT_MS };
    }
    return this.#seenRunning && -remainingMs < TIMES_UP_SHOW_MS ? { phase: WRITING_TIMER_PHASE.TIMES_UP } : IDLE_VIEW;
  }

  /** True once per timer, at its end, when this page saw it running and is not waking long after the end. */
  takeExpiry(now) {
    const timer = this.#timer;
    if (!timer || !this.#seenRunning || now < this.#deadline || this.#lastExpiredId === timer.id) return false;
    this.#lastExpiredId = timer.id;
    return now - this.#deadline < TIMES_UP_SHOW_MS;
  }

  /** The value for "+1" at `now`: this page's time left plus a minute, on this page's clock; null when it cannot. */
  extended(now) {
    if (!this.#timer || this.#deadline <= now) return null;
    return writingTimer(this.#timer.id, now, extendedDeadline(this.#deadline, now, WRITING_TIMER_EXTEND_MINUTES));
  }
}

/** Milliseconds until what `view` shows next changes (the label's second, or Time's up ending); null when idle. */
export function writingTimerTickMs(view) {
  if (view.phase === WRITING_TIMER_PHASE.RUNNING) return view.remainingMs % SECOND_MS || SECOND_MS;
  return view.phase === WRITING_TIMER_PHASE.TIMES_UP ? SECOND_MS : null;
}
