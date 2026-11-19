// Countdown rules shared by the zone vote timers and the card-writing timer: the minutes an admin may choose, the
// mm:ss label everyone sees, and how "+N minutes" moves a deadline.

export const MINUTE_MS = 60_000;
export const TIMER_MIN_MINUTES = 1;
export const TIMER_MAX_MINUTES = 120;
// The last stretch, shown as urgent.
export const TIMER_URGENT_MS = 30_000;
const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const CLOCK_DIGITS = 2;
const CLOCK_PAD = '0';

/** `value` as a number inside [minimum, maximum]; anything non-numeric becomes the minimum. */
export function clampToRange(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || minimum));
}

export const clampTimerMinutes = (value) => clampToRange(value, TIMER_MIN_MINUTES, TIMER_MAX_MINUTES);

/** mm:ss for a remaining time. A started second counts as a whole one, so 00:00 shows only at the end. */
export function countdownLabel(remainingMs) {
  const seconds = Math.ceil(remainingMs / SECOND_MS);
  const minutes = Math.floor(seconds / MINUTE_SECONDS);
  const remainder = seconds % MINUTE_SECONDS;
  return `${String(minutes).padStart(CLOCK_DIGITS, CLOCK_PAD)}:${String(remainder).padStart(CLOCK_DIGITS, CLOCK_PAD)}`;
}

/** The deadline `minutes` later: from the current deadline while it is still ahead, otherwise from `now`. */
export const extendedDeadline = (endsAt, now, minutes) => (endsAt && endsAt > now ? endsAt : now) + minutes * MINUTE_MS;
